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

export class IncusVSCodeInstance extends VSCodeInstance {
  private sandboxId: string | null = null;
  private workerUrl: string | null = null;
  private vscodeBaseUrl: string | null = null;
  private repoUrl?: string;
  private branch?: string;
  private newBranch?: string;
  private snapshotId?: string;
  private taskRunJwt?: string;
  private resourceProviderIds?: string[];

  constructor(
    config: VSCodeInstanceConfig & {
      repoUrl?: string;
      branch?: string;
      newBranch?: string;
      snapshotId?: string;
      taskRunJwt?: string;
      resourceProviderIds?: string[];
    },
  ) {
    super(config);
    this.repoUrl = config.repoUrl;
    this.branch = config.branch;
    this.newBranch = config.newBranch;
    this.snapshotId = config.snapshotId;
    this.taskRunJwt = config.taskRunJwt;
    this.resourceProviderIds = config.resourceProviderIds;
  }

  async start(): Promise<VSCodeInstanceInfo> {
    dockerLogger.info(
      `[IncusVSCodeInstance ${this.instanceId}] Requesting sandbox start via www API (provider=incus)`,
    );

    const startRes = await postApiSandboxesStart({
      client: getWwwClient(),
      body: {
        teamSlugOrId: this.teamSlugOrId,
        provider: "incus",
        ttlSeconds: 60 * 60,
        metadata: {
          instance: `cmux-${this.taskRunId}`,
          agentName: this.config.agentName || "",
        },
        taskRunId: this.taskRunId,
        taskRunJwt: this.taskRunJwt || "",
        ...(this.snapshotId ? { snapshotId: this.snapshotId } : {}),
        ...(this.resourceProviderIds?.length ? { resourceProviderIds: this.resourceProviderIds } : {}),
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

    if (this.workerUrl) {
      try {
        await this.connectToWorker(this.workerUrl);
      } catch (error) {
        dockerLogger.error(
          `[IncusVSCodeInstance ${this.instanceId}] Failed to connect to worker`,
          error,
        );
      }
    }

    return {
      url: this.vscodeBaseUrl!,
      workspaceUrl,
      instanceId: this.instanceId,
      taskRunId: this.taskRunId,
      provider: "docker",
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
        dockerLogger.warn(`[IncusVSCodeInstance] stop failed`, e);
      }
    }
    await this.baseStop();
  }

  async getStatus(): Promise<{ running: boolean; info?: VSCodeInstanceInfo }> {
    if (!this.sandboxId) return { running: false };
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
