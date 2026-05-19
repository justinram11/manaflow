import type { ToolDefinition, ToolHandler } from "./index";
import { getAllocation, ensureBooted, adb } from "../workspace-manager";
import { exec } from "../exec";

const androidBoot: ToolHandler = async (_params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");

  const booted = ensureBooted(allocationId);
  return {
    avdName: alloc.avdName,
    deviceSerial: alloc.deviceSerial,
    status: booted ? "booted" : "boot-timeout",
  };
};

const androidListDevices: ToolHandler = async (_params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");

  try {
    const output = exec("adb devices -l");
    const lines = output
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean);
    const devices = lines.map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial, state };
    });
    return { devices };
  } catch (error) {
    console.error("android_list_devices failed", error);
    return { error: String(error) };
  }
};

export const deviceTools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: "android_boot",
      description:
        "Boot the workspace's Android emulator. Waits for the system to finish booting.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: androidBoot,
  },
  {
    definition: {
      name: "android_list_devices",
      description: "List Android devices/emulators visible to adb in this container.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: androidListDevices,
  },
];

/** Shared helper: ensure the emulator is booted before a tool runs. */
export function requireBooted(allocationId: string): { deviceSerial: string } {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");
  if (!alloc.emulatorBooted) {
    const booted = ensureBooted(allocationId);
    if (!booted) {
      throw new Error("Android emulator failed to boot");
    }
  }
  if (!alloc.deviceSerial) {
    throw new Error("No device serial for allocation");
  }
  return { deviceSerial: alloc.deviceSerial };
}

/** Re-exported so other tool modules can run adb without re-importing. */
export { adb };
