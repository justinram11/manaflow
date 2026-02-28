import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { app } from "electron";

function logsDir(): string {
  try {
    const base = app.getPath("userData");
    const dir = join(base, "logs");
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    const dir = join(os.tmpdir(), "cmux-user-data", "logs");
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // ignore
    }
    return dir;
  }
}

function logInvalidEnv(issues: unknown): void {
  try {
    const file = join(logsDir(), "fatal-invalid-env.log");
    const ts = new Date().toISOString();
    const body = typeof issues === "string" ? issues : JSON.stringify(issues, null, 2);
    appendFileSync(
      file,
      `[${ts}] Invalid environment variables (electron main)\n${body}\n`,
      { encoding: "utf8" }
    );
  } catch {
    // ignore
  }
}

export const env = createEnv({
  server: {},
  clientPrefix: "NEXT_PUBLIC_",
  client: {
    NEXT_PUBLIC_STACK_PROJECT_ID: z.string().min(1),
    NEXT_PUBLIC_CONVEX_URL: z.string().min(1).optional(),
  },
  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
  onValidationError: (issues) => {
    logInvalidEnv(issues);
    const err = new Error("Invalid environment variables");
    // Attach issues for upstream fatal logger
    // @ts-expect-error non-standard property for richer logging
    err.issues = issues;
    throw err;
  },
});
