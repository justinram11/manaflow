import { dockerLogger } from "../utils/fileLogger";
import { extractSandboxStartError } from "../utils/sandboxErrors";
import { getWwwClient } from "../utils/wwwClient";
import { getWwwOpenApiModule } from "../utils/wwwOpenApiModule";
import {
  VSCodeInstance,
  type VSCodeInstanceConfig,
  type VSCodeInstanceInfo,
} from "./VSCodeInstance";

const {
  postApiSandboxesByIdStop,
  postApiSandboxesStart,
} = await getWwwOpenApiModule();

/**
 * VSCodeInstance implementation for Firecracker-backed sandboxes.
 *
 * This delegates to the www API's /sandboxes/start endpoint with
 * provider="firecracker" and an optional snapshotId. It follows
 * the same pattern as CmuxVSCodeInstance.
 */
export class FirecrackerVSCodeInstance extends VSCodeInstance {
  private sandboxId: string | null = null;
  private workerUrl: string | null = null;
  private vscodeBaseUrl: string | null = null;
  private repoUrl?: string;
  private branch?: string;
  private newBranch?: string;
  private snapshotId?: string;
  private taskRunJwt?: string;

  constructor(
    config: VSCodeInstanceConfig & {
      repoUrl?: string;
      branch?: string;
      newBranch?: string;
      snapshotId?: string;
      taskRunJwt?: string;
    },
  ) {
    super(config);
    this.repoUrl = config.repoUrl;
    this.branch = config.branch;
    this.newBranch = config.newBranch;
    this.snapshotId = config.snapshotId;
    this.taskRunJwt = config.taskRunJwt;
  }

  async start(): Promise<VSCodeInstanceInfo> {
    dockerLogger.info(
      `[FirecrackerVSCodeInstance ${this.instanceId}] Requesting sandbox start via www API (provider=firecracker)`,
    );

    const startRes = await postApiSandboxesStart({
      client: getWwwClient(),
      body: {
        teamSlugOrId: this.teamSlugOrId,
        provider: "firecracker",
        ttlSeconds: 60 * 60,
        metadata: {
          instance: `cmux-${this.taskRunId}`,
          agentName: this.config.agentName || "",
        },
        taskRunId: this.taskRunId,
        taskRunJwt: this.taskRunJwt || "",
        ...(this.snapshotId ? { snapshotId: this.snapshotId } : {}),
        ...(this.repoUrl
          ? {
              repoUrl: this.repoUrl,
              branch: this.branch,
              newBranch: this.newBranch,
              depth: 1,
            }
          : {}),
      },
    });

    const data = startRes.data;
    if (!data) {
      const errorMessage = extractSandboxStartError(startRes);
      throw new Error(errorMessage);
    }

    this.sandboxId = data.instanceId;
    this.vscodeBaseUrl = data.vscodeUrl;
    this.workerUrl = data.workerUrl;
    const vscodePersisted = data.vscodePersisted ?? false;

    const workspaceUrl = this.getWorkspaceUrl(this.vscodeBaseUrl);
    dockerLogger.info(
      `[FirecrackerVSCodeInstance] VS Code URL: ${workspaceUrl}`,
    );
    dockerLogger.info(
      `[FirecrackerVSCodeInstance] Worker URL: ${this.workerUrl}`,
    );

    // Connect to the worker if available
    if (this.workerUrl) {
      try {
        await this.connectToWorker(this.workerUrl);
        dockerLogger.info(
          `[FirecrackerVSCodeInstance ${this.instanceId}] Connected to worker`,
        );
      } catch (error) {
        dockerLogger.error(
          `[FirecrackerVSCodeInstance ${this.instanceId}] Failed to connect to worker`,
          error,
        );
      }
    }

    return {
      url: this.vscodeBaseUrl!,
      workspaceUrl,
      instanceId: this.instanceId,
      taskRunId: this.taskRunId,
      provider: "docker", // Use "docker" provider in VSCodeInstanceInfo (Firecracker behaves identically from the UI perspective)
      vscodePersisted,
    };
  }

  async stop(): Promise<void> {
    this.stopFileWatch();
    if (this.sandboxId) {
      try {
        await postApiSandboxesByIdStop({
          client: getWwwClient(),
          path: { id: this.sandboxId },
        });
      } catch (e) {
        dockerLogger.warn(`[FirecrackerVSCodeInstance] stop failed`, e);
      }
    }
    await this.baseStop();
  }

  async getStatus(): Promise<{ running: boolean; info?: VSCodeInstanceInfo }> {
    if (!this.sandboxId) return { running: false };
    // Firecracker VMs don't have a status endpoint yet; return based on local state
    if (this.vscodeBaseUrl) {
      return {
        running: true,
        info: {
          url: this.vscodeBaseUrl,
          workspaceUrl: this.getWorkspaceUrl(this.vscodeBaseUrl),
          instanceId: this.instanceId,
          taskRunId: this.taskRunId,
          provider: "docker",
        },
      };
    }
    return { running: false };
  }

  getName(): string {
    return this.sandboxId || this.instanceId;
  }

  getWorkerUrl(): string | null {
    return this.workerUrl;
  }
}
