import { execSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ToolDefinition, ToolHandler } from "./index";
import { getAllocation } from "../workspace-manager";

const iosLogs: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc?.simulatorUdid) return { error: "No simulator assigned" };

  const limit = (params.limit as number) || 100;
  const predicate = params.predicate as string | undefined;
  const since = params.since as string | undefined;
  const bundleId = params.bundleId as string | undefined;

  const args = ["xcrun", "simctl", "spawn", alloc.simulatorUdid, "log", "show"];

  if (since) args.push("--start", since);
  args.push("--style", "compact");

  const predicateParts: string[] = [];
  if (bundleId) predicateParts.push(`subsystem == "${bundleId}"`);
  if (predicate) predicateParts.push(predicate);
  if (predicateParts.length > 0) {
    args.push("--predicate", predicateParts.join(" AND "));
  }

  try {
    const output = execSync(args.join(" ") + ` | tail -${limit}`, {
      encoding: "utf-8",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
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

  // Crash reports location
  const crashDirs = [
    join(homedir(), "Library/Logs/DiagnosticReports"),
    join(homedir(), `Library/Developer/CoreSimulator/Devices/${alloc.simulatorUdid}/data/Library/Logs/CrashReporter`),
  ];

  const reports: Array<{ name: string; path: string; date: string }> = [];

  for (const dir of crashDirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".ips") || f.endsWith(".crash"));
      for (const file of files) {
        if (bundleId && !file.toLowerCase().includes(bundleId.toLowerCase())) continue;
        const path = join(dir, file);
        reports.push({ name: file, path, date: file });
      }
    } catch {
      // Ignore permission errors
    }
  }

  return { reports: reports.slice(-20) }; // Last 20 reports
};

const iosGetCrashReport: ToolHandler = async (params) => {
  const path = params.path as string;
  if (!path) return { error: "path is required" };

  // Security: only allow reading from known crash report directories
  const home = homedir();
  if (!path.startsWith(join(home, "Library/Logs")) && !path.startsWith(join(home, "Library/Developer"))) {
    return { error: "Invalid path: must be in Library/Logs or Library/Developer" };
  }

  try {
    const content = readFileSync(path, "utf-8");
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
