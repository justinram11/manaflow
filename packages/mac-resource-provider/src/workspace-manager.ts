import {
  execInVm,
  cloneVm,
  startVm,
  stopVm,
  deleteVm,
  waitForGuest,
  getVmIp,
  startVncProxy,
  stopVncProxy,
  copyFileToVm,
} from "./tart-vm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIMULATOR_INPUT_SWIFT_PATH = resolve(__dirname, "../capture/SimulatorInput.swift");
const VM_SIMULATOR_INPUT_PATH = "/tmp/cmux-SimulatorInput.swift";

export interface AllocationInfo {
  allocationId: string;
  buildDir: string;
  simulatorUdid?: string;
  simulatorDeviceType: string;
  simulatorRuntime: string;
  rsyncEndpoint?: string;
  rsyncSecret?: string;
  accessToken?: string;
  tartVmName: string;
  tartVmIp?: string;
  vncPort?: number;
}

const allocations = new Map<string, AllocationInfo>();

function listAvailableIosRuntimeIdentifiers(vmName: string): string[] {
  try {
    const output = execInVm(vmName, "xcrun simctl list runtimes --json");
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

function listAvailableIphoneDeviceTypes(vmName: string): string[] {
  try {
    const output = execInVm(vmName, "xcrun simctl list devicetypes --json");
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
  vmName: string,
  simulatorDeviceType: string,
  simulatorRuntime: string,
): {
  simulatorDeviceType: string;
  simulatorRuntime: string;
} {
  const availableRuntimes = listAvailableIosRuntimeIdentifiers(vmName);
  const availableDeviceTypes = listAvailableIphoneDeviceTypes(vmName);

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

function findExistingSimulatorUdid(vmName: string, simName: string): string | undefined {
  try {
    const output = execInVm(vmName, "xcrun simctl list devices --json");
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

export async function setupAllocation(params: {
  allocationId: string;
  buildDir: string;
  simulatorDeviceType: string;
  simulatorRuntime: string;
}): Promise<AllocationInfo> {
  const { allocationId, buildDir } = params;

  const existing = allocations.get(allocationId);
  if (existing) {
    if (existing.buildDir !== buildDir) {
      existing.buildDir = buildDir;
    }
    return existing;
  }

  // 1. Clone and start a fresh Tart VM for this allocation
  const vmName = `cmux-${allocationId.slice(0, 12)}`;
  cloneVm(vmName);
  startVm(vmName);
  waitForGuest(vmName);

  // 2. Get VM IP and start VNC proxy on the host
  const vmIp = getVmIp(vmName);
  let vncPort: number | undefined;
  if (vmIp) {
    vncPort = startVncProxy(vmName, vmIp);
  }

  // 3. Copy SimulatorInput.swift into the VM
  try {
    copyFileToVm(vmName, SIMULATOR_INPUT_SWIFT_PATH, VM_SIMULATOR_INPUT_PATH);
  } catch (error) {
    console.error("[workspace-manager] Failed to copy SimulatorInput.swift:", error);
  }

  // 4. Resolve simulator target against what's available in this VM
  const {
    simulatorDeviceType,
    simulatorRuntime,
  } = resolveSimulatorTarget(vmName, params.simulatorDeviceType, params.simulatorRuntime);

  // 5. Create build directory inside the VM
  execInVm(vmName, `mkdir -p "${buildDir}"`);

  // 6. Create dedicated simulator inside the VM
  let simulatorUdid: string | undefined;
  const simName = `cmux-${allocationId.slice(0, 8)}`;
  try {
    simulatorUdid = findExistingSimulatorUdid(vmName, simName);
    if (simulatorUdid) {
      console.log(`Reusing simulator: ${simName} (${simulatorUdid})`);
    } else {
      const output = execInVm(
        vmName,
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
    tartVmName: vmName,
    tartVmIp: vmIp ?? undefined,
    vncPort,
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

  if (info?.tartVmName) {
    // Stop VNC proxy, then stop and delete the VM
    stopVncProxy(info.tartVmName);
    stopVm(info.tartVmName);
    deleteVm(info.tartVmName);
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
 * Runs Simulator.app inside the Tart VM's GUI.
 */
export function bootSimulator(allocationId: string): string | undefined {
  const info = allocations.get(allocationId);
  if (!info?.simulatorUdid) return undefined;

  try {
    execInVm(info.tartVmName, `xcrun simctl boot "${info.simulatorUdid}" 2>/dev/null || true`);
    // Open Simulator.app inside the VM's GUI so it's visible via VNC
    execInVm(info.tartVmName, `open -a Simulator --args -CurrentDeviceUDID "${info.simulatorUdid}"`);
    return info.simulatorUdid;
  } catch (error) {
    console.error("Failed to boot simulator:", error);
    return info.simulatorUdid;
  }
}

/**
 * Store rsync connection info for an allocation (called from connect_direct)
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
}
