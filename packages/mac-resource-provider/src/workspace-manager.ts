import { execSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";

interface AllocationInfo {
  allocationId: string;
  buildDir: string;
  simulatorUdid?: string;
  simulatorDeviceType: string;
  simulatorRuntime: string;
}

const allocations = new Map<string, AllocationInfo>();

export function setupAllocation(params: {
  allocationId: string;
  buildDir: string;
  simulatorDeviceType: string;
  simulatorRuntime: string;
}): AllocationInfo {
  const { allocationId, buildDir, simulatorDeviceType, simulatorRuntime } = params;

  // Create build directory
  mkdirSync(buildDir, { recursive: true });
  console.log(`Created build directory: ${buildDir}`);

  // Create dedicated simulator
  let simulatorUdid: string | undefined;
  try {
    const simName = `cmux-${allocationId.slice(0, 8)}`;
    const output = execSync(
      `xcrun simctl create "${simName}" "${simulatorDeviceType}" "${simulatorRuntime}"`,
      { encoding: "utf-8" },
    ).trim();
    simulatorUdid = output;
    console.log(`Created simulator: ${simName} (${simulatorUdid})`);
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
    return info.simulatorUdid;
  } catch (error) {
    console.error("Failed to boot simulator:", error);
    return info.simulatorUdid;
  }
}

/**
 * Receive a tarball and extract it to the build directory
 */
export function receiveSyncTarball(allocationId: string, tarData: Buffer): void {
  const info = allocations.get(allocationId);
  if (!info) throw new Error(`No allocation found: ${allocationId}`);

  // Ensure build dir exists
  mkdirSync(info.buildDir, { recursive: true });

  // Write tarball and extract
  const tarPath = `${info.buildDir}/.cmux-sync.tar.gz`;
  writeFileSync(tarPath, tarData);

  execSync(`tar -xzf "${tarPath}" -C "${info.buildDir}"`, { encoding: "utf-8" });
  rmSync(tarPath, { force: true });

  console.log(`Synced code to ${info.buildDir}`);
}
