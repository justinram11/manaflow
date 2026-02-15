import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "@/lib/utils/www-env";
import {
  configureAndBoot,
  loadSnapshot,
  waitForSocket,
} from "./firecracker-api";
import {
  allocateEphemeralPort,
  allocateTap,
  addPortForward,
  copyRootfs,
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

const __fc_dirname = path.dirname(fileURLToPath(import.meta.url));
const FC_HELPER_PATH = path.resolve(
  __fc_dirname,
  "../../../../../../scripts/fc-helper.sh",
);

/**
 * Spawn a Firecracker process via the sudo helper.
 * Returns the child process and the PID.
 */
function spawnFirecracker(
  fcBinary: string,
  socketPath: string,
): Promise<ReturnType<typeof import("node:child_process").spawn>> {
  return new Promise((resolve, reject) => {
    const child = execFile(
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
        // The helper prints the PID
        const pid = parseInt(stdout.trim(), 10);
        if (isNaN(pid)) {
          reject(new Error(`Failed to parse Firecracker PID from: ${stdout}`));
          return;
        }
        // Attach a simple ChildProcess-like wrapper since we used execFile
        // The actual process is running in background
        resolve(child);
      },
    );
  });
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
        `http://${guestIp}:${SANDBOXD_PORT}/health`,
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

  // Allocate network
  const tap = await allocateTap();

  console.log(
    `[firecracker-provider] Starting VM ${vmId}, TAP=${tap.tapName}, guestIp=${tap.guestIp}`,
  );

  let firecrackerProcess: ReturnType<typeof import("node:child_process").spawn>;

  try {
    if (options.snapshotId) {
      // ── Snapshot restore flow ──
      const snapshotDir = path.join(paths.snapshotDir, options.snapshotId);
      const snapshotBin = path.join(snapshotDir, "snapshot.bin");
      const memBin = path.join(snapshotDir, "mem.bin");
      const snapshotRootfs = path.join(snapshotDir, "rootfs.ext4");

      if (!fs.existsSync(snapshotBin)) {
        throw new Error(`Snapshot not found: ${options.snapshotId}`);
      }

      // Copy rootfs for this VM instance
      const vmRootfs = path.join(vmDir, "rootfs.ext4");
      await copyRootfs(snapshotRootfs, vmRootfs);

      // Spawn Firecracker
      firecrackerProcess = await spawnFirecracker(paths.binary, socketPath);

      // Wait for API socket
      await waitForSocket(socketPath);

      // Load snapshot
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
      firecrackerProcess = await spawnFirecracker(paths.binary, socketPath);

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

    // Allocate ephemeral host ports and set up port forwarding
    const portMappings: FirecrackerPortMapping[] = [];
    const hostPorts: Record<number, string> = {};

    for (const [_name, containerPort] of Object.entries(CONTAINER_PORTS)) {
      const hostPort = await allocateEphemeralPort();
      await addPortForward(hostPort, tap.guestIp, containerPort);
      portMappings.push({ hostPort, guestPort: containerPort });
      hostPorts[containerPort] = String(hostPort);
    }

    // Wait for cmux-sandboxd to be ready
    const healthTimeout = options.snapshotId ? 10_000 : 60_000;
    await waitForSandboxd(tap.guestIp, healthTimeout);

    console.log(
      `[firecracker-provider] VM ${vmId} ready, sandboxd healthy`,
    );

    const instance = new FirecrackerSandboxInstance({
      id: vmId,
      firecrackerProcess,
      socketPath,
      tap,
      portMappings,
      rootfsPath: path.join(vmDir, "rootfs.ext4"),
      snapshotDir: paths.snapshotDir,
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
    // Clean up on failure
    console.error(`[firecracker-provider] VM ${vmId} start failed:`, error);
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
