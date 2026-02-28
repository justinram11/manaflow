import { execSync } from "node:child_process";
import { handler } from "./handler";
import type { CapabilityHandler } from "../../types";

/**
 * Detect if Incus is available on this machine.
 */
export async function detectIncus(): Promise<boolean> {
  try {
    execSync("incus version", { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the compute:incus capability handler.
 * The actual Incus provider logic is in the apps/compute-provider package
 * which continues to run as a standalone HTTP service.
 *
 * This handler bridges JSON-RPC requests from the WebSocket to the local
 * compute-provider HTTP API.
 */
export function createComputeIncusHandler(): CapabilityHandler {
  return handler;
}
