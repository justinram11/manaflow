/**
 * Capture manager stub.
 *
 * TrollVNC / Swift simulator capture has been removed. The Tart VM exposes
 * macOS Screen Sharing (VNC on port 5900) directly — users connect with an
 * external VNC client instead of an in-browser viewer.
 *
 * This file is kept as a no-op so existing imports don't break.
 */

class CaptureManager {
  startCapture(
    _allocationId: string,
    _simulatorUdid: string,
    _localPort: number,
    _fps?: number,
  ): void {
    // no-op — VNC capture removed
  }

  stopCapture(_allocationId: string): void {
    // no-op
  }

  isCapturing(_allocationId: string): boolean {
    return false;
  }

  stopAll(): void {
    // no-op
  }
}

export const captureManager = new CaptureManager();

export function cleanupStaleCaptureProcesses(): void {
  // no-op
}
