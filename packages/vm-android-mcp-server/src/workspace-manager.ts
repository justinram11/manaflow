import { spawn } from "node:child_process";
import { exec } from "./exec";
import {
  getStatePath,
  loadPersistedAllocations,
  savePersistedAllocations,
} from "./persistence";

/** The AVD baked into the cmux-sandbox-android image. */
const AVD_NAME = process.env.CMUX_ANDROID_AVD_NAME ?? "cmux-android";
/** Xvfb display the emulator renders into (mirrors the VNC bridge on :2). */
const EMULATOR_DISPLAY = process.env.CMUX_ANDROID_DISPLAY ?? ":2";
/** adb serial for the single emulator instance (console port 5554). */
const EMULATOR_SERIAL = "emulator-5554";

export interface AndroidAllocationInfo {
  allocationId: string;
  buildDir: string;
  avdName: string;
  /** adb serial of the running emulator, once booted. */
  deviceSerial?: string;
  emulatorBooted: boolean;
  accessToken?: string;
  accessTokenCreatedAt?: number;
  /** Workspace container's tailscale hostname. The emulator reaches the
   *  workspace's api2 server at this host (proxied via socat → 10.0.2.2). */
  workspaceHost?: string;
  /** rsync endpoint exposed by the workspace's rsyncd. */
  rsyncEndpoint?: string;
  /** rsync secret matching the workspace's rsyncd.secrets. */
  rsyncSecret?: string;
}

const allocations = new Map<string, AndroidAllocationInfo>();

// Hydrate from disk so allocations survive systemd/launchd restarts of the
// MCP server. Without this, every restart drops state and tool calls fail
// with "Allocation not found" until the cmux task run is restarted.
for (const info of loadPersistedAllocations<AndroidAllocationInfo>()) {
  if (info?.allocationId) {
    allocations.set(info.allocationId, info);
  }
}
if (allocations.size > 0) {
  console.log(
    `[android-workspace] Restored ${allocations.size} allocation(s) from ${getStatePath()}`,
  );
}

function persistAllocations(): void {
  savePersistedAllocations(Array.from(allocations.values()));
}

/** Whether the emulator process has been started in this container. */
let emulatorProcessStarted = false;

/**
 * Run an adb command against the allocation's emulator.
 */
export function adb(args: string, opts?: { timeout?: number; maxBuffer?: number }): string {
  return exec(`adb -s ${EMULATOR_SERIAL} ${args}`, opts);
}

/**
 * Ensure the X display the emulator renders into exists. Xtigervnc is the
 * X server itself (no separate Xvfb) — it provides display :2 AND serves it
 * over VNC on port 5902. websockify bridges 5902 → 39384 for noVNC.
 */
function ensureDisplay(): void {
  try {
    exec(
      "systemctl start cmux-android-tigervnc.service cmux-android-vnc-proxy.service",
      { timeout: 30_000 },
    );
  } catch (error) {
    console.error("[android-workspace] Failed to start Android display services:", error);
  }
}

/**
 * Start the Android emulator process, rendering into the Xvfb :2 display so
 * the screen is streamable over VNC. Idempotent — only spawns once per
 * container.
 */
export function startEmulator(): void {
  if (emulatorProcessStarted) {
    return;
  }
  emulatorProcessStarted = true;

  ensureDisplay();

  console.log(
    `[android-workspace] Starting emulator for AVD ${AVD_NAME} on display ${EMULATOR_DISPLAY}`,
  );
  const child = spawn(
    "emulator",
    [
      "-avd",
      AVD_NAME,
      "-no-snapshot-save",
      "-no-boot-anim",
      "-no-audio",
      "-no-metrics",
      "-gpu",
      "swiftshader_indirect",
      "-accel",
      "on",
      "-ports",
      "5554,5555",
    ],
    {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, DISPLAY: EMULATOR_DISPLAY },
    },
  );
  child.unref();
}

/**
 * Wait for the emulator to finish booting (sys.boot_completed == 1).
 */
