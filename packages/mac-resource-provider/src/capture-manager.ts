import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Manages iOS Simulator screen capture processes.
 * Each allocation gets its own capture instance running the Swift ScreenCaptureKit helper.
 */
class CaptureManager {
  private processes = new Map<string, ChildProcess>();

  /**
   * Start a VNC capture server for a simulator.
   * @param allocationId - Unique allocation identifier
   * @param simulatorUdid - The simulator's UDID
   * @param localPort - Port to serve the VNC/RFB protocol on
   * @param fps - Frames per second (default 30)
   */
  startCapture(
    allocationId: string,
    simulatorUdid: string,
    localPort: number,
    fps = 30,
  ): void {
    // Stop any existing capture for this allocation
    this.stopCapture(allocationId);

    const swiftPath = resolve(__dirname, "../capture/SimulatorCapture.swift");

    const child = spawn("swift", [swiftPath, "--udid", simulatorUdid, "--port", String(localPort), "--fps", String(fps)], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (data: Buffer) => {
      console.log(`[capture:${allocationId}] ${data.toString().trim()}`);
    });

    child.stderr?.on("data", (data: Buffer) => {
      console.log(`[capture:${allocationId}] ${data.toString().trim()}`);
    });

    child.on("exit", (code) => {
      console.log(`[capture:${allocationId}] Process exited with code ${code}`);
      this.processes.delete(allocationId);
    });

    child.on("error", (err) => {
      console.error(`[capture:${allocationId}] Process error:`, err);
      this.processes.delete(allocationId);
    });

    this.processes.set(allocationId, child);
    console.log(`[capture-manager] Started capture for allocation ${allocationId} (UDID: ${simulatorUdid}, port: ${localPort})`);
  }

  /**
   * Stop the capture process for an allocation.
   */
  stopCapture(allocationId: string): void {
    const child = this.processes.get(allocationId);
    if (child) {
      child.kill("SIGTERM");
      this.processes.delete(allocationId);
      console.log(`[capture-manager] Stopped capture for allocation ${allocationId}`);
    }
  }

  /**
   * Check if a capture is running for an allocation.
   */
  isCapturing(allocationId: string): boolean {
    return this.processes.has(allocationId);
  }

  /**
   * Stop all active captures (called on shutdown).
   */
  stopAll(): void {
    for (const [allocId, child] of this.processes) {
      child.kill("SIGTERM");
      console.log(`[capture-manager] Stopped capture for allocation ${allocId}`);
    }
    this.processes.clear();
  }
}

export const captureManager = new CaptureManager();
