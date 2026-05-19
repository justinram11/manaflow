import { spawn } from "node:child_process";

/**
 * Minimal Incus CLI wrapper for the Android resource provider.
 *
 * Unlike apps/compute-provider, this package launches one fresh
 * `cmux-sandbox-android` container per allocation and force-deletes it on
 * release. All operations shell out to the `incus` CLI via spawn (no shell).
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
          scope: string;
        }>;
      }
    >;
  } | null;
}

export function incusCommand(
  args: string[],
  options?: { timeout?: number },
): Promise<IncusExecResult> {
  const timeout = options?.timeout ?? 120_000;
  console.log(`[incus-resource] exec: incus ${args.join(" ")}`);
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const proc = spawn("incus", args, { stdio: ["ignore", "pipe", "pipe"] });

    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGKILL");
        const stderr = Buffer.concat(stderrChunks).toString();
        console.error(
          `[incus-resource] command timed out after ${timeout}ms: incus ${args.join(" ")}`,
          stderr,
        );
        resolve({
          exitCode: 1,
          stdout: Buffer.concat(stdoutChunks).toString(),
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
            `[incus-resource] command failed (exit=${exitCode}): incus ${args.join(" ")}`,
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
          `[incus-resource] spawn error: incus ${args.join(" ")}`,
          err.message,
        );
        resolve({ exitCode: 1, stdout: "", stderr: err.message });
      }
    });
  });
}

/** Detect whether the `incus` CLI is available on this host. */
export async function detectIncus(): Promise<boolean> {
  const result = await incusCommand(["version"], { timeout: 10_000 });
  return result.exitCode === 0;
}

/** Launch a fresh container from the given image. */
export async function incusLaunch(image: string, name: string): Promise<void> {
  const result = await incusCommand(
    [
      "launch",
      image,
      name,
      "-c",
      "security.nesting=true",
      "-c",
      "security.syscalls.intercept.mknod=true",
      "-c",
      "security.syscalls.intercept.setxattr=true",
    ],
    { timeout: 300_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to launch container ${name}: ${result.stderr}`);
  }
}

/** Force-delete a container (running or stopped). */
export async function incusDelete(name: string): Promise<void> {
  const result = await incusCommand(["delete", name, "--force"], { timeout: 60_000 });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to delete container ${name}: ${result.stderr}`);
  }
}

/** Add a unix-char device (used for /dev/kvm and /dev/net/tun passthrough). */
export async function incusAddUnixCharDevice(
  container: string,
  deviceName: string,
  source: string,
  path: string,
): Promise<void> {
  const result = await incusCommand([
    "config",
    "device",
    "add",
    container,
    deviceName,
    "unix-char",
    `source=${source}`,
    `path=${path}`,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to add unix-char device ${deviceName} to ${container}: ${result.stderr}`,
    );
  }
}

/** Run a command inside a running container. */
export async function incusExec(
  container: string,
  command: string[],
  options?: { timeout?: number },
): Promise<IncusExecResult> {
  return incusCommand(["exec", container, "--", ...command], options);
}

/** Get a container's IPv4 address and status. */
export async function incusContainerInfo(
  container: string,
): Promise<{ ip: string; status: string } | null> {
  const result = await incusCommand(["list", container, "--format", "json"]);
  if (result.exitCode !== 0) {
    return null;
  }

  let containers: IncusContainerState[];
  try {
    containers = JSON.parse(result.stdout) as IncusContainerState[];
  } catch (parseError) {
    console.error("[incus-resource] failed to parse incus list output:", parseError);
    return null;
  }

  const entry = containers.find((c) => c.name === container);
  if (!entry) {
    return null;
  }

  const eth0 = entry.state?.network?.["eth0"];
  const ipv4 = eth0?.addresses.find((a) => a.family === "inet");
  return { ip: ipv4?.address ?? "", status: entry.status };
}

/**
 * Configure IPv4 networking inside a freshly launched container.
 *
 * Docker-exported images may lack a DHCP client, so `incus list` never reports
 * an IP. Try dhclient first, then fall back to a static IP derived from the
 * Incus bridge subnet. Mirrors apps/compute-provider's networking bootstrap.
 */
export async function configureContainerNetwork(container: string): Promise<void> {
  const dhcp = await incusExec(container, [
    "bash",
    "-c",
    "command -v dhclient >/dev/null 2>&1 && dhclient eth0 -v 2>&1 && cat /etc/resolv.conf",
  ]);
  if (dhcp.exitCode === 0) {
    console.log(`[incus-resource] Network configured via DHCP in ${container}`);
    return;
  }

  console.log(
    `[incus-resource] DHCP unavailable in ${container}, using static IP fallback`,
  );
  const networkResult = await incusCommand([
    "network",
    "show",
    "incusbr0",
    "--format",
    "json",
  ]);
  if (networkResult.exitCode !== 0) {
    console.error(`[incus-resource] Failed to get bridge config: ${networkResult.stderr}`);
    return;
  }

  let bridgeCidr: string | undefined;
  try {
    const parsed = JSON.parse(networkResult.stdout) as {
      config?: Record<string, string>;
    };
    bridgeCidr = parsed.config?.["ipv4.address"];
  } catch (parseError) {
    console.error("[incus-resource] Failed to parse bridge config:", parseError);
    return;
  }
  if (!bridgeCidr) {
    console.error("[incus-resource] No IPv4 address on incusbr0");
    return;
  }

  const [gatewayIp, prefixLen] = bridgeCidr.split("/");
  if (!gatewayIp || !prefixLen) {
    console.error(`[incus-resource] Unexpected bridge CIDR: ${bridgeCidr}`);
    return;
  }
  const hash = container.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const hostPart = (hash % 253) + 2;
  const subnet = gatewayIp.split(".").slice(0, 3).join(".");
  const containerIp = `${subnet}.${hostPart}`;

  const result = await incusExec(container, [
    "bash",
    "-c",
    [
      `ip addr add ${containerIp}/${prefixLen} dev eth0 2>/dev/null || true`,
      `ip route add default via ${gatewayIp} 2>/dev/null || true`,
      `printf 'nameserver ${gatewayIp}\\n' > /etc/resolv.conf`,
      `echo "Static IP: ${containerIp}"`,
    ].join(" && "),
  ]);
  if (result.exitCode !== 0) {
    console.error(
      `[incus-resource] Static IP fallback failed in ${container}: ${result.stderr}`,
    );
  } else {
    console.log(`[incus-resource] ${result.stdout.trim()} in ${container}`);
  }
}

/** Poll until the container has an IPv4 address. */
export async function waitForContainerIp(
  container: string,
  timeoutMs = 60_000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await incusContainerInfo(container);
    if (info && info.ip) {
      return info.ip;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Container ${container} did not get an IP within ${timeoutMs}ms`);
}
