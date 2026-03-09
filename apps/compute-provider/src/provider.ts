/**
 * Backend-agnostic compute provider interface.
 *
 * Today it's IncusProvider; tomorrow it could be VultrProvider.
 */

export interface LaunchOptions {
  image?: string;
  snapshotId?: string;
  displays?: Array<"android">;
  wantsIos?: boolean;
  metadata?: Record<string, string>;
  region?: string;
  ttlSeconds?: number;
}

export interface LaunchResult {
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
    iosVncIn?: number;
    iosVnc?: number;
    iosRsyncd?: number;
  };
  host: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface InstanceStatus {
  id: string;
  status: string;
  paused: boolean;
  ports?: LaunchResult["ports"];
  metadata?: Record<string, string>;
  createdAt: number;
}

export interface InstanceInfo {
  id: string;
  status: string;
  paused: boolean;
  ports?: LaunchResult["ports"];
  metadata?: Record<string, string>;
  createdAt: number;
}

export interface SnapshotInfo {
  id: string;
  containerName: string;
  snapshotName: string;
  createdAt: string;
  stateful: boolean;
}

export interface ComputeProvider {
  launch(opts: LaunchOptions): Promise<LaunchResult>;
  exec(id: string, command: string): Promise<ExecResult>;
  stop(id: string): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  getStatus(id: string): Promise<InstanceStatus | null>;
  listInstances(): Promise<InstanceInfo[]>;
  createSnapshot(id: string, name: string): Promise<string>;
  listSnapshots(): Promise<SnapshotInfo[]>;
  deleteSnapshot(snapshotId: string): Promise<void>;
}
