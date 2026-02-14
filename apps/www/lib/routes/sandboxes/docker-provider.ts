import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Docker from "dockerode";
import { env } from "@/lib/utils/www-env";
import { DockerSandboxInstance } from "./docker-sandbox-instance";

// Singleton Docker client
let dockerInstance: Docker | null = null;

function getDocker(): Docker {
  if (!dockerInstance) {
    dockerInstance = new Docker();
  }
  return dockerInstance;
}

// Ports exposed by the cmux container image
const CONTAINER_PORTS = {
  exec: 39375,
  worker: 39377,
  vscode: 39378,
  proxy: 39379,
  vnc: 39380,
  devtools: 39381,
  pty: 39383,
} as const;

type HostConfigWithCgroupns = Docker.ContainerCreateOptions["HostConfig"] & {
  CgroupnsMode?: "host" | "private";
};

export interface DockerSandboxResult {
  instance: DockerSandboxInstance;
  containerId: string;
  containerName: string;
  hostPorts: Record<number, string>;
  vscodeUrl: string;
  workerUrl: string;
  urls: {
    vscode: string;
    worker: string;
    proxy: string;
    vnc: string;
    pty: string;
  };
}

/** Mount host SSH keys + gitconfig into the container for git auth */
function getSshBindMounts(): string[] {
  const mounts: string[] = [];
  const sshDir = path.join(os.homedir(), ".ssh");
  if (fs.existsSync(sshDir)) {
    mounts.push(`${sshDir}:/root/.ssh:ro`);
  }
  const gitconfig = path.join(os.homedir(), ".gitconfig");
  if (fs.existsSync(gitconfig)) {
    mounts.push(`${gitconfig}:/root/.gitconfig:ro`);
  }
  return mounts;
}

// Image pull freshness tracking (same pattern as DockerVSCodeInstance)
const imagePullTimes = new Map<string, number>();
const IMAGE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function isMutableTag(imageName: string): boolean {
  if (imageName.indexOf("@") !== -1) return false;
  const lastSlash = imageName.lastIndexOf("/");
  const lastColon = imageName.lastIndexOf(":");
  if (lastColon === -1) return true;
  if (lastColon < lastSlash) return true;
  return imageName.slice(lastColon + 1) === "latest";
}

async function ensureImage(docker: Docker, imageName: string): Promise<void> {
  const isLatest = isMutableTag(imageName);
  const lastPull = imagePullTimes.get(imageName);
  const now = Date.now();

  let shouldPull = false;
  let existsLocally = false;

  try {
    await docker.getImage(imageName).inspect();
    existsLocally = true;
    if (isLatest && lastPull && now - lastPull > IMAGE_TTL_MS) {
      shouldPull = true;
    }
    if (isLatest && !lastPull) {
      imagePullTimes.set(imageName, now);
    }
  } catch {
    shouldPull = true;
  }

  if (existsLocally && !shouldPull) return;

  console.log(`[docker-provider] Pulling image ${imageName}...`);

  const stream = await docker.pull(imageName);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });

  imagePullTimes.set(imageName, Date.now());
  console.log(`[docker-provider] Pulled image ${imageName}`);
}

export async function startDockerSandbox(options?: {
  ttlSeconds?: number;
  metadata?: Record<string, string>;
}): Promise<DockerSandboxResult> {
  const docker = getDocker();
  const imageName =
    env.SANDBOX_IMAGE ?? "docker.io/manaflow/cmux:latest";
  const sandboxHost = env.SANDBOX_HOST ?? "localhost";

  await ensureImage(docker, imageName);

  const containerName = `cmux-sandbox-${Date.now()}`;
  const ttl = options?.ttlSeconds ?? 3600;

  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  const exposedPorts: Record<string, Record<string, never>> = {};

  for (const port of Object.values(CONTAINER_PORTS)) {
    const key = `${port}/tcp`;
    portBindings[key] = [{ HostPort: "0" }];
    exposedPorts[key] = {};
  }

  const labels: Record<string, string> = {
    "cmux.app": "cmux",
    "cmux.created": String(Date.now()),
    "cmux.ttl": String(ttl),
    ...(options?.metadata ?? {}),
  };

  const hostConfig: HostConfigWithCgroupns = {
    AutoRemove: false,
    Privileged: true,
    CgroupnsMode: "host",
    PortBindings: portBindings,
    Tmpfs: {
      "/run": "rw,mode=755",
      "/run/lock": "rw,mode=755",
    },
    Binds: [
      "/sys/fs/cgroup:/sys/fs/cgroup:rw",
      ...getSshBindMounts(),
    ],
  };

  const container = await docker.createContainer({
    name: containerName,
    Image: imageName,
    Env: ["NODE_ENV=production", "WORKER_PORT=39377"],
    Labels: labels,
    HostConfig: hostConfig,
    ExposedPorts: exposedPorts,
  });

  await container.start();

  const info = await container.inspect();
  const ports = info.NetworkSettings.Ports;

  const hostPorts: Record<number, string> = {};
  for (const [name, port] of Object.entries(CONTAINER_PORTS)) {
    const mapping = ports[`${port}/tcp`]?.[0]?.HostPort;
    if (!mapping) {
      await container.stop().catch(() => {});
      await container.remove().catch(() => {});
      throw new Error(
        `Failed to get host port mapping for ${name} (container port ${port})`,
      );
    }
    hostPorts[port] = mapping;
  }

  const makeUrl = (port: number) => `http://${sandboxHost}:${hostPorts[port]}`;

  const instance = new DockerSandboxInstance(container, container.id);

  return {
    instance,
    containerId: container.id,
    containerName,
    hostPorts,
    vscodeUrl: makeUrl(CONTAINER_PORTS.vscode),
    workerUrl: makeUrl(CONTAINER_PORTS.worker),
    urls: {
      vscode: makeUrl(CONTAINER_PORTS.vscode),
      worker: makeUrl(CONTAINER_PORTS.worker),
      proxy: makeUrl(CONTAINER_PORTS.proxy),
      vnc: makeUrl(CONTAINER_PORTS.vnc),
      pty: makeUrl(CONTAINER_PORTS.pty),
    },
  };
}
