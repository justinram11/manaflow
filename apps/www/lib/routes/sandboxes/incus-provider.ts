import { sendProviderRequest } from "@/lib/utils/provider-client";
import { env } from "@/lib/utils/www-env";
import type { SandboxExecResult, SandboxInstance } from "./sandbox-instance";

/**
 * Incus provider for cmux sandboxes — routes through WebSocket via provider daemon.
 *
 * All container operations are sent as JSON-RPC to the provider daemon
 * through the server's WebSocket hub.
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
    iosMcp?: string;
    iosVncIn?: string;
    iosVnc?: string;
    iosRsyncd?: string;
  };
}

interface LaunchResult {
  id: string;
  status: string;
  ports: {
    exec: number;
    worker: number;
    vscode: number;
    proxy: number;
    vnc: number;
    devtools: number;
    pty: number;
    androidVnc?: number;
    iosMcp?: number;
    iosVncIn?: number;
    iosVnc?: number;
    iosRsyncd?: number;
  };
  host: string;
}

/**
 * SandboxInstance implementation that delegates to the provider daemon via JSON-RPC.
 */
export class RemoteIncusSandboxInstance implements SandboxInstance {
  readonly id: string;
  private providerId: string;
  private _paused = false;

  constructor(opts: { id: string; providerId: string }) {
    this.id = opts.id;
    this.providerId = opts.providerId;
  }

  async exec(command: string): Promise<SandboxExecResult> {
    try {
      const result = await sendProviderRequest(this.providerId, "compute.exec", {
        id: this.id,
        command,
      }) as { exitCode: number; stdout: string; stderr: string };
      return {
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      console.error("[RemoteIncusSandboxInstance] exec failed:", error);
      return { exit_code: 1, stdout: "", stderr: String(error) };
    }
  }

  async stop(): Promise<void> {
    await sendProviderRequest(this.providerId, "compute.stop", { id: this.id });
  }

  async pause(): Promise<void> {
    await sendProviderRequest(this.providerId, "compute.pause", { id: this.id });
    this._paused = true;
  }

  async resume(): Promise<void> {
    await sendProviderRequest(this.providerId, "compute.resume", { id: this.id });
    this._paused = false;
  }

  get isPaused(): boolean {
    return this._paused;
  }

  async snapshot(snapshotName: string): Promise<string> {
    const result = await sendProviderRequest(this.providerId, "compute.createSnapshot", {
      id: this.id,
      name: snapshotName,
    }) as { snapshotId: string };
    return result.snapshotId;
  }

  async destroy(): Promise<void> {
    await sendProviderRequest(this.providerId, "compute.destroy", { id: this.id });
  }

  getContainerName(): string {
    return this.id;
  }
}

/**
 * Start an Incus sandbox via the provider daemon's WebSocket connection.
 */
export async function startIncusSandbox(options: {
  providerId: string;
  snapshotId?: string;
  ttlSeconds?: number;
  metadata?: Record<string, string>;
  displays?: Array<"android">;
  wantsIos?: boolean;
}): Promise<IncusSandboxResult> {
  const sandboxHost = env.SANDBOX_HOST ?? "localhost";

  const data = await sendProviderRequest(options.providerId, "compute.launch", {
    snapshotId: options.snapshotId,
    displays: options.displays,
    wantsIos: options.wantsIos,
    metadata: options.metadata,
    ttlSeconds: options.ttlSeconds,
  }) as LaunchResult;

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
  if (data.ports.iosMcp !== undefined) {
    hostPorts[39385] = String(data.ports.iosMcp);
  }
  if (data.ports.iosVncIn !== undefined) {
    hostPorts[39386] = String(data.ports.iosVncIn);
  }
  if (data.ports.iosVnc !== undefined) {
    hostPorts[39387] = String(data.ports.iosVnc);
  }
  if (data.ports.iosRsyncd !== undefined) {
    hostPorts[39376] = String(data.ports.iosRsyncd);
  }

  const instance = new RemoteIncusSandboxInstance({
    id: data.id,
    providerId: options.providerId,
  });

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
      ...(data.ports.iosMcp !== undefined
        ? { iosMcp: makeUrl(data.ports.iosMcp) }
        : {}),
      ...(data.ports.iosVncIn !== undefined
        ? { iosVncIn: makeUrl(data.ports.iosVncIn) }
        : {}),
      ...(data.ports.iosVnc !== undefined
        ? { iosVnc: makeUrl(data.ports.iosVnc) }
        : {}),
      ...(data.ports.iosRsyncd !== undefined
        ? { iosRsyncd: makeUrl(data.ports.iosRsyncd) }
        : {}),
    },
  };
}

/**
 * List all snapshots for a provider via JSON-RPC.
 */
export async function listProviderSnapshots(providerId: string): Promise<
  Array<{
    id: string;
    containerName: string;
    snapshotName: string;
    createdAt: string;
    stateful: boolean;
  }>
> {
  try {
    const result = await sendProviderRequest(providerId, "compute.listSnapshots", {}) as {
      snapshots: Array<{
        id: string;
        containerName: string;
        snapshotName: string;
        createdAt: string;
        stateful: boolean;
      }>;
    };
    return result.snapshots;
  } catch (error) {
    console.error("[incus-provider] Failed to list snapshots:", error);
    return [];
  }
}

/**
 * Delete a specific snapshot via JSON-RPC.
 */
export async function deleteProviderSnapshot(
  providerId: string,
  snapshotId: string,
): Promise<void> {
  await sendProviderRequest(providerId, "compute.deleteSnapshot", { id: snapshotId });
}
