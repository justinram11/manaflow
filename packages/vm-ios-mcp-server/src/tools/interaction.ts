import type { ToolDefinition, ToolHandler } from "./index";
import { getAllocation } from "../workspace-manager";
import { exec } from "../exec";

const SIMULATOR_INPUT_PATH = "/tmp/cmux-SimulatorInput.swift";

function runSimulatorInput(
  simulatorUdid: string,
  args: string[],
): Record<string, unknown> {
  const argsStr = args.map((a) => `"${a}"`).join(" ");
  const output = exec(
    `swift "${SIMULATOR_INPUT_PATH}" --udid "${simulatorUdid}" ${argsStr}`,
    { timeout: 30_000 },
  );

  return JSON.parse(output) as Record<string, unknown>;
}

const iosScreenshot: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  const format = (params.format as string) || "png";
  const tmpPath = `/tmp/cmux-screenshot-${Date.now()}.${format}`;

  try {
    exec(
      `xcrun simctl io "${alloc.simulatorUdid}" screenshot --type=${format} "${tmpPath}"`,
    );
    // Read file as base64
    const base64 = exec(
      `base64 -i "${tmpPath}" && rm -f "${tmpPath}"`,
    ).trim().replace(/\s/g, "");

    return {
      image: base64,
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
    };
  } catch (error) {
    console.error("ios_screenshot failed", error);
    return { error: String(error) };
  }
};

const iosRecordVideo: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  const duration = (params.duration as number) || 5;
  const tmpPath = `/tmp/cmux-recording-${Date.now()}.mp4`;

  try {
    exec(
      `xcrun simctl io "${alloc.simulatorUdid}" recordVideo --codec=h264 "${tmpPath}" &` +
      ` RECORD_PID=$!; sleep ${duration}; kill -INT $RECORD_PID; wait $RECORD_PID 2>/dev/null || true`,
      { timeout: (duration + 10) * 1000 },
    );

    const base64 = exec(
      `base64 -i "${tmpPath}" && rm -f "${tmpPath}"`,
    ).trim().replace(/\s/g, "");

    return {
      video: base64,
      mimeType: "video/mp4",
      durationSeconds: duration,
    };
  } catch (error) {
    console.error("ios_record_video failed", error);
    return { error: String(error) };
  }
};

const iosTap: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  const x = params.x as number;
  const y = params.y as number;

  try {
    return {
      ...runSimulatorInput(alloc.simulatorUdid, [
        "--action", "tap",
        "--x", String(x),
        "--y", String(y),
      ]),
      x,
      y,
    };
  } catch (error) {
    console.error("ios_tap failed", error);
    return { error: String(error) };
  }
};

const iosSwipe: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  const { fromX, fromY, toX, toY } = params as {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
  };
  const duration = (params.duration as number) || 0.3;

  try {
    return runSimulatorInput(alloc.simulatorUdid, [
      "--action", "swipe",
      "--from-x", String(fromX),
      "--from-y", String(fromY),
      "--to-x", String(toX),
      "--to-y", String(toY),
      "--duration", String(duration),
    ]);
  } catch (error) {
    console.error("ios_swipe failed", error);
    return { error: String(error) };
  }
};

const iosTypeText: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  const text = params.text as string;

  try {
    return {
      ...runSimulatorInput(alloc.simulatorUdid, [
        "--action", "type",
        "--text", text,
      ]),
      method: "paste",
    };
  } catch (error) {
    console.error("ios_type_text failed", error);
    return { error: String(error) };
  }
};

const iosPressButton: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  const button = params.button as string;
  const supportedButtons = new Set(["home", "lock"]);
  if (!supportedButtons.has(button)) {
    return { error: `Unsupported button: ${button}` };
  }

  try {
    return runSimulatorInput(alloc.simulatorUdid, [
      "--action", "button",
      "--button", button,
    ]);
  } catch (error) {
    console.error("ios_press_button failed", error);
    return { error: String(error) };
  }
};

