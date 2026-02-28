import { getComputeProviderClient } from "@/lib/utils/compute-provider";
import { env } from "@/lib/utils/www-env";
import type { SandboxExecResult, SandboxInstance } from "./sandbox-instance";
import type {
  PostApiInstancesResponse,
  GetApiSnapshotsResponse,
} from "@cmux/compute-provider-client";

/**
 * Incus provider for cmux sandboxes — thin HTTP client wrapper.
 *
 * Delegates all container operations to the compute-provider service via HTTP.
 * The compute-provider service handles the actual Incus CLI operations, port
 * allocation, networking, and graphical service setup.
 */

export interface IncusSandboxResult {
  instance: RemoteIncusSandboxInstance;
  containerId: string;
  containerName: string;
  hostPorts: Record<number, string>;
  vscodeUrl: string;
  workerUrl: string;
  urls: {
    vscode: string;
    worker: string;
    proxy: string;
    vnc: string;
    pty: string;
    androidVnc?: string;
  };
}

/**
 * SandboxInstance implementation that delegates to the compute-provider HTTP API.
 */
export class RemoteIncusSandboxInstance implements SandboxInstance {
  readonly id: string;
  private _paused = false;

  constructor(opts: { id: string }) {
    this.id = opts.id;
  }

  async exec(command: string): Promise<SandboxExecResult> {
    const client = getComputeProviderClient();
    const result = await client.post({
      url: "/api/instances/{id}/exec",
      path: { id: this.id },
      body: { command },
    });
    if (result.error) {
      console.error("[RemoteIncusSandboxInstance] exec failed:", result.error);
      return { exit_code: 1, stdout: "", stderr: String(result.error) };
    }
    const data = result.data as { exitCode: number; stdout: string; stderr: string };
    return {
      exit_code: data.exitCode,
      stdout: data.stdout,
      stderr: data.stderr,
    };
  }

  async stop(): Promise<void> {
    const client = getComputeProviderClient();
    const result = await client.post({
      url: "/api/instances/{id}/stop",
      path: { id: this.id },
    });
    if (result.error) {
      throw new Error(`Failed to stop instance ${this.id}: ${JSON.stringify(result.error)}`);
    }
  }

  async pause(): Promise<void> {
    const client = getComputeProviderClient();
    const result = await client.post({
      url: "/api/instances/{id}/pause",
      path: { id: this.id },
    });
    if (result.error) {
      throw new Error(`Failed to pause instance ${this.id}: ${JSON.stringify(result.error)}`);
    }
    this._paused = true;
  }

  async resume(): Promise<void> {
    const client = getComputeProviderClient();
    const result = await client.post({
      url: "/api/instances/{id}/resume",
      path: { id: this.id },
    });
    if (result.error) {
      throw new Error(`Failed to resume instance ${this.id}: ${JSON.stringify(result.error)}`);
    }
    this._paused = false;
  }

  get isPaused(): boolean {
    return this._paused;
  }

  async snapshot(snapshotName: string): Promise<void> {
    const client = getComputeProviderClient();
    const result = await client.post({
      url: "/api/instances/{id}/snapshots",
      path: { id: this.id },
      body: { name: snapshotName },
    });
    if (result.error) {
      throw new Error(`Failed to create snapshot for ${this.id}: ${JSON.stringify(result.error)}`);
    }
  }

  async destroy(): Promise<void> {
    const client = getComputeProviderClient();
    const result = await client.delete({
      url: "/api/instances/{id}",
      path: { id: this.id },
    });
    if (result.error) {
      throw new Error(`Failed to destroy instance ${this.id}: ${JSON.stringify(result.error)}`);
    }
  }

  getContainerName(): string {
    return this.id;
  }
}

/**
 * Start an Incus sandbox via the compute-provider HTTP API.
 *
 * Calls POST /api/instances, then wraps the result in a RemoteIncusSandboxInstance.
 */
export async function startIncusSandbox(options?: {
  snapshotId?: string;
  ttlSeconds?: number;
  metadata?: Record<string, string>;
  displays?: Array<"android">;
}): Promise<IncusSandboxResult> {
  const client = getComputeProviderClient();
  const sandboxHost = env.SANDBOX_HOST ?? "localhost";

  const result = await client.post({
    url: "/api/instances",
    body: {
      snapshotId: options?.snapshotId,
      displays: options?.displays,
      metadata: options?.metadata,
    },
  });

  if (result.error) {
    throw new Error(`Failed to launch Incus instance: ${JSON.stringify(result.error)}`);
  }

  const data = result.data as PostApiInstancesResponse;
  const host = data.host || sandboxHost;

  const makeUrl = (port: number) => `http://${host}:${port}`;

  // Build hostPorts map in the legacy format (container port → host port string)
  const hostPorts: Record<number, string> = {
    39378: String(data.ports.vscode),
    39377: String(data.ports.worker),
    39379: String(data.ports.proxy),
    39380: String(data.ports.vnc),
    39383: String(data.ports.pty),
  };
  if (data.ports.androidVnc !== undefined) {
    hostPorts[39384] = String(data.ports.androidVnc);
  }

  const instance = new RemoteIncusSandboxInstance({ id: data.id });

  return {
    instance,
    containerId: data.id,
    containerName: data.id,
    hostPorts,
    vscodeUrl: makeUrl(data.ports.vscode),
    workerUrl: makeUrl(data.ports.worker),
    urls: {
      vscode: makeUrl(data.ports.vscode),
      worker: makeUrl(data.ports.worker),
      proxy: makeUrl(data.ports.proxy),
      vnc: makeUrl(data.ports.vnc),
      pty: makeUrl(data.ports.pty),
      ...(data.ports.androidVnc !== undefined
        ? { androidVnc: makeUrl(data.ports.androidVnc) }
        : {}),
    },
  };
}

/**
 * List all snapshots via the compute-provider HTTP API.
 */
export async function listSnapshots(): Promise<
  Array<{
    id: string;
    containerName: string;
    snapshotName: string;
    createdAt: string;
    stateful: boolean;
  }>
> {
  const client = getComputeProviderClient();
  const result = await client.get({
    url: "/api/snapshots",
  });

  if (result.error) {
    console.error("[incus-provider] Failed to list snapshots:", result.error);
    return [];
  }

  const data = result.data as GetApiSnapshotsResponse;
  return data.snapshots;
}

/**
 * Delete a specific snapshot via the compute-provider HTTP API.
 */
export async function deleteSnapshot(snapshotId: string): Promise<void> {
  const client = getComputeProviderClient();
  const result = await client.delete({
    url: "/api/snapshots/{id}",
    path: { id: snapshotId },
  });

  if (result.error) {
    throw new Error(`Failed to delete snapshot ${snapshotId}: ${JSON.stringify(result.error)}`);
  }
}
