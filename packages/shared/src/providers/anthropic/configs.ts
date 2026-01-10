import type { AgentConfig } from "../../agentConfig";
import {
  AWS_ACCESS_KEY_ID,
  AWS_REGION,
  AWS_SECRET_ACCESS_KEY,
  AWS_SESSION_TOKEN,
} from "../../apiKeys";
import {
  ANTHROPIC_MODEL_HAIKU_45_ENV,
  ANTHROPIC_MODEL_OPUS_45_ENV,
  ANTHROPIC_MODEL_SONNET_45_ENV,
} from "../../utils/anthropic";
import { checkClaudeRequirements } from "./check-requirements";
import { startClaudeCompletionDetector } from "./completion-detector";
import {
  CLAUDE_KEY_ENV_VARS_TO_UNSET,
  getClaudeEnvironment,
} from "./environment";

/**
 * Apply API keys for Claude agents using AWS Bedrock.
 *
 * Sets up AWS credentials for Claude Code to use AWS Bedrock instead of
 * Anthropic API directly.
 */
const applyClaudeApiKeys: NonNullable<AgentConfig["applyApiKeys"]> = async (
  keys,
) => {
  // Always unset Anthropic-specific env vars to prevent conflicts
  const unsetEnv = [...CLAUDE_KEY_ENV_VARS_TO_UNSET];

  const env: Record<string, string> = {
    // Enable AWS Bedrock mode in Claude Code
    CLAUDE_CODE_USE_BEDROCK: "1",
  };

  // Set AWS credentials if provided
  if (keys.AWS_ACCESS_KEY_ID && keys.AWS_ACCESS_KEY_ID.trim().length > 0) {
    env.AWS_ACCESS_KEY_ID = keys.AWS_ACCESS_KEY_ID;
  }

  if (
    keys.AWS_SECRET_ACCESS_KEY &&
    keys.AWS_SECRET_ACCESS_KEY.trim().length > 0
  ) {
    env.AWS_SECRET_ACCESS_KEY = keys.AWS_SECRET_ACCESS_KEY;
  }

  if (keys.AWS_SESSION_TOKEN && keys.AWS_SESSION_TOKEN.trim().length > 0) {
    env.AWS_SESSION_TOKEN = keys.AWS_SESSION_TOKEN;
  }

  if (keys.AWS_REGION && keys.AWS_REGION.trim().length > 0) {
    env.AWS_REGION = keys.AWS_REGION;
  }

  return {
    env,
    unsetEnv,
  };
};

export const CLAUDE_OPUS_4_5_CONFIG: AgentConfig = {
  name: "claude/opus-4.5",
  command: "bunx",
  args: [
    "@anthropic-ai/claude-code@latest",
    "--model",
    `$${ANTHROPIC_MODEL_OPUS_45_ENV}`,
    "--allow-dangerously-skip-permissions",
    "--dangerously-skip-permissions",
    "--ide",
    "$PROMPT",
  ],
  environment: getClaudeEnvironment,
  checkRequirements: checkClaudeRequirements,
  apiKeys: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION],
  applyApiKeys: applyClaudeApiKeys,
  completionDetector: startClaudeCompletionDetector,
};

export const CLAUDE_SONNET_4_5_CONFIG: AgentConfig = {
  name: "claude/sonnet-4.5",
  command: "bunx",
  args: [
    "@anthropic-ai/claude-code@latest",
    "--model",
    `$${ANTHROPIC_MODEL_SONNET_45_ENV}`,
    "--allow-dangerously-skip-permissions",
    "--dangerously-skip-permissions",
    "--ide",
    "$PROMPT",
  ],
  environment: getClaudeEnvironment,
  checkRequirements: checkClaudeRequirements,
  apiKeys: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION],
  applyApiKeys: applyClaudeApiKeys,
  completionDetector: startClaudeCompletionDetector,
};

export const CLAUDE_HAIKU_4_5_CONFIG: AgentConfig = {
  name: "claude/haiku-4.5",
  command: "bunx",
  args: [
    "@anthropic-ai/claude-code@latest",
    "--model",
    `$${ANTHROPIC_MODEL_HAIKU_45_ENV}`,
    "--allow-dangerously-skip-permissions",
    "--dangerously-skip-permissions",
    "--ide",
    "$PROMPT",
  ],
  environment: getClaudeEnvironment,
  checkRequirements: checkClaudeRequirements,
  apiKeys: [AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION],
  applyApiKeys: applyClaudeApiKeys,
  completionDetector: startClaudeCompletionDetector,
};
