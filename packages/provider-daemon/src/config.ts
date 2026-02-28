import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DaemonConfig } from "./types";

const configSchema = z.object({
  serverUrl: z.string().url(),
  token: z.string().min(1),
  maxConcurrentSlots: z.number().int().min(1).max(20).optional(),
});

export function loadConfig(): DaemonConfig {
  // Priority 1: Environment variables
  const envServerUrl = process.env.CMUX_SERVER_URL;
  const envToken = process.env.CMUX_PROVIDER_TOKEN;
  const envMaxSlots = process.env.CMUX_MAX_CONCURRENT_SLOTS;

  if (envServerUrl && envToken) {
    return configSchema.parse({
      serverUrl: envServerUrl,
      token: envToken,
      maxConcurrentSlots: envMaxSlots ? parseInt(envMaxSlots, 10) : undefined,
    });
  }

  // Priority 2: Config file
  const configPath = join(homedir(), ".cmux", "provider", "config.json");
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    return configSchema.parse(JSON.parse(raw));
  }

  throw new Error(
    "No configuration found. Set CMUX_SERVER_URL and CMUX_PROVIDER_TOKEN environment variables, " +
    "or create ~/.cmux/provider/config.json",
  );
}
