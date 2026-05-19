import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createResourceAndroidHandler } from "./handler";
import type { CapabilityHandler } from "../../types";

/**
 * Detect whether this host can run the Android emulator resource provider.
 *
 * Requires both:
 *   - the `incus` CLI (containers are launched per allocation)
 *   - `/dev/kvm` (hardware-accelerated emulation passed through to containers)
 */
export async function detectAndroidIncus(): Promise<boolean> {
  let hasIncus = false;
  try {
    execSync("incus version", { encoding: "utf-8", stdio: "pipe" });
    hasIncus = true;
  } catch {
    hasIncus = false;
  }

  const hasKvm = existsSync("/dev/kvm");

  return hasIncus && hasKvm;
}

export { createResourceAndroidHandler };
export type { CapabilityHandler };
