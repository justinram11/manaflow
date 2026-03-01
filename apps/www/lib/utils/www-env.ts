import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  clientPrefix: "NEXT_PUBLIC_",
  server: {
    // Auth mode: "local" bypasses Stack Auth for self-hosted deployments
    AUTH_MODE: z.enum(["local", "cloud"]).optional(),
    // Stack server-side env (optional in local auth mode)
    STACK_SECRET_SERVER_KEY: z.string().min(1).optional(),
    STACK_SUPER_SECRET_ADMIN_KEY: z.string().min(1).optional(),
    STACK_DATA_VAULT_SECRET: z.string().min(32).optional(),
    // GitHub App (optional for self-hosted Docker setups using SSH auth)
    CMUX_GITHUB_APP_ID: z.string().min(1).optional(),
    CMUX_GITHUB_APP_PRIVATE_KEY: z.string().min(1).optional(),
    // Sandbox provider
    SANDBOX_PROVIDER: z.enum(["morph", "docker", "incus", "aws"]).optional(),
    SANDBOX_HOST: z.string().optional(),
    SANDBOX_IMAGE: z.string().optional(),
    // Incus provider
    INCUS_IMAGE: z.string().optional(),
    INCUS_BASE_SNAPSHOT: z.string().optional(),
    // Morph
    MORPH_API_KEY: z.string().min(1).optional(),
    OPENAI_API_KEY: z.string().min(1).optional(),
    GEMINI_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    INSTALL_STATE_SECRET: z.string().min(1).optional(),
    CMUX_TASK_RUN_JWT_SECRET: z.string().min(1),
    // AWS Bedrock credentials (optional - only required when spawning Claude agents)
    AWS_BEARER_TOKEN_BEDROCK: z.string().min(1).optional(),
    AWS_REGION: z.string().min(1).optional(),
    // AWS EC2 compute provider
    AWS_EC2_ACCESS_KEY_ID: z.string().min(1).optional(),
    AWS_EC2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    AWS_EC2_REGION: z.string().min(1).optional(),
    AWS_EC2_INSTANCE_TYPE: z.string().min(1).optional(),
    AWS_EC2_AMI_IDS: z.string().min(1).optional(), // JSON: {"us-east-2":"ami-xxx"}
    AWS_EC2_SUBNET_IDS: z.string().min(1).optional(), // JSON: {"us-east-2":"subnet-xxx"}
    AWS_EC2_SECURITY_GROUP_IDS: z.string().min(1).optional(), // JSON: {"us-east-2":"sg-xxx"}
    // Tailscale networking (used by AWS provider)
    TAILSCALE_API_KEY: z.string().min(1).optional(),
    TAILSCALE_TAILNET: z.string().min(1).optional(),
    TAILSCALE_SHARE_TO_TAILNETS: z.string().min(1).optional(), // JSON: ["my-tailnet"]
  },
  client: {
    NEXT_PUBLIC_STACK_PROJECT_ID: z.string().min(1).optional(),
    NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY: z.string().min(1).optional(),
    // Legacy: kept optional for code paths that still reference it (code review, etc.)
    NEXT_PUBLIC_CONVEX_URL: z.string().min(1).optional(),
    NEXT_PUBLIC_GITHUB_APP_SLUG: z.string().min(1).optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
