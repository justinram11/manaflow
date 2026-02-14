import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  clientPrefix: "NEXT_PUBLIC_",
  server: {
    // Stack server-side env
    STACK_SECRET_SERVER_KEY: z.string().min(1),
    STACK_SUPER_SECRET_ADMIN_KEY: z.string().min(1).optional(),
    STACK_DATA_VAULT_SECRET: z.string().min(32).optional(),
    // GitHub App (optional for self-hosted Docker setups using SSH auth)
    CMUX_GITHUB_APP_ID: z.string().min(1).optional(),
    CMUX_GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
    // Sandbox provider
    SANDBOX_PROVIDER: z.enum(["morph", "docker"]).optional(),
    SANDBOX_HOST: z.string().optional(),
    SANDBOX_IMAGE: z.string().optional(),
    // Morph
    MORPH_API_KEY: z.string().min(1).optional(),
    OPENAI_API_KEY: z.string().min(1).optional(),
    GEMINI_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    CMUX_TASK_RUN_JWT_SECRET: z.string().min(1),
    // AWS Bedrock credentials (optional - only required when spawning Claude agents)
    AWS_BEARER_TOKEN_BEDROCK: z.string().min(1).optional(),
    AWS_REGION: z.string().min(1).optional(),
  },
  client: {
    NEXT_PUBLIC_STACK_PROJECT_ID: z.string().min(1),
    NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY: z.string().min(1),
    NEXT_PUBLIC_CONVEX_URL: z.string().min(1),
    NEXT_PUBLIC_GITHUB_APP_SLUG: z.string().min(1).optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
