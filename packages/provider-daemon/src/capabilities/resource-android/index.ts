import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
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

/**
 * Build the resource:android-emulator handler.
 *
 * The handler implementation depends on `@cmux/incus-resource-provider`, which
 * is Linux-only (incus is unavailable on macOS). On Mac hosts we ship the
 * daemon without that workspace dep, so we resolve the handler module lazily —
 * the caller should only invoke this when `detectAndroidIncus()` returned true.
 */
export async function createResourceAndroidHandler(): Promise<CapabilityHandler> {
  const mod = await import("./handler");
  return mod.createResourceAndroidHandler();
}

export type { CapabilityHandler };
