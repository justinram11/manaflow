import { execSync } from "node:child_process";
import { createResourceIosHandler } from "./handler";
import type { CapabilityHandler } from "../../types";

/**
 * Detect if Tart is available on this host machine.
 * The provider daemon runs on the host and spawns Tart VMs for each allocation.
 */
export async function detectTart(): Promise<boolean> {
  try {
    execSync("tart --version 2>/dev/null", { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * @deprecated Use detectTart instead. Kept for backwards compatibility.
 */
export const detectXcodeSimctl = detectTart;

export { createResourceIosHandler };
export type { CapabilityHandler };
