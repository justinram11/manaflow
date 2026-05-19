import type { ToolDefinition, ToolHandler } from "./index";
import { requireBooted } from "./device";
import { exec } from "../exec";

/** Named hardware/navigation keys mapped to Android keyevent codes. */
const KEY_EVENTS: Record<string, string> = {
  home: "KEYCODE_HOME",
  back: "KEYCODE_BACK",
  menu: "KEYCODE_MENU",
  power: "KEYCODE_POWER",
  enter: "KEYCODE_ENTER",
  tab: "KEYCODE_TAB",
  delete: "KEYCODE_DEL",
  search: "KEYCODE_SEARCH",
  app_switch: "KEYCODE_APP_SWITCH",
  volume_up: "KEYCODE_VOLUME_UP",
  volume_down: "KEYCODE_VOLUME_DOWN",
  dpad_up: "KEYCODE_DPAD_UP",
  dpad_down: "KEYCODE_DPAD_DOWN",
  dpad_left: "KEYCODE_DPAD_LEFT",
  dpad_right: "KEYCODE_DPAD_RIGHT",
  dpad_center: "KEYCODE_DPAD_CENTER",
};

const androidScreenshot: ToolHandler = async (params, allocationId) => {
  const { deviceSerial } = requireBooted(allocationId);
  const format = (params.format as string) === "jpeg" ? "jpeg" : "png";

  try {
    // `adb exec-out screencap -p` streams raw PNG bytes on stdout.
    const buffer = exec(
      `adb -s ${deviceSerial} exec-out screencap -p | base64 -w0`,
      { timeout: 30_000 },
    ).trim();

    return {
      image: buffer,
      // screencap always emits PNG; jpeg is requested only for parity with iOS.
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
    };
  } catch (error) {
    console.error("android_screenshot failed", error);
    return { error: String(error) };
  }
};

const androidTap: ToolHandler = async (params, allocationId) => {
  const { deviceSerial } = requireBooted(allocationId);
  const x = params.x as number;
  const y = params.y as number;
  if (typeof x !== "number" || typeof y !== "number") {
    return { error: "x and y are required numbers" };
  }

  try {
    exec(`adb -s ${deviceSerial} shell input tap ${x} ${y}`);
    return { success: true, x, y };
  } catch (error) {
    console.error("android_tap failed", error);
    return { error: String(error) };
  }
};

const androidText: ToolHandler = async (params, allocationId) => {
  const { deviceSerial } = requireBooted(allocationId);
  const text = params.text as string;
  if (typeof text !== "string") {
    return { error: "text is required" };
  }

  try {
    // `adb shell input text` requires spaces escaped as %s and is shell-quoted.
    const escaped = text.replace(/(["\s'$`\\])/g, "\\$1");
    exec(`adb -s ${deviceSerial} shell input text "${escaped.replace(/ /g, "%s")}"`);
    return { success: true, text };
  } catch (error) {
    console.error("android_text failed", error);
    return { error: String(error) };
  }
};

const androidKey: ToolHandler = async (params, allocationId) => {
  const { deviceSerial } = requireBooted(allocationId);
  const key = params.key as string;
  if (!key) {
    return { error: "key is required" };
  }

  // Accept a named key, a raw KEYCODE_*, or a numeric keycode.
  const keycode =
    KEY_EVENTS[key] ?? (key.startsWith("KEYCODE_") || /^\d+$/.test(key) ? key : null);
  if (!keycode) {
    return { error: `Unsupported key: ${key}` };
  }

  try {
    exec(`adb -s ${deviceSerial} shell input keyevent ${keycode}`);
    return { success: true, key, keycode };
  } catch (error) {
    console.error("android_key failed", error);
    return { error: String(error) };
  }
};

export const interactionTools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: "android_screenshot",
      description: "Take a screenshot of the emulator. Returns a base64-encoded PNG image.",
      inputSchema: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["png", "jpeg"], description: "Image format" },
        },
      },
    },
    handler: androidScreenshot,
  },
  {
    definition: {
      name: "android_tap",
      description: "Tap at coordinates on the emulator screen.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate" },
          y: { type: "number", description: "Y coordinate" },
        },
        required: ["x", "y"],
      },
    },
    handler: androidTap,
  },
  {
    definition: {
      name: "android_text",
      description: "Type text into the currently focused field on the emulator.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to type" },
        },
        required: ["text"],
      },
    },
    handler: androidText,
  },
  {
    definition: {
      name: "android_key",
      description:
        "Send a key event to the emulator. Accepts named keys (home, back, enter, ...), a KEYCODE_*, or a numeric keycode.",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Named key, KEYCODE_*, or numeric keycode",
          },
        },
        required: ["key"],
      },
    },
    handler: androidKey,
  },
];
