import { execSync } from "node:child_process";
import { createResourceIosHandler } from "./handler";
import type { CapabilityHandler } from "../../types";

/**
 * Detect if Xcode and simctl are available on this machine.
 */
export async function detectXcodeSimctl(): Promise<boolean> {
  try {
    execSync("xcrun simctl list 2>/dev/null", { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export { createResourceIosHandler };
export type { CapabilityHandler };
