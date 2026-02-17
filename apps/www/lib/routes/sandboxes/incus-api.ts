import { execFile } from "node:child_process";

/**
 * Low-level CLI wrapper for Incus system containers (LXC).
 *
 * All operations are performed by shelling out to the `incus` CLI tool
 * using child_process.execFile for safety (no shell injection).
 */

export interface IncusExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface IncusContainerState {
  name: string;
  status: string;
  state: {
    network?: Record<
      string,
      {
        addresses: Array<{
          family: string;
          address: string;
          netmask: string;
          scope: string;
        }>;
      }
    >;
  } | null;
  snapshots: Array<{
    name: string;
    created_at: string;
    stateful: boolean;
  }> | null;
}

/**
 * Run an incus CLI command and return the result.
 */
function incusCommand(args: string[]): Promise<IncusExecResult> {
  return new Promise((resolve, _reject) => {
    execFile(
      "incus",
      args,
      { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // Still resolve with exit code so callers can handle gracefully
          const code =
            error.code !== undefined && typeof error.code === "number"
              ? error.code
              : 1;
          resolve({ exitCode: code, stdout, stderr });
          return;
        }
        resolve({ exitCode: 0, stdout, stderr });
      },
    );
  });
}

/**
 * Launch a new Incus container with security.nesting enabled for DinD support.
 *
 * Runs:
 *   incus launch <image> <name> \
 *     -c security.nesting=true \
 *     -c security.syscalls.intercept.mknod=true \
 *     -c security.syscalls.intercept.setxattr=true \
 *     [-c key=value ...]
 */
export async function incusLaunch(
  image: string,
  name: string,
  config?: Record<string, string>,
): Promise<void> {
  const args = [
    "launch",
    image,
    name,
    "-c",
    "security.nesting=true",
    "-c",
    "security.syscalls.intercept.mknod=true",
    "-c",
    "security.syscalls.intercept.setxattr=true",
  ];

  if (config) {
    for (const [key, value] of Object.entries(config)) {
      args.push("-c", `${key}=${value}`);
    }
  }

  const result = await incusCommand(args);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to launch Incus container ${name}: ${result.stderr}`,
    );
  }

  console.log(`[incus-api] Launched container ${name} from image ${image}`);
}

/**
 * Execute a command inside a running Incus container.
 */
export async function incusContainerExec(
  container: string,
  command: string[],
): Promise<IncusExecResult> {
  const args = ["exec", container, "--", ...command];
  const result = await incusCommand(args);
  return result;
}

/**
 * Get container info (IP address and status) by parsing `incus list --format json`.
 *
 * The IPv4 address is extracted from state.network.eth0.addresses
 * where family === "inet".
 */
export async function incusContainerInfo(
  container: string,
): Promise<{ ip: string; status: string } | null> {
  const result = await incusCommand(["list", container, "--format", "json"]);
  if (result.exitCode !== 0) {
    console.error(
      `[incus-api] Failed to get container info for ${container}: ${result.stderr}`,
    );
    return null;
  }

  let containers: IncusContainerState[];
  try {
    containers = JSON.parse(result.stdout) as IncusContainerState[];
  } catch (parseError) {
    console.error(
      `[incus-api] Failed to parse incus list output:`,
      parseError,
    );
    return null;
  }

  const entry = containers.find((c) => c.name === container);
  if (!entry) {
    return null;
  }

  const eth0 = entry.state?.network?.["eth0"];
  const ipv4Address = eth0?.addresses.find((a) => a.family === "inet");

  return {
    ip: ipv4Address?.address ?? "",
    status: entry.status,
  };
}

/**
 * Wait for a container to obtain an IPv4 address by polling incus list.
 *
 * Polls every 500ms until the container reports an inet address on eth0,
 * or until the timeout expires.
 */
export async function waitForContainerIp(
  container: string,
  timeoutMs = 60_000,
): Promise<string> {
  const start = Date.now();
  const pollIntervalMs = 500;

  while (Date.now() - start < timeoutMs) {
    const info = await incusContainerInfo(container);
    if (info && info.ip) {
      console.log(
        `[incus-api] Container ${container} got IP: ${info.ip}`,
      );
      return info.ip;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Container ${container} did not get an IP address after ${timeoutMs}ms`,
  );
}

