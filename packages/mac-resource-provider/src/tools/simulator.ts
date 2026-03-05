import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition, ToolHandler } from "./index";
import { getAllocation, bootSimulator } from "../workspace-manager";

const iosSimulatorBoot: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");

  // If no simulator exists yet, create one
  if (!alloc.simulatorUdid) {
    const deviceType = (params.deviceType as string) || alloc.simulatorDeviceType || "iPhone 16 Pro";
    const runtime = (params.runtime as string) || alloc.simulatorRuntime || "com.apple.CoreSimulator.SimRuntime.iOS-18-6";
    const simName = `cmux-${allocationId.slice(0, 8)}`;

    try {
      const udid = execSync(
        `xcrun simctl create "${simName}" "${deviceType}" "${runtime}"`,
        { encoding: "utf-8" },
      ).trim();
      alloc.simulatorUdid = udid;
    } catch (error) {
      return { error: `Failed to create simulator: ${error}` };
    }
  }

  bootSimulator(allocationId);
  return { udid: alloc.simulatorUdid, status: "booted" };
};

const iosSimulatorShutdown: ToolHandler = async (_params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  try {
    execSync(`xcrun simctl shutdown "${alloc.simulatorUdid}"`, { encoding: "utf-8" });
    return { success: true };
  } catch (error) {
    return { error: String(error) };
  }
};

const iosSimulatorListDevices: ToolHandler = async () => {
  try {
    const output = execSync("xcrun simctl list devices available --json", { encoding: "utf-8" });
    const data = JSON.parse(output);
    return { devices: data.devices };
  } catch (error) {
    return { error: String(error) };
  }
};

const iosSimulatorInstall: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  let appPath = params.appPath as string | undefined;

  // Auto-detect from DerivedData if not provided
  if (!appPath) {
    const derivedData = join(alloc.buildDir, "DerivedData");
    if (existsSync(derivedData)) {
      try {
        appPath = execSync(
          `find "${derivedData}" -name "*.app" -path "*/Build/Products/*" | head -1`,
          { encoding: "utf-8" },
        ).trim();
      } catch {
        // Ignore
      }
    }
    if (!appPath) return { error: "No .app found. Build first or provide appPath." };
  }

  try {
    execSync(`xcrun simctl install "${alloc.simulatorUdid}" "${appPath}"`, { encoding: "utf-8" });
    return { success: true, appPath };
  } catch (error) {
    return { error: String(error) };
  }
};

const iosSimulatorLaunch: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  const bundleId = params.bundleId as string;
  if (!bundleId) return { error: "bundleId is required" };

  const args = params.args as string[] | undefined;
  const argsStr = args ? args.join(" ") : "";

  try {
    const output = execSync(
      `xcrun simctl launch "${alloc.simulatorUdid}" "${bundleId}" ${argsStr}`,
      { encoding: "utf-8" },
    );
    return { success: true, output: output.trim() };
  } catch (error) {
    return { error: String(error) };
  }
};

const iosSimulatorTerminate: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  try {
    execSync(`xcrun simctl terminate "${alloc.simulatorUdid}" "${params.bundleId}"`, { encoding: "utf-8" });
    return { success: true };
  } catch (error) {
    return { error: String(error) };
  }
};

const iosSimulatorErase: ToolHandler = async (_params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  try {
    execSync(`xcrun simctl erase "${alloc.simulatorUdid}"`, { encoding: "utf-8" });
    return { success: true };
  } catch (error) {
    return { error: String(error) };
  }
};

const iosSimulatorSetAppearance: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  const appearance = params.appearance as "light" | "dark";
  try {
    execSync(`xcrun simctl ui "${alloc.simulatorUdid}" appearance ${appearance}`, { encoding: "utf-8" });
    return { success: true };
  } catch (error) {
    return { error: String(error) };
  }
};

export const simulatorTools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: "ios_simulator_boot",
      description: "Boot the workspace's dedicated simulator. Creates one if needed.",
      inputSchema: {
        type: "object",
        properties: {
          deviceType: { type: "string", description: "Device type, e.g. 'iPhone 16 Pro'" },
          runtime: { type: "string", description: "Runtime, e.g. 'iOS-18-6'" },
        },
      },
    },
    handler: iosSimulatorBoot,
  },
  {
    definition: {
      name: "ios_simulator_shutdown",
      description: "Shutdown the workspace's simulator.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: iosSimulatorShutdown,
  },
  {
    definition: {
      name: "ios_simulator_list_devices",
      description: "List available simulator device types and runtimes on this Mac.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: iosSimulatorListDevices,
  },
  {
    definition: {
      name: "ios_simulator_install",
      description: "Install a .app onto the workspace's simulator. Auto-detects from DerivedData if appPath is omitted.",
      inputSchema: {
        type: "object",
        properties: {
          appPath: { type: "string", description: "Path to .app bundle" },
        },
      },
    },
    handler: iosSimulatorInstall,
  },
  {
    definition: {
      name: "ios_simulator_launch",
      description: "Launch an app on the workspace's simulator.",
      inputSchema: {
        type: "object",
        properties: {
          bundleId: { type: "string", description: "App bundle identifier" },
          args: { type: "array", items: { type: "string" }, description: "Launch arguments" },
        },
        required: ["bundleId"],
      },
    },
    handler: iosSimulatorLaunch,
  },
  {
    definition: {
      name: "ios_simulator_terminate",
      description: "Terminate an app on the workspace's simulator.",
      inputSchema: {
        type: "object",
        properties: {
          bundleId: { type: "string", description: "App bundle identifier" },
        },
        required: ["bundleId"],
      },
    },
    handler: iosSimulatorTerminate,
  },
  {
    definition: {
      name: "ios_simulator_erase",
      description: "Erase all data on the workspace's simulator.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: iosSimulatorErase,
  },
  {
    definition: {
      name: "ios_simulator_set_appearance",
      description: "Set the simulator's appearance mode.",
      inputSchema: {
        type: "object",
        properties: {
          appearance: { type: "string", enum: ["light", "dark"], description: "Appearance mode" },
        },
        required: ["appearance"],
      },
    },
    handler: iosSimulatorSetAppearance,
  },
];
