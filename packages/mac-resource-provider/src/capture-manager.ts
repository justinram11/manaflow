import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TROLLVNC_DIR = resolve(homedir(), ".cmux", "vendor", "TrollVNC");
const DEFAULT_THEOS_DIR = resolve(homedir(), "theos-roothide");
const TROLLVNC_BINARY_RELATIVE_PATH = join(
  ".theos",
  "obj",
  "iphone_simulator",
  "debug",
  "trollvncserver",
);
const TROLLVNC_REPO_URL = "https://github.com/OwnGoalStudio/TrollVNC.git";

interface CaptureProcessInfo {
  child: ChildProcess;
  simulatorUdid: string;
  mode: "trollvnc" | "swift";
}

function resolveExecutable(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    if (candidate.includes("/")) {
      if (existsSync(candidate)) {
        return candidate;
      }
      continue;
    }

    try {
      return execFileSync("bash", ["-lc", `command -v ${candidate}`], {
        encoding: "utf-8",
      }).trim();
    } catch {
      continue;
    }
  }

  return null;
}

function ensureTrollVncSourceDir(): string {
  const sourceDir = process.env.CMUX_TROLLVNC_SOURCE_DIR ?? DEFAULT_TROLLVNC_DIR;

  if (existsSync(resolve(sourceDir, ".git"))) {
    return sourceDir;
  }

  mkdirSync(resolve(sourceDir, ".."), { recursive: true });
  console.log(`[capture-manager] Cloning TrollVNC into ${sourceDir}`);
  execFileSync("git", ["clone", "--recursive", TROLLVNC_REPO_URL, sourceDir], {
    stdio: "inherit",
  });
  return sourceDir;
}

function ensureTrollVncBinary(): string {
  const configuredBinary = process.env.CMUX_TROLLVNC_BINARY;
  if (configuredBinary && existsSync(configuredBinary)) {
    return configuredBinary;
  }

  const sourceDir = ensureTrollVncSourceDir();
  const binaryPath = resolve(sourceDir, TROLLVNC_BINARY_RELATIVE_PATH);
  if (existsSync(binaryPath)) {
    return binaryPath;
  }

  const makePath = resolveExecutable([
    process.env.CMUX_GMAKE_PATH ?? "",
    "/opt/homebrew/bin/gmake",
    "gmake",
    "make",
  ]);
  if (!makePath) {
    throw new Error("Unable to find gmake or make for TrollVNC build");
  }

  const theosDir = process.env.THEOS ?? DEFAULT_THEOS_DIR;
  if (!existsSync(theosDir)) {
    throw new Error(`THEOS directory not found at ${theosDir}`);
  }

  console.log(`[capture-manager] Building TrollVNC at ${sourceDir}`);
  execFileSync(makePath, ["clean", "trollvncserver"], {
    cwd: sourceDir,
    stdio: "inherit",
    env: {
      ...process.env,
      THEOS: theosDir,
      THEOS_PACKAGE_SCHEME: "",
      THEOS_DEVICE_IP: "",
      THEOS_DEVICE_PORT: "",
      THEOS_DEVICE_SIMULATOR: "1",
      THEBOOTSTRAP: "0",
    },
  });

  if (!existsSync(binaryPath)) {
    throw new Error(`TrollVNC build finished without binary at ${binaryPath}`);
  }

  return binaryPath;
}

function killSimulatorProcess(simulatorUdid: string, processName: string): void {
  try {
    execFileSync(
      "xcrun",
      [
        "simctl",
        "spawn",
        simulatorUdid,
        "/bin/sh",
        "-lc",
        `killall -TERM ${processName} >/dev/null 2>&1 || true`,
      ],
      {
        stdio: "ignore",
      },
    );
  } catch (error) {
    console.error(
      `[capture-manager] Failed to terminate ${processName} for simulator ${simulatorUdid}:`,
      error,
    );
  }
}

/**
 * Manages iOS Simulator screen capture processes.
 * Each allocation gets its own capture instance running a VNC server inside the simulator.
 */
class CaptureManager {
  private processes = new Map<string, CaptureProcessInfo>();

  private startSwiftFallback(
    allocationId: string,
    simulatorUdid: string,
    localPort: number,
    fps: number,
  ): CaptureProcessInfo {
    const swiftPath = resolve(__dirname, "../capture/SimulatorCapture.swift");
    const child = spawn(
      "swift",
      [swiftPath, "--udid", simulatorUdid, "--port", String(localPort), "--fps", String(fps)],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    return { child, simulatorUdid, mode: "swift" };
  }

  private startTrollVnc(
    allocationId: string,
    simulatorUdid: string,
    localPort: number,
  ): CaptureProcessInfo {
    const binaryPath = ensureTrollVncBinary();
    const child = spawn(
      "xcrun",
      [
        "simctl",
        "spawn",
        simulatorUdid,
        binaryPath,
        "-p",
        String(localPort),
        "-n",
        `cmux-${allocationId.slice(0, 8)}`,
        "-B",
        "off",
        "-i",
        "off",
        "-I",
        "off",
        "-C",
        "off",
        "-U",
        "on",
        "-O",
        "on",
        "-M",
        "altcmd",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    return { child, simulatorUdid, mode: "trollvnc" };
  }

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

    const backend = process.env.CMUX_IOS_VNC_BACKEND ?? "trollvnc";
    const processInfo =
      backend === "fake"
        ? this.startSwiftFallback(allocationId, simulatorUdid, localPort, fps)
        : this.startTrollVnc(allocationId, simulatorUdid, localPort);
    const { child, mode } = processInfo;

    child.stdout?.on("data", (data: Buffer) => {
      console.log(`[capture:${allocationId}] ${data.toString().trim()}`);
    });

    child.stderr?.on("data", (data: Buffer) => {
      console.log(`[capture:${allocationId}] ${data.toString().trim()}`);
    });

    child.on("exit", (code) => {
      console.log(`[capture:${allocationId}] ${mode} process exited with code ${code}`);
      this.processes.delete(allocationId);
    });

    child.on("error", (err) => {
      console.error(`[capture:${allocationId}] ${mode} process error:`, err);
      this.processes.delete(allocationId);
    });

    this.processes.set(allocationId, processInfo);
    console.log(
      `[capture-manager] Started ${mode} capture for allocation ${allocationId} (UDID: ${simulatorUdid}, port: ${localPort})`,
    );
  }

  /**
   * Stop the capture process for an allocation.
   */
  stopCapture(allocationId: string): void {
    const processInfo = this.processes.get(allocationId);
    if (processInfo) {
      processInfo.child.kill("SIGTERM");
      if (processInfo.mode === "trollvnc") {
        killSimulatorProcess(processInfo.simulatorUdid, "trollvncserver");
      }
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
    for (const [allocId, processInfo] of this.processes) {
      processInfo.child.kill("SIGTERM");
      if (processInfo.mode === "trollvnc") {
        killSimulatorProcess(processInfo.simulatorUdid, "trollvncserver");
      }
      console.log(`[capture-manager] Stopped capture for allocation ${allocId}`);
    }
    this.processes.clear();
  }
}

export const captureManager = new CaptureManager();