/**
 * Create a snapshot of a container.
 *
 * Runs: incus snapshot create <container> <snapshotName> --stateful
 */
export async function incusSnapshotCreate(
  container: string,
  snapshotName: string,
): Promise<void> {
  const result = await incusCommand([
    "snapshot",
    "create",
    container,
    snapshotName,
    "--stateful",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create snapshot ${snapshotName} for ${container}: ${result.stderr}`,
    );
  }
  console.log(
    `[incus-api] Created snapshot ${container}/${snapshotName}`,
  );
}

/**
 * Restore a container from a snapshot by copying it to a new container name.
 *
 * Runs:
 *   incus copy <source>/<snapshotName> <newContainer>
 *   incus start <newContainer>
 */
export async function incusSnapshotCopy(
  source: string,
  snapshotName: string,
  newContainer: string,
): Promise<void> {
  const copyResult = await incusCommand([
    "copy",
    `${source}/${snapshotName}`,
    newContainer,
  ]);
  if (copyResult.exitCode !== 0) {
    throw new Error(
      `Failed to copy snapshot ${source}/${snapshotName} to ${newContainer}: ${copyResult.stderr}`,
    );
  }

  const startResult = await incusCommand(["start", newContainer]);
  if (startResult.exitCode !== 0) {
    // Attempt cleanup of the copied container
    await incusCommand(["delete", newContainer, "--force"]);
    throw new Error(
      `Failed to start container ${newContainer} after snapshot copy: ${startResult.stderr}`,
    );
  }

  console.log(
    `[incus-api] Restored snapshot ${source}/${snapshotName} as ${newContainer}`,
  );
}

/**
 * Delete a snapshot from a container.
 *
 * Runs: incus snapshot delete <container> <snapshotName>
 */
export async function incusSnapshotDelete(
  container: string,
  snapshotName: string,
): Promise<void> {
  const result = await incusCommand([
    "snapshot",
    "delete",
    container,
    snapshotName,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to delete snapshot ${snapshotName} from ${container}: ${result.stderr}`,
    );
  }
  console.log(
    `[incus-api] Deleted snapshot ${container}/${snapshotName}`,
  );
}

/**
 * Pause (freeze) a running container.
 *
 * Runs: incus pause <container>
 */
export async function incusPause(container: string): Promise<void> {
  const result = await incusCommand(["pause", container]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to pause container ${container}: ${result.stderr}`,
    );
  }
  console.log(`[incus-api] Paused container ${container}`);
}

/**
 * Resume a frozen container.
 *
 * Runs: incus start <container>
 * (Incus uses `start` to resume a frozen/paused container.)
 */
export async function incusResume(container: string): Promise<void> {
  const result = await incusCommand(["start", container]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to resume container ${container}: ${result.stderr}`,
    );
  }
  console.log(`[incus-api] Resumed container ${container}`);
}

/**
 * Stop a running container gracefully.
 *
 * Runs: incus stop <container>
 */
export async function incusStop(container: string): Promise<void> {
  const result = await incusCommand(["stop", container]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to stop container ${container}: ${result.stderr}`,
    );
  }
  console.log(`[incus-api] Stopped container ${container}`);
}

/**
 * Force-delete a container (running or stopped).
 *
 * Runs: incus delete <container> --force
 */
export async function incusDelete(container: string): Promise<void> {
  const result = await incusCommand(["delete", container, "--force"]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to delete container ${container}: ${result.stderr}`,
    );
  }
  console.log(`[incus-api] Deleted container ${container}`);
}

/**
 * List all Incus containers matching a name prefix.
 * Returns parsed container state objects.
 */
export async function incusListContainers(
  namePrefix: string,
): Promise<IncusContainerState[]> {
  const result = await incusCommand(["list", "--format", "json"]);
  if (result.exitCode !== 0) {
    console.error(
      `[incus-api] Failed to list containers: ${result.stderr}`,
    );
    return [];
  }

  let containers: IncusContainerState[];
  try {
    containers = JSON.parse(result.stdout) as IncusContainerState[];
  } catch (parseError) {
    console.error(
      `[incus-api] Failed to parse incus list output:`,
      parseError,
    );
    return [];
  }

  return containers.filter((c) => c.name.startsWith(namePrefix));
}
