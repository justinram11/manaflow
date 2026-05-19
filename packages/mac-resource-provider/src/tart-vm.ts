import { execSync, spawn, type ChildProcess } from "node:child_process";

const BASE_IMAGE = process.env.CMUX_TART_BASE_IMAGE ?? "cmux-ios-dev";
const VM_USER = process.env.CMUX_TART_VM_USER ?? "admin";

const runningVms = new Map<string, { process: ChildProcess }>();

/** Cache resolved VM IPs so we don't call `tart ip` on every exec. */
const vmIpCache = new Map<string, string>();

const SSH_OPTS = [
  "-o", "StrictHostKeyChecking=no",
  "-o", "UserKnownHostsFile=/dev/null",
  "-o", "LogLevel=ERROR",
  "-o", "ConnectTimeout=10",
].join(" ");

function resolveVmIp(vmName: string): string {
  const cached = vmIpCache.get(vmName);
  if (cached) return cached;
  const ip = getVmIp(vmName);
  if (!ip) throw new Error(`[tart-vm] Cannot resolve IP for VM ${vmName}`);
  vmIpCache.set(vmName, ip);
  return ip;
}

/**
 * Execute a shell command inside a Tart VM via SSH.
 * Uses a login shell so Xcode tools are on PATH.
 */
export function execInVm(
  vmName: string,
  command: string,
  opts?: { timeout?: number; maxBuffer?: number },
): string {
  const ip = resolveVmIp(vmName);
  const escapedCmd = command.replace(/'/g, "'\\''");
  return execSync(
    `ssh ${SSH_OPTS} ${VM_USER}@${ip} '/bin/sh -lc '\\''${escapedCmd}'\\'''`,
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
  try {
    execSync(`tart clone "${image}" "${vmName}"`, {
      encoding: "utf-8",
      timeout: 120_000,
    });
  } catch (error) {
    console.error(`[tart-vm] Clone failed for ${vmName}:`, error);
    throw error;
  }
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
  vmIpCache.delete(vmName);
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
  vmIpCache.delete(vmName);
  try {
    execSync(`tart delete "${vmName}"`, { encoding: "utf-8", timeout: 30_000 });
  } catch (error) {
    console.error(`[tart-vm] Failed to delete VM ${vmName}:`, error);
  }
}

/**
 * Wait for the VM to be reachable via SSH.
 */
export function waitForGuest(vmName: string, timeoutMs = 120_000): void {
  const start = Date.now();
  console.log(`[tart-vm] Waiting for VM ${vmName} to be reachable via SSH...`);

  // First wait for an IP
  let ip: string | null = null;
  while (Date.now() - start < timeoutMs) {
    ip = getVmIp(vmName);
    if (ip) break;
    execSync("sleep 3");
  }
  if (!ip) {
    throw new Error(`[tart-vm] VM ${vmName} did not get an IP after ${timeoutMs}ms`);
  }
  vmIpCache.set(vmName, ip);

  // Then wait for SSH
  while (Date.now() - start < timeoutMs) {
    try {
      execSync(
        `ssh ${SSH_OPTS} -o ConnectTimeout=5 ${VM_USER}@${ip} /usr/bin/true`,
        { encoding: "utf-8", timeout: 15_000, stdio: "pipe" },
      );
      console.log(`[tart-vm] VM ${vmName} is reachable via SSH at ${ip}`);
      return;
    } catch {
      execSync("sleep 3");
    }
  }
  throw new Error(`[tart-vm] SSH not ready after ${timeoutMs}ms in ${vmName}`);
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
 * Copy a local file into the VM via scp.
 */
export function copyFileToVm(vmName: string, localPath: string, remotePath: string): void {
  const ip = resolveVmIp(vmName);
  // Ensure parent directory exists
  execInVm(vmName, `mkdir -p "$(dirname '${remotePath}')"`);
  execSync(
    `scp ${SSH_OPTS} "${localPath}" ${VM_USER}@${ip}:"${remotePath}"`,
    { encoding: "utf-8", timeout: 30_000 },
  );
}

/**
 * Copy a file from the VM to the local host via scp.
 */
export function copyFileFromVm(vmName: string, remotePath: string, localPath: string): void {
  const ip = resolveVmIp(vmName);
  execSync(
    `scp ${SSH_OPTS} ${VM_USER}@${ip}:"${remotePath}" "${localPath}"`,
    { encoding: "utf-8", timeout: 30_000 },
  );
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
