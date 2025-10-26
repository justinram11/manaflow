import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { promisify } from "node:util";

type Logger = {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  debug?: (message: string, ...args: unknown[]) => void;
};

const execFileAsync = promisify(execFile);
export const LOCAL_VSCODE_HOST = "localhost";
export const VSCODE_SERVE_WEB_PORT = 39_384;
export const LOCAL_VSCODE_HOST_WITH_PORT = `${LOCAL_VSCODE_HOST}:${VSCODE_SERVE_WEB_PORT}`;
export const LOCAL_VSCODE_ORIGIN = `http://${LOCAL_VSCODE_HOST_WITH_PORT}`;
const SERVER_READY_TIMEOUT_MS = 15_000;

let resolvedVSCodeExecutable: string | null = null;
let currentServeWebBaseUrl: string | null = null;

export type VSCodeServeWebHandle = {
  process: ChildProcess;
  executable: string;
  port: number;
};

export function getVSCodeServeWebBaseUrl(): string | null {
  return currentServeWebBaseUrl;
}

export async function waitForVSCodeServeWebBaseUrl(
  timeoutMs = 15_000
): Promise<string | null> {
  if (currentServeWebBaseUrl) {
    return currentServeWebBaseUrl;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (currentServeWebBaseUrl) {
      return currentServeWebBaseUrl;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return currentServeWebBaseUrl;
}

export async function ensureVSCodeServeWeb(
  logger: Logger
): Promise<VSCodeServeWebHandle | null> {
  logger.info("Ensuring VS Code serve-web availability...");

  const executable = await getVSCodeExecutable(logger);
  if (!executable) {
    logger.warn(
      "VS Code CLI executable unavailable; serve-web will not be launched."
    );
    return null;
  }

  await killProcessOnPort(VSCODE_SERVE_WEB_PORT, logger);

  let child: ChildProcess | null = null;

  try {
    logger.info(
      `Starting VS Code serve-web using executable ${executable} on port ${VSCODE_SERVE_WEB_PORT}...`
    );

    child = spawn(
      executable,
      [
        "serve-web",
        "--accept-server-license-terms",
        "--without-connection-token",
        "--host",
        "127.0.0.1",
        "--port",
        String(VSCODE_SERVE_WEB_PORT),
      ],
      {
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    attachServeWebProcessLogging(child, logger);

    child!.on("error", (error) => {
      logger.error("VS Code serve-web process error:", error);
    });

    child!.on("exit", (code, signal) => {
      const exitMessage = `VS Code serve-web process exited${
        typeof code === "number" ? ` with code ${code}` : ""
      }${signal ? ` due to signal ${signal}` : ""}.`;
      if (code === 0 && !signal) {
        logger.info(exitMessage);
      } else {
        logger.warn(exitMessage);
      }
      if (currentServeWebBaseUrl) {
        logger.info("Clearing cached VS Code serve-web base URL");
        currentServeWebBaseUrl = null;
      }
    });

    await waitForServeWebPort(logger);

    currentServeWebBaseUrl = LOCAL_VSCODE_ORIGIN;
    const baseUrl = currentServeWebBaseUrl;

    logger.info(
      `VS Code serve-web ready at ${baseUrl} (pid ${child.pid ?? "unknown"}).`
    );

    await warmUpVSCodeServeWeb(logger);

    return {
      process: child!,
      executable,
      port: VSCODE_SERVE_WEB_PORT,
    };
  } catch (error) {
    logger.error("Failed to launch VS Code serve-web:", error);
    if (child && !child.killed && child.exitCode === null) {
      try {
        child.kill();
      } catch (killError) {
        logger.warn(
          "Failed to terminate VS Code serve-web after launch failure:",
          killError
        );
      }
    }
    currentServeWebBaseUrl = null;
    return null;
  }
}

export function stopVSCodeServeWeb(
  handle: VSCodeServeWebHandle | null,
  logger: Logger
): void {
  if (!handle) {
    return;
  }

  const { process: child } = handle;

  currentServeWebBaseUrl = null;

  if (child.killed || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  logger.info("Stopping VS Code serve-web process...");
  try {
    child.kill();
  } catch (error) {
    logger.error("Failed to stop VS Code serve-web process:", error);
  }
}

async function getVSCodeExecutable(logger: Logger) {
  logger.info("Attempting to resolve VS Code CLI executable for serve-web.");
  const executable = await resolveVSCodeExecutable(logger);
  if (!executable) {
    return null;
  }

  try {
    if (process.platform !== "win32") {
      await access(executable, fsConstants.X_OK);
    }
    return executable;
  } catch (error) {
    logger.error(`VS Code CLI at ${executable} is not executable:`, error);
    return null;
  }
}

async function resolveVSCodeExecutable(logger: Logger) {
  if (resolvedVSCodeExecutable) {
    return resolvedVSCodeExecutable;
  }

  const lookups =
    process.platform === "win32"
      ? [
          { command: "where", args: ["code.cmd"] },
          { command: "where", args: ["code.exe"] },
          { command: "where", args: ["code"] },
        ]
      : [{ command: "/usr/bin/env", args: ["which", "code"] }];

  for (const { command, args } of lookups) {
    try {
      const { stdout } = await execFileAsync(command, args);
      const candidate = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);

      if (candidate) {
        resolvedVSCodeExecutable = candidate;
        logger.info(`Resolved VS Code CLI executable: ${candidate}`);
        break;
      }
    } catch (error) {
      logger.debug?.(`VS Code CLI lookup with ${command} failed:`, error);
    }
  }

  if (!resolvedVSCodeExecutable && process.env.SHELL) {
    try {
      const { stdout } = await execFileAsync(process.env.SHELL, [
        "-lc",
        "command -v code",
      ]);
      const candidate = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (candidate) {
        resolvedVSCodeExecutable = candidate;
        logger.info(
          `Resolved VS Code CLI executable via shell lookup: ${candidate}`
        );
      }
    } catch (error) {
      logger.debug?.(
        `VS Code CLI SHELL lookup failed (${process.env.SHELL}):`,
        error
      );
    }
  }

  return resolvedVSCodeExecutable;
}

async function warmUpVSCodeServeWeb(logger: Logger) {
  const warmupDeadline = Date.now() + 10_000;

  while (Date.now() < warmupDeadline) {
    try {
      await performServeWebRequest("GET");
      logger.info("VS Code serve-web warm-up succeeded.");
      return;
    } catch (error) {
      logger.debug?.("VS Code serve-web warm-up attempt failed:", error);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  logger.warn(
    "VS Code serve-web did not respond with HTTP 200 during warm-up window."
  );
}

function attachServeWebProcessLogging(child: ChildProcess, logger: Logger) {
  const debugLog = logger.debug ?? logger.info;

  pipeStreamLines(child.stdout, (line) => {
    debugLog(`[VS Code serve-web stdout] ${line}`);
  });

  pipeStreamLines(child.stderr, (line) => {
    logger.warn(`[VS Code serve-web stderr] ${line}`);
  });
}

function pipeStreamLines(
  stream: NodeJS.ReadableStream | null | undefined,
  onLine: (line: string) => void
) {
  if (!stream) {
    return;
  }

  let buffered = "";

  stream.on("data", (chunk: Buffer | string) => {
    buffered += chunk.toString();

    let newlineIndex = buffered.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffered.slice(0, newlineIndex).replace(/\r$/, "");
      onLine(line);
      buffered = buffered.slice(newlineIndex + 1);
      newlineIndex = buffered.indexOf("\n");
    }
  });

  stream.on("end", () => {
    if (buffered.length > 0) {
      onLine(buffered.replace(/\r$/, ""));
    }
  });
}

async function waitForServeWebPort(logger: Logger) {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      await performServeWebRequest("HEAD");
      return;
    } catch (error) {
      logger.debug?.("VS Code serve-web readiness check failed:", error);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  throw new Error(
    `VS Code serve-web port ${VSCODE_SERVE_WEB_PORT} was not ready within ${SERVER_READY_TIMEOUT_MS} ms`
  );
}

async function performServeWebRequest(method: "GET" | "HEAD"): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: VSCODE_SERVE_WEB_PORT,
        method,
        path: "/",
        headers: {
          host: LOCAL_VSCODE_HOST_WITH_PORT,
        },
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function killProcessOnPort(port: number, logger: Logger): Promise<void> {
  const pids = new Set<number>();

  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"]);
      const lines = stdout.split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        const parts = line.split(/\s+/);
        if (parts.length < 5) continue;
        const localAddress = parts[1] ?? "";
        if (!localAddress.endsWith(`:${port}`)) continue;
        const state = parts[3];
        if (state.toUpperCase() !== "LISTENING") continue;
        const pidStr = parts[parts.length - 1];
        const pid = Number.parseInt(pidStr, 10);
        if (!Number.isFinite(pid)) continue;
        pids.add(pid);
      }
    } catch (error) {
      logger.debug?.(
        `Failed to inspect netstat output for port ${port}:`,
        error
      );
    }

    for (const pid of pids) {
      try {
        await execFileAsync("taskkill", ["/PID", String(pid), "/F"]);
        logger.info(`Terminated process ${pid} using port ${port}`);
      } catch (error) {
        logger.warn(
          `Failed to terminate process ${pid} using port ${port}:`,
          error
        );
      }
    }

    return;
  }

  try {
    const { stdout } = await execFileAsync("lsof", [
      "-nP",
      "-i",
      `:${port}`,
      "-sTCP:LISTEN",
      "-t",
    ]);
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .forEach((line) => {
        const pid = Number.parseInt(line, 10);
        if (Number.isFinite(pid)) {
          pids.add(pid);
        }
      });
  } catch (error) {
    logger.debug?.(`lsof failed while checking port ${port}:`, error);
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      logger.debug?.(
        `SIGTERM failed for process ${pid} on port ${port}:`,
        error
      );
    }
  }

  if (pids.size === 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 200));

  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      try {
        process.kill(pid, "SIGKILL");
        logger.info(`Force killed process ${pid} using port ${port}`);
      } catch (error) {
        logger.warn(
          `Failed to force kill process ${pid} on port ${port}:`,
          error
        );
      }
    } catch {
      // process already exited
    }
  }
}
