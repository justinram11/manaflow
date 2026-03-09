import { execSync } from "node:child_process";

/**
 * Execute a shell command locally (we're running inside the Tart VM).
 * This replaces execInVm() from the mac-resource-provider — no SSH hop needed.
 */
export function exec(
  cmd: string,
  opts?: { timeout?: number; maxBuffer?: number },
): string {
  const result = execSync(cmd, {
    encoding: "utf-8",
    timeout: opts?.timeout ?? 60_000,
    maxBuffer: opts?.maxBuffer ?? 50 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result;
}
