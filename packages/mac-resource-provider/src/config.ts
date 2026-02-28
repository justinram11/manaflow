import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ConfigSchema = z.object({
  serverUrl: z.string().url(),
  token: z.string().min(1),
  maxConcurrentBuilds: z.number().int().min(1).max(20).default(2),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  // Environment variables take precedence
  if (process.env.CMUX_SERVER_URL && process.env.CMUX_PROVIDER_TOKEN) {
    return ConfigSchema.parse({
      serverUrl: process.env.CMUX_SERVER_URL,
      token: process.env.CMUX_PROVIDER_TOKEN,
      maxConcurrentBuilds: process.env.CMUX_MAX_CONCURRENT_BUILDS
        ? parseInt(process.env.CMUX_MAX_CONCURRENT_BUILDS, 10)
        : 2,
    });
  }

  // Fall back to config file
  const configPath = join(homedir(), ".cmux", "mac-resource-provider", "config.json");
  if (!existsSync(configPath)) {
    throw new Error(
      `Config not found. Set CMUX_SERVER_URL and CMUX_PROVIDER_TOKEN env vars, or create ${configPath}`,
    );
  }

  const raw = readFileSync(configPath, "utf-8");
  return ConfigSchema.parse(JSON.parse(raw));
}
