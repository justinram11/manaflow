import { spawn } from "node:child_process";

/**
 * Low-level CLI wrapper for Incus system containers (LXC).
 *
 * All operations are performed by shelling out to the `incus` CLI tool
 * using child_process.spawn for safety (no shell injection).
 *
 * Moved from apps/www/lib/routes/sandboxes/incus-api.ts
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
function incusCommand(
  args: string[],
  options?: { timeout?: number },
): Promise<IncusExecResult> {
  const timeout = options?.timeout ?? 120_000;
  console.log(`[incus-cli] exec: incus ${args.join(" ")}`);
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const proc = spawn("incus", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGKILL");
        const stdout = Buffer.concat(stdoutChunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();
        console.error(
          `[incus-cli] command timed out after ${timeout}ms: incus ${args.join(" ")}`,
          stderr,
        );
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr || `Command timed out after ${timeout}ms`,
        });
      }
    }, timeout);

    proc.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();
        const exitCode = code ?? 1;
        if (exitCode !== 0) {
          console.error(
            `[incus-cli] command failed (exit=${exitCode}): incus ${args.join(" ")}`,
            stderr,
          );
        }
        resolve({ exitCode, stdout, stderr });
      }
    });

    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        console.error(
          `[incus-cli] spawn error: incus ${args.join(" ")}`,
          err.message,
        );
        resolve({ exitCode: 1, stdout: "", stderr: err.message });
      }
    });
  });
}

/**
 * Launch a new Incus container with security.nesting enabled for DinD support.
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

  // First launch may need to unpack a large image; allow up to 5 minutes
  const result = await incusCommand(args, { timeout: 300_000 });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to launch Incus container ${name}: ${result.stderr}`,
    );
  }

  console.log(`[incus-cli] Launched container ${name} from image ${image}`);
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
 */
export async function incusContainerInfo(
  container: string,
): Promise<{ ip: string; status: string } | null> {
  const result = await incusCommand(["list", container, "--format", "json"]);
  if (result.exitCode !== 0) {
    console.error(
      `[incus-cli] Failed to get container info for ${container}: ${result.stderr}`,
    );
    return null;
  }

  let containers: IncusContainerState[];
  try {
    containers = JSON.parse(result.stdout) as IncusContainerState[];
  } catch (parseError) {
    console.error(
      `[incus-cli] Failed to parse incus list output:`,
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
        `[incus-cli] Container ${container} got IP: ${info.ip}`,
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
 * Uses stateless snapshots (filesystem only) because stateful (CRIU) snapshots
 * fail with security.nesting=true due to nested UTS namespaces from DinD.
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
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to create snapshot ${snapshotName} for ${container}: ${result.stderr}`,
    );
  }
  console.log(
    `[incus-cli] Created snapshot ${container}/${snapshotName}`,
  );
}

/**
 * Restore a container from a snapshot by copying it to a new container name.
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

  // Remove proxy devices inherited from the snapshot — they have stale port
  // bindings that will fail on start. Fresh devices are added by the provider.
  const proxyDeviceNames = [
    "cmux-exec",
    "cmux-worker",
    "cmux-vscode",
    "cmux-proxy",
    "cmux-vnc",
    "cmux-devtools",
    "cmux-pty",
    "cmux-androidVnc",
  ];
  for (const deviceName of proxyDeviceNames) {
    const removeResult = await incusCommand([
      "config",
      "device",
      "remove",
      newContainer,
      deviceName,
    ]);
    if (removeResult.exitCode === 0) {
      console.log(
        `[incus-cli] Removed stale proxy device ${deviceName} from ${newContainer}`,
      );
    }
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
    `[incus-cli] Restored snapshot ${source}/${snapshotName} as ${newContainer}`,
  );
}

/**
 * Delete a snapshot from a container.
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
    `[incus-cli] Deleted snapshot ${container}/${snapshotName}`,
  );
}

/**
 * Pause (freeze) a running container.
 */
export async function incusPause(container: string): Promise<void> {
  const result = await incusCommand(["pause", container]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to pause container ${container}: ${result.stderr}`,
    );
  }
  console.log(`[incus-cli] Paused container ${container}`);
}

/**
 * Resume a frozen container.
 */
export async function incusResume(container: string): Promise<void> {
  const result = await incusCommand(["start", container]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to resume container ${container}: ${result.stderr}`,
    );
  }
  console.log(`[incus-cli] Resumed container ${container}`);
}

/**
 * Stop a running container gracefully.
 */
export async function incusStop(container: string): Promise<void> {
  const result = await incusCommand(["stop", container]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to stop container ${container}: ${result.stderr}`,
    );
  }
  console.log(`[incus-cli] Stopped container ${container}`);
}

/**
 * Force-delete a container (running or stopped).
 */
export async function incusDelete(container: string): Promise<void> {
  const result = await incusCommand(["delete", container, "--force"]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to delete container ${container}: ${result.stderr}`,
    );
  }
  console.log(`[incus-cli] Deleted container ${container}`);
}

/**
 * Add a generic device to a container.
 */
export async function incusAddDevice(
  container: string,
  deviceName: string,
  deviceType: string,
  properties: Record<string, string>,
): Promise<void> {
  const args = [
    "config",
    "device",
    "add",
    container,
    deviceName,
    deviceType,
    ...Object.entries(properties).map(([k, v]) => `${k}=${v}`),
  ];
  const result = await incusCommand(args);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to add ${deviceType} device ${deviceName} to ${container}: ${result.stderr}`,
    );
  }
}

/**
 * Add a proxy device to forward a host port to a container port.
 */
export async function incusAddProxyDevice(
  container: string,
  deviceName: string,
  hostPort: number,
  containerPort: number,
): Promise<void> {
  const result = await incusCommand([
    "config",
    "device",
    "add",
    container,
    deviceName,
    "proxy",
    `listen=tcp:0.0.0.0:${hostPort}`,
    `connect=tcp:127.0.0.1:${containerPort}`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to add proxy device ${deviceName} to ${container}: ${result.stderr}`,
    );
  }
}

/**
 * Get the IPv4 gateway address and prefix length for the default Incus bridge network.
 */
export async function incusGetBridgeNetwork(
  bridgeName = "incusbr0",
): Promise<{ gateway: string; prefix: number }> {
  const result = await incusCommand([
    "network",
    "get",
    bridgeName,
    "ipv4.address",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to get bridge network info for ${bridgeName}: ${result.stderr}`,
    );
  }
  // Output is like "10.61.176.1/24"
  const cidr = result.stdout.trim();
  const [gateway, prefixStr] = cidr.split("/");
  if (!gateway || !prefixStr) {
    throw new Error(
      `Unexpected bridge network format: "${cidr}" (expected CIDR like "10.x.x.1/24")`,
    );
  }
  return { gateway, prefix: parseInt(prefixStr, 10) };
}

/**
 * List all Incus containers matching a name prefix.
 */
export async function incusListContainers(
  namePrefix: string,
): Promise<IncusContainerState[]> {
  const result = await incusCommand(["list", "--format", "json"]);
  if (result.exitCode !== 0) {
    console.error(
      `[incus-cli] Failed to list containers: ${result.stderr}`,
    );
    return [];
  }

  let containers: IncusContainerState[];
  try {
    containers = JSON.parse(result.stdout) as IncusContainerState[];
  } catch (parseError) {
    console.error(
      `[incus-cli] Failed to parse incus list output:`,
      parseError,
    );
    return [];
  }

  return containers.filter((c) => c.name.startsWith(namePrefix));
}
