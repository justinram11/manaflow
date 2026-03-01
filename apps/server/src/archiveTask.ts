import { getTaskRunsByTask } from "@cmux/db/queries/task-runs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getDb } from "./utils/dbClient";
import { serverLogger } from "./utils/fileLogger";
import { getAuthHeaderJson, getAuthToken } from "./utils/requestContext";
import { getWwwBaseUrl } from "./utils/server-env";

const execAsync = promisify(exec);

export type VSCodeProvider = "docker" | "morph" | "daytona" | "incus" | "aws" | "other";

export interface StopResult {
  success: boolean;
  containerName: string;
  provider: VSCodeProvider;
  error?: unknown;
}

async function stopDockerContainer(containerName: string): Promise<void> {
  try {
    await execAsync(`docker stop ${containerName}`, { timeout: 15_000 });
    return;
  } catch (err) {
    // If docker stop failed, check if it's already exited/stopped
    try {
      const { stdout } = await execAsync(
        `docker ps -a --filter "name=^${containerName}$" --format "{{.Status}}"`
      );
      if (stdout.toLowerCase().includes("exited")) {
        // Consider success if the container is already stopped
        return;
      }
    } catch {
      // ignore check errors and rethrow original
    }
    throw err;
  }
}

async function stopIncusContainer(containerId: string): Promise<void> {
  const baseUrl = getWwwBaseUrl();
  const url = `${baseUrl}/api/sandboxes/incus/${encodeURIComponent(containerId)}/destroy`;
  const token = getAuthToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers["x-stack-auth"] =
      getAuthHeaderJson() || JSON.stringify({ accessToken: token });
  }
  const res = await fetch(url, { method: "POST", headers });
  // Treat 404 as success (container already gone or server restarted)
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `Failed destroying Incus container ${containerId}: HTTP ${res.status}`
    );
  }
}

async function stopCmuxSandbox(instanceId: string): Promise<void> {
  const baseUrl = getWwwBaseUrl();
  const url = `${baseUrl}/api/sandboxes/${encodeURIComponent(instanceId)}/stop`;
  const token = getAuthToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers["x-stack-auth"] =
      getAuthHeaderJson() || JSON.stringify({ accessToken: token });
  }
  const res = await fetch(url, { method: "POST", headers });
  if (!res.ok && res.status !== 204) {
    throw new Error(
      `Failed stopping sandbox ${instanceId}: HTTP ${res.status}`
    );
  }
}

export async function stopContainersForRuns(
  taskId: string,
  _teamSlugOrId: string,
): Promise<StopResult[]> {
  const db = getDb();
  const runs = getTaskRunsByTask(db, { taskId });
  return stopContainersForRunsFromTree(runs, taskId);
}

export function stopContainersForRunsFromTree(
  tree: unknown[],
  taskIdLabel?: string
): Promise<StopResult[]> {
  // Flatten tree without casts (handles both flat arrays and nested tree structures)
  const flat: unknown[] = [];
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      flat.push(n);
      if (typeof n === "object" && n !== null) {
        const children = Reflect.get(Object(n), "children");
        walk(children);
      }
    }
  };
  walk(tree);

  if (typeof taskIdLabel === "string") {
    serverLogger.info(`Archiving task ${taskIdLabel} with ${flat.length} runs`);
  }

  // Collect valid docker/morph targets
  const targets: {
    provider: VSCodeProvider;
    containerName: string;
    runId: string;
  }[] = [];
  for (const r of flat) {
    if (typeof r !== "object" || r === null) continue;
    const vscode = Reflect.get(Object(r), "vscode");
    // Support both drizzle `id` and legacy Convex `_id`
    const runId = Reflect.get(Object(r), "id") ?? Reflect.get(Object(r), "_id");
    const provider =
      typeof vscode === "object" && vscode !== null
        ? Reflect.get(Object(vscode), "provider")
        : undefined;
    const name =
      typeof vscode === "object" && vscode !== null
        ? Reflect.get(Object(vscode), "containerName")
        : undefined;

    if (typeof name !== "string" || typeof runId !== "string") {
      continue;
    }

    // Detect Incus containers: explicit "incus" provider or legacy "docker" with cmux- prefix
    if (
      provider === "incus" ||
      (provider === "docker" && name.startsWith("cmux-"))
    ) {
      targets.push({ provider: "incus", containerName: name, runId });
    } else if (provider === "docker") {
      targets.push({ provider: "docker", containerName: name, runId });
    } else if (provider === "morph") {
      targets.push({ provider: "morph", containerName: name, runId });
    } else if (provider === "aws") {
      targets.push({ provider: "aws", containerName: name, runId });
    }
  }

  return Promise.all(
    targets.map(async (t): Promise<StopResult> => {
      try {
        serverLogger.info(
          `Stopping ${t.provider} container for run ${t.runId}: ${t.containerName}`
        );
        if (t.provider === "incus") {
          await stopIncusContainer(t.containerName);
          serverLogger.info(
            `Successfully destroyed Incus container: ${t.containerName}`
          );
          return {
            success: true,
            containerName: t.containerName,
            provider: t.provider,
          };
        }
        if (t.provider === "docker") {
          // Remove 'docker-' prefix for actual Docker commands
          const actualContainerName = t.containerName.startsWith("docker-")
            ? t.containerName.substring(7)
            : t.containerName;
          await stopDockerContainer(actualContainerName);
          serverLogger.info(
            `Successfully stopped Docker container: ${t.containerName} (actual: ${actualContainerName})`
          );
          return {
            success: true,
            containerName: t.containerName,
            provider: t.provider,
          };
        }
        if (t.provider === "morph") {
          await stopCmuxSandbox(t.containerName);
          serverLogger.info(
            `Successfully paused Morph instance: ${t.containerName}`
          );
          return {
            success: true,
            containerName: t.containerName,
            provider: t.provider,
          };
        }
        if (t.provider === "aws") {
          await stopCmuxSandbox(t.containerName);
          serverLogger.info(
            `Successfully stopped AWS instance: ${t.containerName}`
          );
          return {
            success: true,
            containerName: t.containerName,
            provider: t.provider,
          };
        }
        serverLogger.warn(
          `Unsupported provider '${t.provider}' for container ${t.containerName}`
        );
        return {
          success: false,
          containerName: t.containerName,
          provider: t.provider,
          error: new Error("Unsupported provider"),
        };
      } catch (error) {
        serverLogger.error(
          `Failed to stop ${t.provider} container ${t.containerName}:`,
          error
        );
        return {
          success: false,
          containerName: t.containerName,
          provider: t.provider,
          error,
        };
      }
    })
  );
}
