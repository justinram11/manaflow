import { execSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { captureManager } from "./capture-manager";

interface AllocationInfo {
  allocationId: string;
  buildDir: string;
  simulatorUdid?: string;
  simulatorDeviceType: string;
  simulatorRuntime: string;
  capturePort?: number;
  rsyncEndpoint?: string;
  rsyncSecret?: string;
}

const allocations = new Map<string, AllocationInfo>();

function findExistingSimulatorUdid(simName: string): string | undefined {
  try {
    const output = execSync("xcrun simctl list devices --json", {
      encoding: "utf-8",
    });
    const parsed = JSON.parse(output) as {
      devices?: Record<string, Array<{
        name?: string;
        udid?: string;
        isAvailable?: boolean;
        state?: string;
      }>>;
    };

    const matches = Object.values(parsed.devices ?? {})
      .flat()
      .filter((device) => device.name === simName && device.udid && device.isAvailable !== false);

    const preferred = matches.find((device) => device.state === "Booted") ?? matches[0];
    return preferred?.udid;
  } catch (error) {
    console.error(`Failed to find existing simulator ${simName}:`, error);
    return undefined;
  }
}

export function setupAllocation(params: {
  allocationId: string;
  buildDir: string;
  simulatorDeviceType: string;
  simulatorRuntime: string;
}): AllocationInfo {
  const { allocationId, buildDir, simulatorDeviceType, simulatorRuntime } = params;

  const existing = allocations.get(allocationId);
  if (existing) {
    if (existing.buildDir !== buildDir) {
      existing.buildDir = buildDir;
    }
    return existing;
  }

  // Create build directory
  mkdirSync(buildDir, { recursive: true });
  console.log(`Created build directory: ${buildDir}`);

  // Create dedicated simulator
  let simulatorUdid: string | undefined;
  const simName = `cmux-${allocationId.slice(0, 8)}`;
  try {
    simulatorUdid = findExistingSimulatorUdid(simName);
    if (simulatorUdid) {
      console.log(`Reusing simulator: ${simName} (${simulatorUdid})`);
    } else {
      const output = execSync(
        `xcrun simctl create "${simName}" "${simulatorDeviceType}" "${simulatorRuntime}"`,
        { encoding: "utf-8" },
      ).trim();
      simulatorUdid = output;
      console.log(`Created simulator: ${simName} (${simulatorUdid})`);
    }
  } catch (error) {
    console.error("Failed to create simulator:", error);
  }

  const info: AllocationInfo = {
    allocationId,
    buildDir,
    simulatorUdid,
    simulatorDeviceType,
    simulatorRuntime,
  };
  // Apply any pending rsync info that arrived before allocation was set up
  const pending = pendingRsyncInfo.get(allocationId);
  if (pending) {
    info.rsyncEndpoint = pending.rsyncEndpoint;
    info.rsyncSecret = pending.rsyncSecret;
    pendingRsyncInfo.delete(allocationId);
  }

  allocations.set(allocationId, info);
  return info;
}

export function cleanupAllocation(params: {
  allocationId: string;
  buildDir?: string | null;
  simulatorUdid?: string | null;
}): void {
  const { allocationId, buildDir, simulatorUdid } = params;
  const info = allocations.get(allocationId);

  captureManager.stopCapture(allocationId);

  // Clean up build directory
  const dir = buildDir ?? info?.buildDir;
  if (dir && existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
      console.log(`Removed build directory: ${dir}`);
    } catch (error) {
      console.error(`Failed to remove build directory ${dir}:`, error);
    }
  }

  // Delete simulator
  const udid = simulatorUdid ?? info?.simulatorUdid;
  if (udid) {
    try {
      execSync(`xcrun simctl shutdown "${udid}" 2>/dev/null || true`, { encoding: "utf-8" });
      execSync(`xcrun simctl delete "${udid}"`, { encoding: "utf-8" });
      console.log(`Deleted simulator: ${udid}`);
    } catch (error) {
      console.error(`Failed to delete simulator ${udid}:`, error);
    }
  }

  allocations.delete(allocationId);
}

export function getAllocation(allocationId: string): AllocationInfo | undefined {
  return allocations.get(allocationId);
}

export function getAllAllocations(): AllocationInfo[] {
  return Array.from(allocations.values());
}

/**
 * Boot the simulator for an allocation (if not already booted)
 */
export function bootSimulator(allocationId: string): string | undefined {
  const info = allocations.get(allocationId);
  if (!info?.simulatorUdid) return undefined;

  try {
    execSync(`xcrun simctl boot "${info.simulatorUdid}" 2>/dev/null || true`, { encoding: "utf-8" });
    execSync(`open -a Simulator --args -CurrentDeviceUDID "${info.simulatorUdid}"`, {
      encoding: "utf-8",
    });
    return info.simulatorUdid;
  } catch (error) {
    console.error("Failed to boot simulator:", error);
    return info.simulatorUdid;
  }
}

export function ensureSimulatorCapture(
  allocationId: string,
  localPort: number,
  fps = 30,
): string | undefined {
  const info = allocations.get(allocationId);
  if (!info?.simulatorUdid) return undefined;

  const simulatorUdid = bootSimulator(allocationId);
  if (!simulatorUdid) return undefined;

  info.capturePort = localPort;
  captureManager.startCapture(allocationId, simulatorUdid, localPort, fps);
  return simulatorUdid;
}

/**
 * Store rsync connection info for an allocation (called from connect_direct)
 */
export function setRsyncInfo(allocationId: string, rsyncEndpoint: string, rsyncSecret: string): void {
  const info = allocations.get(allocationId);
  if (!info) {
    console.warn(`[workspace-manager] setRsyncInfo: no allocation found for ${allocationId}, will store when allocation is created`);
    // Store for later — the allocation may not be set up yet
    pendingRsyncInfo.set(allocationId, { rsyncEndpoint, rsyncSecret });
    return;
  }
  info.rsyncEndpoint = rsyncEndpoint;
  info.rsyncSecret = rsyncSecret;
}

const pendingRsyncInfo = new Map<string, { rsyncEndpoint: string; rsyncSecret: string }>();
