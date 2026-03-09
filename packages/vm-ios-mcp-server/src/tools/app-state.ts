import type { ToolDefinition, ToolHandler } from "./index";
import { getAllocation } from "../workspace-manager";
import { exec } from "../exec";

const iosPushNotification: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  const bundleId = params.bundleId as string;
  const payload = params.payload as Record<string, unknown>;

  const tmpPath = `/tmp/cmux-push-${Date.now()}.json`;
  const payloadJson = JSON.stringify(payload).replace(/'/g, "'\\''");

  try {
    exec(
      `printf '%s' '${payloadJson}' > "${tmpPath}" && xcrun simctl push "${alloc.simulatorUdid}" "${bundleId}" "${tmpPath}" && rm -f "${tmpPath}"`,
    );
    return { success: true };
  } catch (error) {
    try { exec(`rm -f "${tmpPath}"`); } catch { /* ignore */ }
    return { error: String(error) };
  }
};

const iosSetLocation: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  const lat = params.lat as number;
  const lon = params.lon as number;

  try {
    exec(
      `xcrun simctl location "${alloc.simulatorUdid}" set ${lat},${lon}`,
    );
    return { success: true, lat, lon };
  } catch (error) {
    return { error: String(error) };
  }
};

const iosOpenUrl: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  const url = params.url as string;

  try {
    exec(`xcrun simctl openurl "${alloc.simulatorUdid}" "${url}"`);
    return { success: true };
  } catch (error) {
    return { error: String(error) };
  }
};

const iosSetPermission: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  const bundleId = params.bundleId as string;
  const permission = params.permission as string;
  const value = params.value as "granted" | "denied" | "unset";

  const actionMap: Record<string, string> = {
    granted: "grant",
    denied: "revoke",
    unset: "reset",
  };
  const action = actionMap[value];

  try {
    exec(
      `xcrun simctl privacy "${alloc.simulatorUdid}" ${action} "${permission}" "${bundleId}"`,
    );
    return { success: true };
  } catch (error) {
    return { error: String(error) };
  }
};

const iosGetContainer: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  const bundleId = params.bundleId as string;
  const containerType = (params.containerType as string) || "app";

  try {
    const path = exec(
      `xcrun simctl get_app_container "${alloc.simulatorUdid}" "${bundleId}" "${containerType}"`,
    ).trim();
    return { path };
  } catch (error) {
    return { error: String(error) };
  }
};

const iosStatusBar: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  const args = ["xcrun", "simctl", "status_bar", alloc.simulatorUdid, "override"];
  if (params.time) args.push("--time", params.time as string);
  if (params.batteryLevel !== undefined) args.push("--batteryLevel", String(params.batteryLevel));
  if (params.cellularBars !== undefined) args.push("--cellularBars", String(params.cellularBars));
  if (params.wifiBars !== undefined) args.push("--wifiBars", String(params.wifiBars));

  try {
    exec(args.join(" "));
    return { success: true };
  } catch (error) {
    return { error: String(error) };
  }
};

export const appStateTools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: "ios_push_notification",
      description: "Send a push notification to an app on the simulator.",
      inputSchema: {
        type: "object",
        properties: {
          bundleId: { type: "string", description: "App bundle identifier" },
          payload: {
            type: "object",
            description: "APNs JSON payload (e.g. { aps: { alert: 'Hello' } })",
          },
        },
        required: ["bundleId", "payload"],
      },
    },
    handler: iosPushNotification,
  },
  {
    definition: {
      name: "ios_set_location",
      description: "Set GPS coordinates on the simulator.",
      inputSchema: {
        type: "object",
        properties: {
          lat: { type: "number", description: "Latitude" },
          lon: { type: "number", description: "Longitude" },
        },
        required: ["lat", "lon"],
      },
    },
    handler: iosSetLocation,
  },
  {
    definition: {
      name: "ios_open_url",
      description: "Open a URL on the simulator (deep links, universal links).",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to open" },
        },
        required: ["url"],
      },
    },
    handler: iosOpenUrl,
  },
  {
    definition: {
      name: "ios_set_permission",
      description: "Grant, revoke, or reset app permissions on the simulator.",
      inputSchema: {
        type: "object",
        properties: {
          bundleId: { type: "string", description: "App bundle identifier" },
          permission: {
            type: "string",
            description: "Permission type (e.g. photos, camera, microphone, contacts, location)",
          },
          value: {
            type: "string",
            enum: ["granted", "denied", "unset"],
            description: "Permission state",
          },
        },
        required: ["bundleId", "permission", "value"],
      },
    },
    handler: iosSetPermission,
  },
  {
    definition: {
      name: "ios_get_container",
      description: "Get the filesystem path of an app container on the simulator.",
      inputSchema: {
        type: "object",
        properties: {
          bundleId: { type: "string", description: "App bundle identifier" },
          containerType: {
            type: "string",
            enum: ["app", "data", "groups"],
            description: "Container type (default: app)",
          },
        },
        required: ["bundleId"],
      },
    },
    handler: iosGetContainer,
  },
  {
    definition: {
      name: "ios_status_bar",
      description: "Override the simulator status bar for clean screenshots.",
      inputSchema: {
        type: "object",
        properties: {
          time: { type: "string", description: "Time string (e.g. '9:41')" },
          batteryLevel: { type: "number", description: "Battery level (0-100)" },
          cellularBars: { type: "number", description: "Cellular signal bars (0-4)" },
          wifiBars: { type: "number", description: "WiFi signal bars (0-3)" },
        },
      },
    },
    handler: iosStatusBar,
  },
];
