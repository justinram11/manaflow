import { upsertRepo } from "@cmux/db/mutations/repos";
import { exec } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { GitDiffManager } from "./gitDiff";

import { setupSocketHandlers } from "./socket-handlers";
import { createSocketIOTransport } from "./transports/socketio-transport";
import { setupProviderWS, sendJsonRpcRequest, sendSetupAllocation, sendCleanupAllocation } from "./provider-ws";
import { getDb, getUserId } from "./utils/dbClient";
import { dockerLogger, serverLogger } from "./utils/fileLogger";
import { DockerVSCodeInstance } from "./vscode/DockerVSCodeInstance";
import { VSCodeInstance } from "./vscode/VSCodeInstance";
import {
  ensureVSCodeServeWeb,
  getVSCodeServeWebBaseUrl,
  stopVSCodeServeWeb,
  type VSCodeServeWebHandle,
} from "./vscode/serveWeb";

const execAsync = promisify(exec);

export type GitRepoInfo = {
  path: string;
  isGitRepo: boolean;
  remoteName?: string;
  remoteUrl?: string;
  currentBranch?: string;
  defaultBranch?: string;
};

export async function startServer({
  port,
  defaultRepo,
}: {
  port: number;
  defaultRepo?: GitRepoInfo | null;
}) {
  // Check system limits and warn if too low
  try {
    const { stdout } = await execAsync("ulimit -n");
    const limit = parseInt(stdout.trim(), 10);
    if (limit < 8192) {
      serverLogger.warn(
        `System file descriptor limit is low: ${limit}. Consider increasing it with 'ulimit -n 8192' to avoid file watcher issues.`
      );
    }
  } catch (error) {
    serverLogger.warn("Could not check system file descriptor limit:", error);
  }

  // Git diff manager instance
  const gitDiffManager = new GitDiffManager();

  // Create HTTP server for socket connections and internal API
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // Internal API for provider communication (from www app)
    if (url.pathname.startsWith("/internal/provider/")) {
      try {
        await handleInternalProviderRequest(url, req, res);
      } catch (error) {
        console.error("Internal provider request error:", error);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    res.statusCode = 404;
    res.end("Not found");
  });

  // Set up provider WebSocket handler.
  // Must be called before Socket.IO attaches its own upgrade listener.
  // setupProviderWS uses prependListener + removeAllListeners trick to prevent
  // Socket.IO from interfering with /provider-ws connections.
  setupProviderWS(httpServer);

  // Create Socket.IO transport
  const rt = createSocketIOTransport(httpServer);

  // Set up all socket handlers
  setupSocketHandlers(rt, gitDiffManager, defaultRepo);

  let vscodeServeHandle: VSCodeServeWebHandle | null = null;

  const server = httpServer.listen(port, async () => {
    serverLogger.info(`Terminal server listening on port ${port}`);

    // Store default repo info if provided
    if (defaultRepo?.remoteName) {
      try {
        serverLogger.info(
          `Storing default repository: ${defaultRepo.remoteName}`
        );
        const db = getDb();
        const userId = getUserId();
        upsertRepo(db, {
          teamSlugOrId: "default",
          userId,
          fullName: defaultRepo.remoteName,
          org: defaultRepo.remoteName.split("/")[0] || "",
          name: defaultRepo.remoteName.split("/")[1] || "",
          gitRemote: defaultRepo.remoteUrl || "",
          provider: "github", // Default to github, could be enhanced to detect provider
        });

        // Also emit to all connected clients
        const defaultRepoData = {
          repoFullName: defaultRepo.remoteName,
          branch: defaultRepo.currentBranch || defaultRepo.defaultBranch,
          localPath: defaultRepo.path,
        };
        serverLogger.info(`Emitting default-repo event:`, defaultRepoData);
        rt.emit("default-repo", defaultRepoData);

        serverLogger.info(
          `Successfully set default repository: ${defaultRepo.remoteName}`
        );
      } catch (error) {
        serverLogger.error("Error storing default repo:", error);
      }
    } else if (defaultRepo) {
      serverLogger.warn(
        `Default repo provided but no remote name found:`,
        defaultRepo
      );
    }

    vscodeServeHandle = await ensureVSCodeServeWeb(serverLogger);
    if (vscodeServeHandle) {
      vscodeServeHandle.process.on("exit", () => {
        vscodeServeHandle = null;
      });
      const baseUrl = getVSCodeServeWebBaseUrl();
      if (baseUrl) {
        serverLogger.info(`VS Code serve-web proxy available at ${baseUrl}`);
      }
    }

    // Startup refresh moved to first authenticated socket connection
  });

  let isCleaningUp = false;
  let isCleanedUp = false;

  async function cleanup() {
    if (isCleaningUp || isCleanedUp) {
      serverLogger.info(
        "Cleanup already in progress or completed, skipping..."
      );
      return;
    }

    serverLogger.info("Closing HTTP server...");
    httpServer.close(() => {
      console.log("HTTP server closed");
    });

    isCleaningUp = true;
    serverLogger.info("Cleaning up terminals and server...");

    // Dispose of all file watchers
    serverLogger.info("Disposing file watchers...");
    gitDiffManager.dispose();

    // Stop Docker container state sync
    DockerVSCodeInstance.stopContainerStateSync();

    stopVSCodeServeWeb(vscodeServeHandle, serverLogger);
    vscodeServeHandle = null;

    // Stop all VSCode instances using docker commands
    try {
      // Get all cmux containers
      const { stdout } = await execAsync(
        'docker ps -a --filter "name=cmux-" --format "{{.Names}}"'
      );
      const containerNames = stdout
        .trim()
        .split("\n")
        .filter((name) => name);

      if (containerNames.length > 0) {
        serverLogger.info(
          `Stopping ${containerNames.length} VSCode containers: ${containerNames.join(", ")}`
        );

        // Stop all containers in parallel with a single docker command
        exec(`docker stop ${containerNames.join(" ")}`, (error) => {
          if (error) {
            serverLogger.error("Error stopping containers:", error);
          } else {
            serverLogger.info("All containers stopped");
          }
        });

        // Don't wait for the command to finish
      } else {
        serverLogger.info("No VSCode containers found to stop");
      }
    } catch (error) {
      serverLogger.error(
        "Error stopping containers via docker command:",
        error
      );
    }

    VSCodeInstance.clearInstances();

    // Clean up git diff manager
    gitDiffManager.dispose();

    // Close the HTTP server
    serverLogger.info("Closing HTTP server...");
    await new Promise<void>((resolve) => {
      server.close(() => {
        serverLogger.info("HTTP server closed");
        resolve();
      });
    });

    isCleanedUp = true;
    serverLogger.info("Cleanup completed");

    // Close logger instances to ensure all data is flushed
    serverLogger.close();
    dockerLogger.close();
  }

  // Handle process termination signals
  process.on("SIGINT", async () => {
    serverLogger.info("Received SIGINT, shutting down gracefully...");
    await cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    serverLogger.info("Received SIGTERM, shutting down gracefully...");
    await cleanup();
    process.exit(0);
  });

  // Hot reload support
  if (import.meta.hot) {
    import.meta.hot.dispose(cleanup);

    import.meta.hot.accept(() => {
      serverLogger.info("Hot reload triggered");
    });
  }

  return { cleanup };
}

