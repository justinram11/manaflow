import { execSync } from "node:child_process";

/**
 * Execute a shell command locally inside the Android Incus container.
 * The MCP server runs in-container, so adb/emulator are on PATH directly —
 * no SSH hop required.
 */
export function exec(
  cmd: string,
  opts?: { timeout?: number; maxBuffer?: number; env?: Record<string, string> },
): string {
  // systemd doesn't set HOME for non-login services, but `flutter pub get`,
  // gradle, and git rely on HOME for caches + config. Force it to /root
  // unless the caller overrode it.
  //
  // ANDROID_HOME / ANDROID_SDK_ROOT are set in the systemd unit but get
  // dropped when bun spawns subprocesses without explicit env inheritance;
  // re-assert them so `flutter build apk` finds the SDK.
  const env = {
    HOME: "/root",
    PUB_CACHE: "/opt/flutter/.pub-cache",
    ANDROID_HOME: "/opt/android-sdk",
    ANDROID_SDK_ROOT: "/opt/android-sdk",
    ANDROID_AVD_HOME: "/root/.android/avd",
    ...process.env,
    ...(opts?.env ?? {}),
  };
  const result = execSync(cmd, {
    encoding: "utf-8",
    timeout: opts?.timeout ?? 60_000,
    maxBuffer: opts?.maxBuffer ?? 50 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  return result;
}
