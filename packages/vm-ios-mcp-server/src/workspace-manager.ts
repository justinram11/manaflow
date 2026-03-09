import { exec } from "./exec";

export interface AllocationInfo {
  allocationId: string;
  buildDir: string;
  simulatorUdid?: string;
  simulatorDeviceType: string;
  simulatorRuntime: string;
  rsyncEndpoint?: string;
  rsyncSecret?: string;
  accessToken?: string;
  accessTokenCreatedAt?: number;
}

const allocations = new Map<string, AllocationInfo>();

function listAvailableIosRuntimeIdentifiers(): string[] {
  try {
    const output = exec("xcrun simctl list runtimes --json");
    const parsed = JSON.parse(output) as {
      runtimes?: Array<{
        identifier?: string;
        isAvailable?: boolean;
      }>;
    };

    return (parsed.runtimes ?? [])
      .filter(
        (runtime) =>
          runtime.identifier?.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-") &&
          runtime.isAvailable !== false,
      )
      .map((runtime) => runtime.identifier)
      .filter((identifier): identifier is string => Boolean(identifier));
  } catch (error) {
    console.error("Failed to list iOS runtimes:", error);
    return [];
  }
}

function listAvailableIphoneDeviceTypes(): string[] {
  try {
    const output = exec("xcrun simctl list devicetypes --json");
    const parsed = JSON.parse(output) as {
      devicetypes?: Array<{
        name?: string;
        productFamily?: string;
      }>;
    };

    return (parsed.devicetypes ?? [])
      .filter(
        (deviceType) =>
          deviceType.productFamily === "iPhone" || deviceType.name?.startsWith("iPhone "),
      )
      .map((deviceType) => deviceType.name)
      .filter((name): name is string => Boolean(name));
  } catch (error) {
    console.error("Failed to list iPhone device types:", error);
    return [];
  }
}

function resolveSimulatorTarget(
  simulatorDeviceType: string,
  simulatorRuntime: string,
): {
  simulatorDeviceType: string;
  simulatorRuntime: string;
} {
  const availableRuntimes = listAvailableIosRuntimeIdentifiers();
  const availableDeviceTypes = listAvailableIphoneDeviceTypes();

  const resolvedRuntime = availableRuntimes.includes(simulatorRuntime)
    ? simulatorRuntime
    : availableRuntimes[0] ?? simulatorRuntime;
  const resolvedDeviceType = availableDeviceTypes.includes(simulatorDeviceType)
    ? simulatorDeviceType
    : availableDeviceTypes[0] ?? simulatorDeviceType;

  if (
    resolvedRuntime !== simulatorRuntime ||
    resolvedDeviceType !== simulatorDeviceType
  ) {
    console.log(
      `[workspace-manager] Requested simulator ${simulatorDeviceType} / ${simulatorRuntime} not fully available, using ${resolvedDeviceType} / ${resolvedRuntime}`,
    );
  }

  return {
    simulatorDeviceType: resolvedDeviceType,
    simulatorRuntime: resolvedRuntime,
  };
}

function findExistingSimulatorUdid(simName: string): string | undefined {
  try {
    const output = exec("xcrun simctl list devices --json");
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
  const { allocationId, buildDir } = params;

  const existing = allocations.get(allocationId);
  if (existing) {
    if (existing.buildDir !== buildDir) {
      existing.buildDir = buildDir;
    }
    return existing;
  }

  // Resolve simulator target against what's available
  const {
    simulatorDeviceType,
    simulatorRuntime,
  } = resolveSimulatorTarget(params.simulatorDeviceType, params.simulatorRuntime);

  // Create build directory
  exec(`mkdir -p "${buildDir}"`);

  // Create dedicated simulator (isolated per allocation)
  let simulatorUdid: string | undefined;
  const simName = `cmux-${allocationId.slice(0, 8)}`;
  try {
    simulatorUdid = findExistingSimulatorUdid(simName);
    if (simulatorUdid) {
      console.log(`Reusing simulator: ${simName} (${simulatorUdid})`);
    } else {
      const output = exec(
        `xcrun simctl create "${simName}" "${simulatorDeviceType}" "${simulatorRuntime}"`,
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
  const { allocationId } = params;
  const info = allocations.get(allocationId);

  if (info) {
    if (info.simulatorUdid) {
      try {
        exec(`xcrun simctl shutdown "${info.simulatorUdid}" 2>/dev/null; xcrun simctl delete "${info.simulatorUdid}" 2>/dev/null || true`);
        console.log(`[workspace-manager] Cleaned up simulator ${info.simulatorUdid} for allocation ${allocationId}`);
      } catch (error) {
        console.error(`[workspace-manager] Failed to clean up simulator:`, error);
      }
    }
    if (info.buildDir) {
      try {
        exec(`rm -rf "${info.buildDir}"`);
      } catch (error) {
        console.error(`[workspace-manager] Failed to clean up build dir:`, error);
      }
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
 * Boot the simulator for an allocation (if not already booted).
 */
export function bootSimulator(allocationId: string): string | undefined {
  const info = allocations.get(allocationId);
  if (!info?.simulatorUdid) return undefined;

  try {
    exec(`xcrun simctl boot "${info.simulatorUdid}" 2>/dev/null || true`);
    exec(`open -a Simulator --args -CurrentDeviceUDID "${info.simulatorUdid}"`);
    return info.simulatorUdid;
  } catch (error) {
    console.error("Failed to boot simulator:", error);
    return info.simulatorUdid;
  }
}

/**
 * Store rsync connection info for an allocation
 */
export function setRsyncInfo(allocationId: string, rsyncEndpoint: string, rsyncSecret: string): void {
  const info = allocations.get(allocationId);
  if (!info) {
    console.warn(`[workspace-manager] setRsyncInfo: no allocation found for ${allocationId}, will store when allocation is created`);
    pendingRsyncInfo.set(allocationId, { rsyncEndpoint, rsyncSecret });
    return;
  }
  info.rsyncEndpoint = rsyncEndpoint;
  info.rsyncSecret = rsyncSecret;
}

const pendingRsyncInfo = new Map<string, { rsyncEndpoint: string; rsyncSecret: string }>();

export function setAllocationAccessToken(allocationId: string, accessToken: string): void {
  const info = allocations.get(allocationId);
  if (!info) {
    console.warn(
      `[workspace-manager] setAllocationAccessToken: no allocation found for ${allocationId}`,
    );
    return;
  }
  info.accessToken = accessToken;
  info.accessTokenCreatedAt = Date.now();
}
