import type { ToolDefinition, ToolHandler } from "./index";
import { requireBooted } from "./device";
import { exec } from "../exec";

const androidLogcat: ToolHandler = async (params, allocationId) => {
  const { deviceSerial } = requireBooted(allocationId);

  const limit = typeof params.limit === "number" ? params.limit : 200;
  const priority = (params.priority as string | undefined) ?? null;
  const tag = params.tag as string | undefined;
  const clear = params.clear === true;

  try {
    if (clear) {
      exec(`adb -s ${deviceSerial} logcat -c`);
    }

    // `-d` dumps the buffer and exits rather than streaming.
    let filterSpec = "";
    if (tag && priority) {
      filterSpec = ` "${tag}:${priority}" "*:S"`;
    } else if (tag) {
      filterSpec = ` "${tag}:V" "*:S"`;
    } else if (priority) {
      filterSpec = ` "*:${priority}"`;
    }

    const output = exec(
      `adb -s ${deviceSerial} logcat -d -v threadtime${filterSpec} | tail -${limit}`,
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
    );
    return { logs: output };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    console.error("android_logcat failed", error);
    return { logs: err.stdout ?? "", error: err.stderr ?? String(error) };
  }
};

export const logTools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: "android_logcat",
      description:
        "Dump logcat output from the emulator. Supports filtering by tag and priority (V/D/I/W/E/F).",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max number of log lines (default: 200)" },
          tag: { type: "string", description: "Filter by log tag" },
          priority: {
            type: "string",
            enum: ["V", "D", "I", "W", "E", "F"],
            description: "Minimum log priority",
          },
          clear: { type: "boolean", description: "Clear the log buffer before dumping" },
        },
      },
    },
    handler: androidLogcat,
  },
];
