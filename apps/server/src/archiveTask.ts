import { api } from "@cmux/convex/api";
import type { Id } from "@cmux/convex/dataModel";
import type { FunctionReturnType } from "convex/server";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getConvex } from "./utils/convexClient";
import { serverLogger } from "./utils/fileLogger";
import { getAuthHeaderJson, getAuthToken } from "./utils/requestContext";
import { getWwwBaseUrl } from "./utils/server-env";

const execAsync = promisify(exec);

export type VSCodeProvider = "docker" | "morph" | "daytona" | "firecracker" | "other";

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

async function stopFirecrackerVm(vmId: string): Promise<void> {
  const baseUrl = getWwwBaseUrl();
  const url = `${baseUrl}/api/sandboxes/firecracker/${encodeURIComponent(vmId)}/destroy`;
  const token = getAuthToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers["x-stack-auth"] =
      getAuthHeaderJson() || JSON.stringify({ accessToken: token });
  }
  const res = await fetch(url, { method: "POST", headers });
  // Treat 404 as success (VM already gone or server restarted)
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `Failed destroying Firecracker VM ${vmId}: HTTP ${res.status}`
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
  taskId: Id<"tasks">,
  teamSlugOrId: string,
  query: (
    ref: typeof api.taskRuns.getByTask,
    args: { teamSlugOrId: string; taskId: Id<"tasks"> }
  ) => Promise<FunctionReturnType<typeof api.taskRuns.getByTask>> = (
    ref,
    args
  ) => getConvex().query(ref, args)
): Promise<StopResult[]> {
  const tree = await query(api.taskRuns.getByTask, {
    teamSlugOrId,
    taskId,
  });
  return stopContainersForRunsFromTree(tree, String(taskId));
}

export function stopContainersForRunsFromTree(
  tree: FunctionReturnType<typeof api.taskRuns.getByTask>,
  taskIdLabel?: string
): Promise<StopResult[]> {
  // Flatten tree without casts
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
    const runId = Reflect.get(Object(r), "_id");
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

    // Detect Firecracker VMs: explicit "firecracker" provider or legacy "docker" with fc- prefix
    if (
      provider === "firecracker" ||
      (provider === "docker" && name.startsWith("fc-"))
    ) {
      targets.push({ provider: "firecracker", containerName: name, runId });
    } else if (provider === "docker") {
      targets.push({ provider: "docker", containerName: name, runId });
    } else if (provider === "morph") {
      targets.push({ provider: "morph", containerName: name, runId });
    }
  }

  return Promise.all(
    targets.map(async (t): Promise<StopResult> => {
      try {
        serverLogger.info(
          `Stopping ${t.provider} container for run ${t.runId}: ${t.containerName}`
        );
        if (t.provider === "firecracker") {
          await stopFirecrackerVm(t.containerName);
          serverLogger.info(
            `Successfully destroyed Firecracker VM: ${t.containerName}`
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
