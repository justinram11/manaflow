import { execFile, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { env } from "@/lib/utils/www-env";
import {
  configureAndBoot,
  loadSnapshot,
  waitForSocket,
} from "./firecracker-api";
import {
  allocateTap,
  copyRootfs,
  recreateTap,
  startPortProxy,
} from "./firecracker-network";
import {
  FirecrackerSandboxInstance,
  type FirecrackerPortMapping,
} from "./firecracker-sandbox-instance";

// Ports exposed by the cmux container image (same as Docker provider)
const CONTAINER_PORTS = {
  exec: 39375,
  worker: 39377,
  vscode: 39378,
  proxy: 39379,
  vnc: 39380,
  devtools: 39381,
  pty: 39383,
} as const;

// Port where cmux-sandboxd listens for exec commands
const SANDBOXD_PORT = 46831;

export interface FirecrackerSandboxResult {
  instance: FirecrackerSandboxInstance;
  vmId: string;
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

/**
 * Get Firecracker config paths, using env vars with sensible defaults.
 */
function getFirecrackerPaths() {
  const baseDir =
    env.FIRECRACKER_SNAPSHOT_DIR
      ? path.dirname(env.FIRECRACKER_SNAPSHOT_DIR)
      : path.join(os.homedir(), ".cmux", "firecracker");

  return {
    binary: env.FIRECRACKER_BIN ?? path.join(baseDir, "firecracker"),
    kernel: env.FIRECRACKER_KERNEL ?? path.join(baseDir, "vmlinux"),
    baseRootfs:
      env.FIRECRACKER_BASE_ROOTFS ?? path.join(baseDir, "cmux-base.ext4"),
    snapshotDir:
      env.FIRECRACKER_SNAPSHOT_DIR ?? path.join(baseDir, "snapshots"),
  };
}

// Use git to find the project root reliably regardless of bundler output paths
const PROJECT_ROOT = execSync("git rev-parse --show-toplevel", {
  encoding: "utf-8",
}).trim();
const FC_HELPER_PATH = path.join(PROJECT_ROOT, "scripts/fc-helper.sh");

/**
 * Spawn a Firecracker process via the sudo helper.
 * Returns the PID of the background Firecracker process.
 */
function spawnFirecracker(
  fcBinary: string,
  socketPath: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      "sudo",
      [FC_HELPER_PATH, "spawn", fcBinary, socketPath, "--daemonize"],
      { timeout: 10_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Failed to spawn Firecracker: ${error.message}\nstderr: ${stderr}`,
            ),
          );
          return;
        }
        // The helper prints the PID of the background Firecracker process
        const pid = parseInt(stdout.trim(), 10);
        if (isNaN(pid)) {
          reject(new Error(`Failed to parse Firecracker PID from: ${stdout}`));
          return;
        }
        resolve(pid);
      },
    );
  });
}

/**
 * Kill a Firecracker process by PID via the sudo helper.
 */
async function killFirecracker(pid: number): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "sudo",
        [FC_HELPER_PATH, "kill", String(pid)],
        { timeout: 10_000 },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        },
      );
    });
  } catch (error) {
    console.error(
      `[firecracker-provider] Failed to kill Firecracker PID ${pid}:`,
      error,
    );
  }
}

/**
 * Wait for cmux-sandboxd to be healthy inside the VM.
 */
async function waitForSandboxd(
  guestIp: string,
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(
        `http://${guestIp}:${SANDBOXD_PORT}/healthz`,
        { signal: AbortSignal.timeout(3_000) },
      );
      if (response.ok) {
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `cmux-sandboxd not healthy after ${timeoutMs}ms at ${guestIp}:${SANDBOXD_PORT}`,
  );
}

/**
 * Create a sandbox (OCI container) inside the VM via cmux-sandboxd.
 * Returns the sandbox ID.
 */
async function createSandboxdContainer(guestIp: string): Promise<string> {
  const response = await fetch(
    `http://${guestIp}:${SANDBOXD_PORT}/sandboxes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "workspace" }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Failed to create sandboxd container: ${response.status} ${text}`,
    );
  }
  const result = (await response.json()) as { id: string };
  return result.id;
}

/**
 * Start a Firecracker sandbox, either from a fresh rootfs or from a snapshot.
 */
export async function startFirecrackerSandbox(options: {
  snapshotId?: string;
  ttlSeconds?: number;
  metadata?: Record<string, string>;
}): Promise<FirecrackerSandboxResult> {
  const paths = getFirecrackerPaths();
  const sandboxHost = env.SANDBOX_HOST ?? "localhost";

  // Validate that Firecracker binary and kernel exist
  if (!fs.existsSync(paths.binary)) {
    throw new Error(
      `Firecracker binary not found at ${paths.binary}. Run scripts/setup-firecracker.sh first.`,
    );
  }
  if (!fs.existsSync(paths.kernel)) {
    throw new Error(
      `Kernel not found at ${paths.kernel}. Run scripts/setup-firecracker.sh first.`,
    );
  }

  const vmId = `fc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const vmDir = path.join(paths.snapshotDir, `_running`, vmId);
  fs.mkdirSync(vmDir, { recursive: true });

  const socketPath = path.join(vmDir, "firecracker.sock");

  // Allocate network (may be replaced for snapshot restores)
  let tap = await allocateTap();

  console.log(
    `[firecracker-provider] Starting VM ${vmId}, TAP=${tap.tapName}, guestIp=${tap.guestIp}`,
  );

  let fcPid: number | undefined;

  try {
    if (options.snapshotId) {
      // ── Snapshot restore flow ──
      // Firecracker snapshots bake in the TAP name and rootfs path.
      // We must recreate the EXACT same TAP and place rootfs at the original path.
      const snapshotDir = path.join(paths.snapshotDir, options.snapshotId);
      const snapshotBin = path.join(snapshotDir, "snapshot.bin");
      const memBin = path.join(snapshotDir, "mem.bin");
      const snapshotRootfs = path.join(snapshotDir, "rootfs.ext4");

      if (!fs.existsSync(snapshotBin)) {
        throw new Error(`Snapshot not found: ${options.snapshotId}`);
      }

      // Read snapshot metadata for original paths
      const metadataPath = path.join(snapshotDir, "metadata.json");
      let snapshotMeta: {
        originalRootfsPath?: string;
        tapName?: string;
        guestIp?: string;
        guestMac?: string;
      } = {};
      try {
        snapshotMeta = JSON.parse(
          fs.readFileSync(metadataPath, "utf-8"),
        ) as typeof snapshotMeta;
      } catch {
        // No metadata (old snapshot)
      }

      // Release the generic TAP we just allocated — we need the snapshot's TAP instead
      if (snapshotMeta.tapName && snapshotMeta.guestIp && snapshotMeta.guestMac) {
        await releaseTapSafe(tap);
        tap = await recreateTap(
          snapshotMeta.tapName,
          snapshotMeta.guestIp,
          snapshotMeta.guestMac,
        );
      }

      // Copy rootfs to the path the snapshot expects
      const vmRootfs = snapshotMeta.originalRootfsPath ?? path.join(vmDir, "rootfs.ext4");
      if (snapshotMeta.originalRootfsPath) {
        fs.mkdirSync(path.dirname(snapshotMeta.originalRootfsPath), { recursive: true });
      }
      await copyRootfs(snapshotRootfs, vmRootfs);

      // Spawn Firecracker
      fcPid = await spawnFirecracker(paths.binary, socketPath);

      // Wait for API socket
      await waitForSocket(socketPath);

      // Load snapshot and resume — TAP name and rootfs path match the snapshot
      await loadSnapshot(socketPath, snapshotBin, memBin, true);

      console.log(
        `[firecracker-provider] VM ${vmId} restored from snapshot ${options.snapshotId}`,
      );
    } else {
      // ── Fresh boot flow ──
      if (!fs.existsSync(paths.baseRootfs)) {
        throw new Error(
          `Base rootfs not found at ${paths.baseRootfs}. Run scripts/setup-firecracker.sh first.`,
        );
      }

      // Copy base rootfs for this VM instance
      const vmRootfs = path.join(vmDir, "rootfs.ext4");
      await copyRootfs(paths.baseRootfs, vmRootfs);

      // Spawn Firecracker
      fcPid = await spawnFirecracker(paths.binary, socketPath);

      // Wait for API socket
      await waitForSocket(socketPath);

      // Configure and boot
      const vcpuCount = env.FIRECRACKER_VCPU_COUNT ?? 2;
      const memSizeMib = env.FIRECRACKER_MEM_SIZE_MIB ?? 4096;

      await configureAndBoot(socketPath, {
        bootSource: {
          kernel_image_path: paths.kernel,
          boot_args: [
            "console=ttyS0",
            "reboot=k",
            "panic=1",
            "pci=off",
            `fc_net=${tap.guestIp}/30,${tap.hostIp}`,
            "init=/sbin/init",
          ].join(" "),
        },
        drives: [
          {
            drive_id: "rootfs",
            path_on_host: vmRootfs,
            is_root_device: true,
            is_read_only: false,
          },
        ],
        machineConfig: {
          vcpu_count: vcpuCount,
          mem_size_mib: memSizeMib,
        },
        networkInterfaces: [
          {
            iface_id: "eth0",
            guest_mac: tap.guestMac,
            host_dev_name: tap.tapName,
          },
        ],
      });

      console.log(`[firecracker-provider] VM ${vmId} booted fresh`);
    }

    // Start TCP proxies for each container port (listens on 0.0.0.0)
    const portMappings: FirecrackerPortMapping[] = [];
    const hostPorts: Record<number, string> = {};
    const proxyCleanups: Array<() => void> = [];

    for (const [_name, containerPort] of Object.entries(CONTAINER_PORTS)) {
      const proxy = await startPortProxy(tap.guestIp, containerPort);
      portMappings.push({ hostPort: proxy.hostPort, guestPort: containerPort });
      hostPorts[containerPort] = String(proxy.hostPort);
      proxyCleanups.push(proxy.close);
    }

    // Wait for cmux-sandboxd to be ready
    const healthTimeout = options.snapshotId ? 10_000 : 60_000;
    await waitForSandboxd(tap.guestIp, healthTimeout);

    console.log(
      `[firecracker-provider] VM ${vmId} ready, sandboxd healthy`,
    );

    // Create a sandbox (OCI container) inside the VM via cmux-sandboxd
    const sandboxId = await createSandboxdContainer(tap.guestIp);
    console.log(
      `[firecracker-provider] VM ${vmId} sandbox created: ${sandboxId}`,
    );

    const instance = new FirecrackerSandboxInstance({
      id: vmId,
      fcPid,
      socketPath,
      tap,
      portMappings,
      rootfsPath: path.join(vmDir, "rootfs.ext4"),
      snapshotDir: paths.snapshotDir,
      sandboxdSandboxId: sandboxId,
      proxyCleanups,
    });

    const makeUrl = (port: number) =>
      `http://${sandboxHost}:${hostPorts[port]}`;

    return {
      instance,
      vmId,
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
  } catch (error) {
    // Clean up on failure: kill FC process FIRST so it releases the TAP fd
    console.error(`[firecracker-provider] VM ${vmId} start failed:`, error);
    if (fcPid !== undefined) {
      await killFirecracker(fcPid);
    }
    await releaseTapSafe(tap);
    cleanupVmDir(vmDir, socketPath);
    throw error;
  }
}

// Import releaseTap for the error path
import { releaseTap } from "./firecracker-network";

async function releaseTapSafe(
  tap: Awaited<ReturnType<typeof allocateTap>>,
): Promise<void> {
  try {
    await releaseTap(tap);
  } catch (e) {
    console.error("[firecracker-provider] TAP cleanup failed:", e);
  }
}

function cleanupVmDir(vmDir: string, socketPath: string): void {
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // ignore
  }
  try {
    fs.rmSync(vmDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * List available snapshots.
 */
export function listSnapshots(): string[] {
  const paths = getFirecrackerPaths();
  const snapshotDir = paths.snapshotDir;

  if (!fs.existsSync(snapshotDir)) {
    return [];
  }

  return fs
    .readdirSync(snapshotDir)
    .filter((name) => {
      // Skip the _running directory
      if (name.startsWith("_")) return false;
      const dir = path.join(snapshotDir, name);
      return (
        fs.statSync(dir).isDirectory() &&
        fs.existsSync(path.join(dir, "snapshot.bin"))
      );
    });
}

/**
 * Delete a snapshot.
 */
export function deleteSnapshot(snapshotId: string): void {
  const paths = getFirecrackerPaths();
  const snapshotDir = path.join(paths.snapshotDir, snapshotId);

  if (!fs.existsSync(snapshotDir)) {
    throw new Error(`Snapshot not found: ${snapshotId}`);
  }

  fs.rmSync(snapshotDir, { recursive: true, force: true });
  console.log(`[firecracker-provider] Deleted snapshot ${snapshotId}`);
}