/**
 * Handle internal API requests from the www app for provider communication.
 * Routes:
 *   POST /internal/provider/:providerId/json-rpc   — generic JSON-RPC forwarder
 *   POST /internal/provider/:providerId/setup-allocation
 *   POST /internal/provider/:providerId/cleanup-allocation
 */
async function handleInternalProviderRequest(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  // Parse path: /internal/provider/:providerId/:action
  const parts = url.pathname.split("/");
  // parts: ["", "internal", "provider", providerId, action]
  const providerId = parts[3];
  const action = parts[4];

  if (!providerId || !action) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "Invalid path" }));
    return;
  }

  // Read request body
  const body = await new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: "Invalid JSON" }));
    return;
  }

  res.setHeader("Content-Type", "application/json");

  try {
    switch (action) {
      case "json-rpc": {
        const request = parsed.request as Record<string, unknown>;
        const result = await sendJsonRpcRequest(providerId, {
          jsonrpc: "2.0",
          method: request.method as string,
          params: {
            ...request.params as Record<string, unknown> ?? {},
            ...(parsed.allocationId ? { _allocationId: parsed.allocationId } : {}),
          },
          id: request.id as string | number,
        });
        res.statusCode = 200;
        res.end(JSON.stringify(result));
        break;
      }
      case "setup-allocation": {
        const result = await sendSetupAllocation(providerId, {
          allocationId: parsed.allocationId as string,
          buildDir: parsed.buildDir as string,
          simulatorDeviceType: parsed.simulatorDeviceType as string,
          simulatorRuntime: parsed.simulatorRuntime as string,
        });
        res.statusCode = 200;
        res.end(JSON.stringify(result));
        break;
      }
      case "cleanup-allocation": {
        const result = await sendCleanupAllocation(providerId, {
          allocationId: parsed.allocationId as string,
          buildDir: parsed.buildDir as string | undefined,
          simulatorUdid: parsed.simulatorUdid as string | undefined,
        });
        res.statusCode = 200;
        res.end(JSON.stringify(result));
        break;
      }
      default:
        res.statusCode = 404;
        res.end(JSON.stringify({ error: `Unknown action: ${action}` }));
    }
  } catch (error) {
    console.error(`Internal provider error (${action}):`, error);
    res.statusCode = 502;
    res.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  }
}
