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
  const env = {
    HOME: "/root",
    PUB_CACHE: "/opt/flutter/.pub-cache",
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
