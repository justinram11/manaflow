import type { ToolDefinition, ToolHandler } from "./index";
import { getAllocation } from "../workspace-manager";
import { exec } from "../exec";

const iosLogs: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  const limit = (params.limit as number) || 100;
  const predicate = params.predicate as string | undefined;
  const since = params.since as string | undefined;
  const bundleId = params.bundleId as string | undefined;

  const args = ["xcrun", "simctl", "spawn", alloc.simulatorUdid, "log", "show"];

  if (since) args.push("--start", `"${since}"`);
  args.push("--style", "compact");

  const predicateParts: string[] = [];
  if (bundleId) predicateParts.push(`subsystem == \\"${bundleId}\\"`);
  if (predicate) predicateParts.push(predicate);
  if (predicateParts.length > 0) {
    args.push("--predicate", `"${predicateParts.join(" AND ")}"`);
  }

  try {
    const output = exec(
      `${args.join(" ")} | tail -${limit}`,
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
    );
    return { logs: output };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    return { logs: err.stdout ?? "", error: err.stderr };
  }
};

const iosCrashReports: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  const bundleId = params.bundleId as string | undefined;

  const crashDirs = [
    "$HOME/Library/Logs/DiagnosticReports",
    `$HOME/Library/Developer/CoreSimulator/Devices/${alloc.simulatorUdid}/data/Library/Logs/CrashReporter`,
  ];

  try {
    const findCmd = crashDirs
      .map((dir) => `find "${dir}" -maxdepth 1 \\( -name "*.ips" -o -name "*.crash" \\) 2>/dev/null`)
      .join("; ");

    const output = exec(findCmd);
    let files = output.trim().split("\n").filter(Boolean);

    if (bundleId) {
      files = files.filter((f) => f.toLowerCase().includes(bundleId.toLowerCase()));
    }

    const reports = files.slice(-20).map((path) => {
      const name = path.split("/").pop() ?? path;
      return { name, path, date: name };
    });

    return { reports };
  } catch (error) {
    console.error("ios_crash_reports failed:", error);
    return { reports: [] };
  }
};

const iosGetCrashReport: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");

  const path = params.path as string;
  if (!path) return { error: "path is required" };

  // Security: only allow reading from known crash report directories
  if (!path.includes("Library/Logs") && !path.includes("Library/Developer")) {
    return { error: "Invalid path: must be in Library/Logs or Library/Developer" };
  }

  try {
    const content = exec(`cat "${path}"`);
    return { content };
  } catch (error) {
    return { error: String(error) };
  }
};

export const logTools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: "ios_logs",
      description: "View device/app logs from the simulator. Supports filtering by app and predicate.",
      inputSchema: {
        type: "object",
        properties: {
          bundleId: { type: "string", description: "Filter by app bundle ID" },
          since: { type: "string", description: "Show logs since this time (e.g. '2024-01-01 12:00:00')" },
          limit: { type: "number", description: "Max number of log lines (default: 100)" },
          predicate: { type: "string", description: "Log predicate filter expression" },
        },
      },
    },
    handler: iosLogs,
  },
  {
    definition: {
      name: "ios_crash_reports",
      description: "List crash reports from the simulator.",
      inputSchema: {
        type: "object",
        properties: {
          bundleId: { type: "string", description: "Filter by app bundle ID" },
          since: { type: "string", description: "Filter by date" },
        },
      },
    },
    handler: iosCrashReports,
  },
  {
    definition: {
      name: "ios_get_crash_report",
      description: "Read the content of a specific crash report.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to crash report file" },
        },
        required: ["path"],
      },
    },
    handler: iosGetCrashReport,
  },
];
