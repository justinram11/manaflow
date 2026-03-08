import { execSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, createConnection, type Server } from "node:net";
import { readFileSync } from "node:fs";

const BASE_IMAGE = process.env.CMUX_TART_BASE_IMAGE ?? "cmux-ios-dev";

const runningVms = new Map<string, { process: ChildProcess }>();
const vncProxies = new Map<string, { server: Server; port: number }>();
let nextVncPort = 5901;

/**
 * Execute a shell command inside a Tart VM via the guest agent.
 * Uses a login shell so Xcode tools are on PATH.
 */
export function execInVm(
  vmName: string,
  command: string,
  opts?: { timeout?: number; maxBuffer?: number },
): string {
  const escapedCmd = command.replace(/'/g, "'\\''");
  return execSync(
    `tart exec "${vmName}" -- /bin/sh -lc '${escapedCmd}'`,
    {
      encoding: "utf-8",
      timeout: opts?.timeout,
      maxBuffer: opts?.maxBuffer ?? 50 * 1024 * 1024,
    },
  );
}

export function cloneVm(vmName: string, baseImage?: string): void {
  const image = baseImage ?? BASE_IMAGE;
  console.log(`[tart-vm] Cloning ${image} → ${vmName}`);
  execSync(`tart clone "${image}" "${vmName}"`, {
    encoding: "utf-8",
    timeout: 120_000,
  });
}

export function startVm(vmName: string): void {
  console.log(`[tart-vm] Starting VM ${vmName}`);
  const child = spawn("tart", ["run", vmName, "--no-graphics"], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  runningVms.set(vmName, { process: child });
}

export function stopVm(vmName: string): void {
  console.log(`[tart-vm] Stopping VM ${vmName}`);
  try {
    execSync(`tart stop "${vmName}"`, { encoding: "utf-8", timeout: 30_000 });
  } catch (error) {
    console.error(`[tart-vm] Failed to stop VM ${vmName}:`, error);
  }
  const entry = runningVms.get(vmName);
  if (entry) {
    try {
      entry.process.kill();
    } catch {
      // already exited
    }
    runningVms.delete(vmName);
  }
}

export function deleteVm(vmName: string): void {
  console.log(`[tart-vm] Deleting VM ${vmName}`);
  try {
    execSync(`tart delete "${vmName}"`, { encoding: "utf-8", timeout: 30_000 });
  } catch (error) {
    console.error(`[tart-vm] Failed to delete VM ${vmName}:`, error);
  }
}

export function waitForGuest(vmName: string, timeoutMs = 120_000): void {
  const start = Date.now();
  console.log(`[tart-vm] Waiting for guest agent in ${vmName}...`);
  while (Date.now() - start < timeoutMs) {
    try {
      execSync(`tart exec "${vmName}" -- /usr/bin/true`, {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: "pipe",
      });
      console.log(`[tart-vm] Guest agent ready in ${vmName}`);
      return;
    } catch {
      // Not ready yet — wait and retry
      execSync("sleep 3");
    }
  }
  throw new Error(`[tart-vm] Guest agent not ready after ${timeoutMs}ms in ${vmName}`);
}

export function getVmIp(vmName: string): string | null {
  try {
    const output = execSync(`tart ip "${vmName}"`, {
      encoding: "utf-8",
      timeout: 15_000,
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

/**
 * Copy a local text file into the VM.
 */
export function copyFileToVm(vmName: string, localPath: string, remotePath: string): void {
  const content = readFileSync(localPath, "utf-8");
  const escaped = content.replace(/'/g, "'\\''");
  execInVm(vmName, `mkdir -p "$(dirname '${remotePath}')" && printf '%s' '${escaped}' > '${remotePath}'`);
}

/**
 * Check if a file or directory exists inside the VM.
 */
export function fileExistsInVm(vmName: string, remotePath: string): boolean {
  try {
    execInVm(vmName, `test -e "${remotePath}"`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a TCP proxy on the host forwarding to the VM's VNC port (5900).
 * Returns the host port the proxy listens on.
 */
export function startVncProxy(vmName: string, vmIp: string): number {
  const existing = vncProxies.get(vmName);
  if (existing) return existing.port;

  const port = nextVncPort++;
  const server = createServer((client) => {
    const target = createConnection({ host: vmIp, port: 5900 }, () => {
      client.pipe(target);
      target.pipe(client);
    });
    target.on("error", () => client.destroy());
    client.on("error", () => target.destroy());
  });

  server.listen(port, "0.0.0.0");
  vncProxies.set(vmName, { server, port });
  console.log(`[tart-vm] VNC proxy for ${vmName}: 0.0.0.0:${port} → ${vmIp}:5900`);
  return port;
}

export function stopVncProxy(vmName: string): void {
  const entry = vncProxies.get(vmName);
  if (entry) {
    entry.server.close();
    vncProxies.delete(vmName);
  }
}

/**
 * Detect whether `tart` is available on the host.
 */
export function detectTart(): boolean {
  try {
    execSync("tart --version 2>/dev/null", { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
