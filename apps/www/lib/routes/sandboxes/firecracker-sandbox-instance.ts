import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
  pauseVM,
  resumeVM,
  createSnapshot as fcCreateSnapshot,
} from "./firecracker-api";
import type { TapAllocation } from "./firecracker-network";
import { releaseTap } from "./firecracker-network";
import type { SandboxExecResult, SandboxInstance } from "./sandbox-instance";

// Port inside the VM where cmux-sandboxd listens
const SANDBOXD_PORT = 46831;

// Use git to find the project root reliably
const PROJECT_ROOT = execSync("git rev-parse --show-toplevel", {
  encoding: "utf-8",
}).trim();
const FC_HELPER_PATH = path.join(PROJECT_ROOT, "scripts/fc-helper.sh");

export interface FirecrackerPortMapping {
  hostPort: number;
  guestPort: number;
}

export class FirecrackerSandboxInstance implements SandboxInstance {
  readonly id: string;
  private fcPid: number;
  private socketPath: string;
  private tap: TapAllocation;
  private portMappings: FirecrackerPortMapping[];
  private rootfsPath: string;
  private snapshotDir: string;
  private sandboxdSandboxId: string;
  private proxyCleanups: Array<() => void>;
  private stopped = false;
  private _paused = false;

  constructor(opts: {
    id: string;
    fcPid: number;
    socketPath: string;
    tap: TapAllocation;
    portMappings: FirecrackerPortMapping[];
    rootfsPath: string;
    snapshotDir: string;
    sandboxdSandboxId: string;
    proxyCleanups: Array<() => void>;
  }) {
    this.id = opts.id;
    this.fcPid = opts.fcPid;
    this.socketPath = opts.socketPath;
    this.tap = opts.tap;
    this.portMappings = opts.portMappings;
    this.rootfsPath = opts.rootfsPath;
    this.snapshotDir = opts.snapshotDir;
    this.sandboxdSandboxId = opts.sandboxdSandboxId;
    this.proxyCleanups = opts.proxyCleanups;
  }

  /**
   * Execute a command inside the VM via cmux-sandboxd HTTP API.
   *
   * cmux-sandboxd manages OCI containers inside the VM. We exec into
   * the pre-created sandbox container using its ID.
   */
  async exec(command: string): Promise<SandboxExecResult> {
    const url = `http://${this.tap.guestIp}:${SANDBOXD_PORT}/sandboxes/${this.sandboxdSandboxId}/exec`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: ["/bin/sh", "-c", command],
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          exit_code: 1,
          stdout: "",
          stderr: `cmux-sandboxd returned ${response.status}: ${text}`,
        };
      }

      const result = (await response.json()) as SandboxExecResult;
      return result;
    } catch (error) {
      return {
        exit_code: 1,
        stdout: "",
        stderr: `Failed to exec in Firecracker VM: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Stop the Firecracker VM and clean up all resources.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    console.log(`[FirecrackerSandboxInstance] Stopping VM ${this.id}`);

    // Kill the Firecracker process via sudo helper
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          "sudo",
          [FC_HELPER_PATH, "kill", String(this.fcPid)],
          { timeout: 10_000 },
          (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          },
        );
      });
    } catch (error) {
      console.error(
        `[FirecrackerSandboxInstance] Error killing FC process (PID ${this.fcPid}):`,
        error,
      );
    }

    // Close TCP proxies
    for (const cleanup of this.proxyCleanups) {
      try {
        cleanup();
      } catch (error) {
        console.error(
          `[FirecrackerSandboxInstance] Error closing proxy:`,
          error,
        );
      }
    }

    // Release TAP device
    try {
      await releaseTap(this.tap);
    } catch (error) {
      console.error(
        `[FirecrackerSandboxInstance] Error releasing TAP:`,
        error,
      );
    }

    // Clean up socket
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // Ignore if already gone
    }

    console.log(`[FirecrackerSandboxInstance] VM ${this.id} stopped`);
  }

  /**
   * Create a snapshot of the running VM.
   * Pauses the VM, takes the snapshot, then resumes.
   */
  async snapshot(snapshotId: string): Promise<void> {
    const snapshotDir = `${this.snapshotDir}/${snapshotId}`;
    fs.mkdirSync(snapshotDir, { recursive: true });

    const snapshotPath = `${snapshotDir}/snapshot.bin`;
    const memPath = `${snapshotDir}/mem.bin`;
    const rootfsDst = `${snapshotDir}/rootfs.ext4`;

    console.log(
      `[FirecrackerSandboxInstance] Creating snapshot ${snapshotId} for VM ${this.id}`,
    );

    // Pause the VM
    await pauseVM(this.socketPath);

    try {
      // Create the snapshot (VM state + memory)
      await fcCreateSnapshot(this.socketPath, snapshotPath, memPath);

      // Copy the rootfs (sparse-aware)
      fs.copyFileSync(this.rootfsPath, rootfsDst);

      // Store metadata so restore knows the original paths baked into the snapshot
      fs.writeFileSync(
        `${snapshotDir}/metadata.json`,
        JSON.stringify({
          originalRootfsPath: this.rootfsPath,
          tapName: this.tap.tapName,
          guestIp: this.tap.guestIp,
          guestMac: this.tap.guestMac,
          sandboxdSandboxId: this.sandboxdSandboxId,
        }),
      );

      console.log(
        `[FirecrackerSandboxInstance] Snapshot ${snapshotId} created at ${snapshotDir}`,
      );
    } finally {
      // Resume the VM
      await resumeVM(this.socketPath);
    }
  }

  /**
   * Pause the VM without snapshotting.
   */
  async pause(): Promise<void> {
    await pauseVM(this.socketPath);
    this._paused = true;
  }

  /**
   * Resume a paused VM.
   */
  async resume(): Promise<void> {
    await resumeVM(this.socketPath);
    this._paused = false;
  }

  /**
   * Whether the VM is currently paused.
   */
  get isPaused(): boolean {
    return this._paused;
  }

  /**
   * Destroy the VM — stop and delete all disk files.
   */
  async destroy(): Promise<void> {
    await this.stop();
    // Delete VM directory (rootfs, socket files, etc.)
    const vmDir = path.dirname(this.rootfsPath);
    fs.rmSync(vmDir, { recursive: true, force: true });
    console.log(`[FirecrackerSandboxInstance] VM ${this.id} destroyed (files removed)`);
  }

  /**
   * Get the guest IP address for direct network access.
   */
  getGuestIp(): string {
    return this.tap.guestIp;
  }

  /**
   * Get the host port mapped to a given guest port.
   */
  getHostPort(guestPort: number): number | undefined {
    return this.portMappings.find((m) => m.guestPort === guestPort)?.hostPort;
  }
}
