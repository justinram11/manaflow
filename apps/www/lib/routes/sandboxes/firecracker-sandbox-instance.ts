import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import {
  pauseVM,
  resumeVM,
  createSnapshot as fcCreateSnapshot,
} from "./firecracker-api";
import type { TapAllocation } from "./firecracker-network";
import { releaseTap, removePortForward } from "./firecracker-network";
import type { SandboxExecResult, SandboxInstance } from "./sandbox-instance";

// Port inside the VM where cmux-sandboxd listens
const SANDBOXD_PORT = 46831;

export interface FirecrackerPortMapping {
  hostPort: number;
  guestPort: number;
}

export class FirecrackerSandboxInstance implements SandboxInstance {
  readonly id: string;
  private firecrackerProcess: ChildProcess;
  private socketPath: string;
  private tap: TapAllocation;
  private portMappings: FirecrackerPortMapping[];
  private rootfsPath: string;
  private snapshotDir: string;
  private stopped = false;

  constructor(opts: {
    id: string;
    firecrackerProcess: ChildProcess;
    socketPath: string;
    tap: TapAllocation;
    portMappings: FirecrackerPortMapping[];
    rootfsPath: string;
    snapshotDir: string;
  }) {
    this.id = opts.id;
    this.firecrackerProcess = opts.firecrackerProcess;
    this.socketPath = opts.socketPath;
    this.tap = opts.tap;
    this.portMappings = opts.portMappings;
    this.rootfsPath = opts.rootfsPath;
    this.snapshotDir = opts.snapshotDir;
  }

  /**
   * Execute a command inside the VM via cmux-sandboxd HTTP API.
   *
   * cmux-sandboxd runs on port 46831 inside the VM — the same service
   * used by Docker sandboxes. We reach it via the guest IP.
   */
  async exec(command: string): Promise<SandboxExecResult> {
    const url = `http://${this.tap.guestIp}:${SANDBOXD_PORT}/exec`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
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

    // Kill the Firecracker process
    try {
      this.firecrackerProcess.kill("SIGTERM");
      // Wait briefly for graceful shutdown
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          this.firecrackerProcess.kill("SIGKILL");
          resolve();
        }, 5000);
        this.firecrackerProcess.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    } catch (error) {
      console.error(
        `[FirecrackerSandboxInstance] Error killing FC process:`,
        error,
      );
    }

    // Remove port forwards
    for (const mapping of this.portMappings) {
      try {
        await removePortForward(
          mapping.hostPort,
          this.tap.guestIp,
          mapping.guestPort,
        );
      } catch (error) {
        console.error(
          `[FirecrackerSandboxInstance] Error removing port forward:`,
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
  }

  /**
   * Resume a paused VM.
   */
  async resume(): Promise<void> {
    await resumeVM(this.socketPath);
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
