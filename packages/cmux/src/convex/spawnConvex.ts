// Convex has been removed - emitConvexReady is a no-op
function emitConvexReady() { /* no-op */ }
import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logger } from "../logger";

export interface ConvexProcesses {
  backend: ChildProcess;
}

export async function spawnConvex(
  convexDir?: string
): Promise<ConvexProcesses> {
  if (!convexDir) {
    convexDir = path.resolve(os.homedir(), ".cmux");
  }
  const convexPort = process.env.CONVEX_PORT || "9777";

  await logger.info("Starting Convex CLI...");
  const convexBinaryPath = path.resolve(convexDir, "convex-local-backend");

  // Make sure the binary is executable
  try {
    await fs.chmod(convexBinaryPath, 0o755);
  } catch (error) {
    await logger.error(`Failed to make binary executable: ${error}`);
  }

  await logger.info("Starting convex process...");
  const convexBackend = spawn(
    convexBinaryPath,
    [
      "--port",
      convexPort,
      "--site-proxy-port",
      process.env.CONVEX_SITE_PROXY_PORT || "9778",
      "--instance-name",
      process.env.CONVEX_INSTANCE_NAME || "cmux-dev",
      "--instance-secret",
      process.env.CONVEX_INSTANCE_SECRET ||
        "29dd272e3cd3cce53ff444cac387925c2f6f53fd9f50803a24e5a11832d36b9c",
      "--disable-beacon",
    ],
    {
      cwd: convexDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    }
  );

  convexBackend.stdout.on("data", (data) => {
    logger.info(`[CONVEX-BACKEND] ${data}`).catch(() => {});
  });

  convexBackend.stderr.on("data", (data) => {
    logger.error(`[CONVEX-BACKEND] ${data}`).catch(() => {});
  });

  // wait until we can fetch the instance
  let instance: Response | undefined;
  let retries = 0;
  const maxRetries = 100;

  while ((!instance || !instance.ok) && retries < maxRetries) {
    try {
      instance = await fetch(`http://localhost:${convexPort}/`);
    } catch (error) {
      // Ignore fetch errors and continue retrying
    }

    if (!instance || !instance.ok) {
      retries++;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  if (!instance || !instance.ok) {
    throw new Error(
      `Failed to connect to Convex instance after ${maxRetries} retries`
    );
  }

  emitConvexReady();

  return {
    backend: convexBackend,
  };
}