const iosAccessibilityTree: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  try {
    const output = exec(
      `xcrun simctl spawn "${alloc.simulatorUdid}" accessibility_inspector 2>/dev/null || xcrun simctl ui "${alloc.simulatorUdid}" accessibility_tree 2>/dev/null || echo "Accessibility tree inspection not available via simctl. Use ios_screenshot instead."`,
      { timeout: 10000 },
    );
    return { tree: output.trim() };
  } catch (error) {
    console.error("ios_accessibility_tree failed", error);
    return { error: String(error), hint: "Consider using ios_screenshot for visual inspection" };
  }
};

const iosFindElement: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  const query = params.query as string;
  const by = (params.by as string) || "label";

  try {
    const output = exec(
      `xcrun simctl ui "${alloc.simulatorUdid}" find "${by}" "${query}" 2>/dev/null || echo "Element search not available"`,
      { timeout: 10000 },
    );
    return { results: output.trim() };
  } catch (error) {
    console.error("ios_find_element failed", error);
    return { error: String(error) };
  }
};

const iosScreenInfo: ToolHandler = async (_params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  try {
    const output = exec(
      `xcrun simctl list devices --json | python3 -c "import sys,json; d=json.load(sys.stdin); [print(json.dumps(dev)) for devs in d['devices'].values() for dev in devs if dev['udid']=='${alloc.simulatorUdid}']"`,
    );
    return { info: output.trim() };
  } catch (error) {
    console.error("ios_screen_info failed", error);
    return { error: String(error) };
  }
};

export const interactionTools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: "ios_screenshot",
      description: "Take a screenshot of the simulator. Returns base64-encoded image.",
      inputSchema: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["png", "jpeg"], description: "Image format" },
        },
      },
    },
    handler: iosScreenshot,
  },
  {
    definition: {
      name: "ios_record_video",
      description: "Record a video of the simulator for the specified duration.",
      inputSchema: {
        type: "object",
        properties: {
          duration: { type: "number", description: "Recording duration in seconds (default: 5)" },
        },
      },
    },
    handler: iosRecordVideo,
  },
  {
    definition: {
      name: "ios_tap",
      description: "Tap at coordinates on the simulator screen.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate" },
          y: { type: "number", description: "Y coordinate" },
        },
        required: ["x", "y"],
      },
    },
    handler: iosTap,
  },
  {
    definition: {
      name: "ios_swipe",
      description: "Perform a swipe gesture on the simulator.",
      inputSchema: {
        type: "object",
        properties: {
          fromX: { type: "number" },
          fromY: { type: "number" },
          toX: { type: "number" },
          toY: { type: "number" },
          duration: { type: "number", description: "Swipe duration in seconds" },
        },
        required: ["fromX", "fromY", "toX", "toY"],
      },
    },
    handler: iosSwipe,
  },
  {
    definition: {
      name: "ios_type_text",
      description: "Type text into the currently focused field on the simulator.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to type" },
        },
        required: ["text"],
      },
    },
    handler: iosTypeText,
  },
  {
    definition: {
      name: "ios_press_button",
      description: "Press a hardware button on the simulator.",
      inputSchema: {
        type: "object",
        properties: {
          button: { type: "string", enum: ["home", "lock"] },
        },
        required: ["button"],
      },
    },
    handler: iosPressButton,
  },
  {
    definition: {
      name: "ios_accessibility_tree",
      description: "Dump the accessibility hierarchy of the simulator. Returns structured data about UI elements.",
      inputSchema: {
        type: "object",
        properties: {
          bundleId: { type: "string", description: "Optional app bundle ID to scope the tree" },
        },
      },
    },
    handler: iosAccessibilityTree,
  },
  {
    definition: {
      name: "ios_find_element",
      description: "Find UI elements matching a query in the accessibility tree.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          by: { type: "string", enum: ["label", "identifier", "type", "value"], description: "Search by field" },
        },
        required: ["query"],
      },
    },
    handler: iosFindElement,
  },
  {
    definition: {
      name: "ios_screen_info",
      description: "Get screen dimensions, scale factor, and orientation of the simulator.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: iosScreenInfo,
  },
];