export function waitForBoot(timeoutMs = 240_000): boolean {
  const start = Date.now();
  // First wait for the device to appear in adb.
  try {
    exec(`adb wait-for-device`, { timeout: timeoutMs });
  } catch (error) {
    console.error("[android-workspace] adb wait-for-device failed:", error);
    return false;
  }

  while (Date.now() - start < timeoutMs) {
    try {
      const booted = adb("shell getprop sys.boot_completed", { timeout: 10_000 }).trim();
      if (booted === "1") {
        console.log("[android-workspace] Emulator boot completed");
        return true;
      }
    } catch (error) {
      console.error("[android-workspace] boot check failed (retrying):", error);
    }
    exec("sleep 3");
  }
  console.error(`[android-workspace] Emulator did not boot within ${timeoutMs}ms`);
  return false;
}

export function setupAllocation(params: {
  allocationId: string;
  buildDir: string;
  avdName?: string;
  workspaceHost?: string;
  rsyncEndpoint?: string;
  rsyncSecret?: string;
}): AndroidAllocationInfo {
  const { allocationId, buildDir } = params;

  const existing = allocations.get(allocationId);
  if (existing) {
    let mutated = false;
    if (existing.buildDir !== buildDir) {
      existing.buildDir = buildDir;
      mutated = true;
    }
    if (params.workspaceHost && params.workspaceHost !== existing.workspaceHost) {
      existing.workspaceHost = params.workspaceHost;
      mutated = true;
    }
    if (params.rsyncEndpoint && params.rsyncEndpoint !== existing.rsyncEndpoint) {
      existing.rsyncEndpoint = params.rsyncEndpoint;
      mutated = true;
    }
    if (params.rsyncSecret && params.rsyncSecret !== existing.rsyncSecret) {
      existing.rsyncSecret = params.rsyncSecret;
      mutated = true;
    }
    if (mutated) persistAllocations();
    return existing;
  }

  try {
    exec(`mkdir -p "${buildDir}"`);
  } catch (error) {
    console.error("[android-workspace] Failed to create build dir:", error);
  }

  // Kick off the emulator boot in the background so it's ready by the time
  // tools are first invoked.
  startEmulator();

  const info: AndroidAllocationInfo = {
    allocationId,
    buildDir,
    avdName: params.avdName ?? AVD_NAME,
    deviceSerial: EMULATOR_SERIAL,
    emulatorBooted: false,
    workspaceHost: params.workspaceHost,
    rsyncEndpoint: params.rsyncEndpoint,
    rsyncSecret: params.rsyncSecret,
  };

  allocations.set(allocationId, info);
  persistAllocations();
  return info;
}

export function cleanupAllocation(params: {
  allocationId: string;
  buildDir?: string | null;
}): void {
  const { allocationId } = params;
  const info = allocations.get(allocationId);

  if (info?.buildDir) {
    try {
      exec(`rm -rf "${info.buildDir}"`);
    } catch (error) {
      console.error("[android-workspace] Failed to clean up build dir:", error);
    }
  }

  // The container itself is destroyed per-allocation by the host provider, so
  // we do not need to shut the emulator down here.
  allocations.delete(allocationId);
  persistAllocations();
}

export function getAllocation(allocationId: string): AndroidAllocationInfo | undefined {
  return allocations.get(allocationId);
}

export function getAllAllocations(): AndroidAllocationInfo[] {
  return Array.from(allocations.values());
}

/**
 * Ensure the emulator is booted for an allocation. Boots on first call.
 */
export function ensureBooted(allocationId: string): boolean {
  const info = allocations.get(allocationId);
  if (!info) {
    return false;
  }
  if (info.emulatorBooted) {
    return true;
  }
  startEmulator();
  const booted = waitForBoot();
  if (info.emulatorBooted !== booted) {
    info.emulatorBooted = booted;
    persistAllocations();
  }
  return booted;
}

export function setAllocationAccessToken(allocationId: string, accessToken: string): void {
  const info = allocations.get(allocationId);
  if (!info) {
    console.warn(
      `[android-workspace] setAllocationAccessToken: no allocation found for ${allocationId}`,
    );
    return;
  }
  info.accessToken = accessToken;
  info.accessTokenCreatedAt = Date.now();
  persistAllocations();
}
