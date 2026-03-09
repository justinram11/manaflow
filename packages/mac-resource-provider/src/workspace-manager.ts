import {
  execInVm,
  startVm,
  waitForGuest,
  getVmIp,
  startVncProxy,
  copyFileToVm,
} from "./tart-vm";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIMULATOR_INPUT_SWIFT_PATH = resolve(__dirname, "../capture/SimulatorInput.swift");
const VM_SIMULATOR_INPUT_PATH = "/tmp/cmux-SimulatorInput.swift";

/**
 * The shared persistent VM name. All allocations share this VM rather than
 * cloning per-allocation, because macOS VMs take too long to boot and the
 * Tart guest agent is unreliable on fresh clones.
 */
const SHARED_VM_NAME = process.env.CMUX_TART_BASE_IMAGE ?? "cmux-ios-dev";
let sharedVmReady = false;

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
  tartVmName: string;
  tartVmIp?: string;
  vncPort?: number;
  /** Host reachable from the Mac (e.g. Linux host's Tailscale IP) */
  workspaceHost?: string;
  /** Map of container port → host port for proxying (e.g. { 3000: 43000 }) */
  workspacePorts?: Record<number, number>;
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

/**
 * Ensure the shared persistent VM is running and the guest agent is ready.
 * Only waits on the first call; subsequent calls return immediately.
 */
function ensureSharedVm(): void {
  if (sharedVmReady) return;

  console.log(`[workspace-manager] Ensuring shared VM ${SHARED_VM_NAME} is ready...`);

  // Check if already running by trying a quick exec
  try {
    execInVm(SHARED_VM_NAME, "/usr/bin/true", { timeout: 10_000 });
    console.log(`[workspace-manager] Shared VM ${SHARED_VM_NAME} is already running`);
    sharedVmReady = true;
    return;
  } catch {
    // Not ready yet — try starting it
  }

  // Start the VM (may already be running but tart handles that)
  try {
    startVm(SHARED_VM_NAME);
  } catch (error) {
    console.error(`[workspace-manager] Failed to start shared VM:`, error);
  }

  // Wait for guest agent with a generous timeout (macOS VMs boot slowly)
  waitForGuest(SHARED_VM_NAME, 300_000);
  sharedVmReady = true;
  console.log(`[workspace-manager] Shared VM ${SHARED_VM_NAME} is ready`);
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

  const vmName = SHARED_VM_NAME;

  // 1. Ensure the shared VM is running
  ensureSharedVm();

  // 2. Get VM IP and start VNC proxy on the host
  const vmIp = getVmIp(vmName);
  let vncPort: number | undefined;
  if (vmIp) {
    vncPort = startVncProxy(vmName, vmIp);
  }

  // 3. Copy SimulatorInput.swift into the VM (idempotent)
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

  // 6. Create dedicated simulator inside the VM (isolated per allocation)
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

  // Apply any pending workspace info
  const pendingWs = pendingWorkspaceInfo.get(allocationId);
  if (pendingWs) {
    info.workspaceHost = pendingWs.workspaceHost;
    info.workspacePorts = pendingWs.workspacePorts;
    pendingWorkspaceInfo.delete(allocationId);
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
    // Clean up the allocation's simulator and build dir inside the shared VM,
    // but do NOT stop the VM itself — it's shared across allocations.
    if (info.simulatorUdid) {
      try {
        execInVm(info.tartVmName, `xcrun simctl shutdown "${info.simulatorUdid}" 2>/dev/null; xcrun simctl delete "${info.simulatorUdid}" 2>/dev/null || true`);
        console.log(`[workspace-manager] Cleaned up simulator ${info.simulatorUdid} for allocation ${allocationId}`);
      } catch (error) {
        console.error(`[workspace-manager] Failed to clean up simulator:`, error);
      }
    }
    if (info.buildDir) {
      try {
        execInVm(info.tartVmName, `rm -rf "${info.buildDir}"`);
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

const pendingWorkspaceInfo = new Map<string, { workspaceHost: string; workspacePorts: Record<number, number> }>();

export function setWorkspaceInfo(allocationId: string, workspaceHost: string, workspacePorts: Record<number, number>): void {
  const info = allocations.get(allocationId);
  if (!info) {
    console.warn(`[workspace-manager] setWorkspaceInfo: no allocation found for ${allocationId}, will store when allocation is created`);
    pendingWorkspaceInfo.set(allocationId, { workspaceHost, workspacePorts });
    return;
  }
  info.workspaceHost = workspaceHost;
  info.workspacePorts = workspacePorts;
}

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
