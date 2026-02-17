import type { SandboxExecResult, SandboxInstance } from "./sandbox-instance";
import {
  incusContainerExec,
  incusPause,
  incusResume,
  incusSnapshotCreate,
  incusStop,
  incusDelete,
} from "./incus-api";

/**
 * SandboxInstance implementation backed by an Incus system container (LXC).
 *
 * Supports pause/resume/snapshot/destroy in addition to the base
 * SandboxInstance interface (exec + stop).
 */
export class IncusSandboxInstance implements SandboxInstance {
  readonly id: string;
  private containerName: string;
  private stopped = false;
  private _paused = false;

  constructor(opts: { id: string; containerName: string }) {
    this.id = opts.id;
    this.containerName = opts.containerName;
  }

  /**
   * Execute a command inside the Incus container via `incus exec`.
   * The command is run through `bash -lc` for a login shell environment.
   */
  async exec(command: string): Promise<SandboxExecResult> {
    const result = await incusContainerExec(this.containerName, [
      "bash",
      "-lc",
      command,
    ]);
    return {
      exit_code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  /**
   * Stop the container gracefully.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await incusStop(this.containerName);
  }

  /**
   * Pause (freeze) the container.
   */
  async pause(): Promise<void> {
    await incusPause(this.containerName);
    this._paused = true;
  }

  /**
   * Resume a frozen container.
   */
  async resume(): Promise<void> {
    await incusResume(this.containerName);
    this._paused = false;
  }

  /**
   * Whether the container is currently paused/frozen.
   */
  get isPaused(): boolean {
    return this._paused;
  }

  /**
   * Create a stateful snapshot of the container.
   * Pauses the container, takes the snapshot, then resumes.
   */
  async snapshot(snapshotId: string): Promise<void> {
    await incusPause(this.containerName);
    try {
      await incusSnapshotCreate(this.containerName, snapshotId);
    } finally {
      await incusResume(this.containerName);
    }
  }

  /**
   * Destroy the container -- stop and force-delete.
   */
  async destroy(): Promise<void> {
    // incusDelete uses --force, which handles both running and stopped containers,
    // but we call stop() first for a graceful shutdown attempt.
    if (!this.stopped) {
      try {
        await this.stop();
      } catch (error) {
        console.error(
          `[IncusSandboxInstance] Graceful stop failed for ${this.containerName}, will force-delete:`,
          error,
        );
      }
    }
    await incusDelete(this.containerName);
  }

  /**
   * Get the underlying Incus container name.
   */
  getContainerName(): string {
    return this.containerName;
  }
}
