import type { AgentConfig } from "../../agentConfig";
import {
  ANTHROPIC_MODEL_HAIKU_45,
  ANTHROPIC_MODEL_OPUS_45,
} from "../../utils/anthropic";
import { checkClaudeRequirements } from "./check-requirements";
import { startClaudeCompletionDetector } from "./completion-detector";
import {
  CLAUDE_KEY_ENV_VARS_TO_UNSET,
  getClaudeEnvironment,
} from "./environment";

/**
 * Create applyApiKeys function for AWS Bedrock.
 *
 * Uses platform-provided AWS Bedrock credentials.
 * Claude Code with Bedrock requires the model to be set via the ANTHROPIC_MODEL
 * environment variable (not via --model CLI flag).
 */
function createApplyClaudeApiKeys(
  bedrockModelId: string,
): NonNullable<AgentConfig["applyApiKeys"]> {
  return async (keys) => {
    // Base env vars to unset (prevent conflicts)
    const unsetEnv = [...CLAUDE_KEY_ENV_VARS_TO_UNSET];

    // AWS Bedrock with platform-provided credentials
    const env: Record<string, string> = {
      // Enable AWS Bedrock mode in Claude Code
      CLAUDE_CODE_USE_BEDROCK: "1",
      // Claude Code requires ANTHROPIC_MODEL env var for Bedrock
      ANTHROPIC_MODEL: bedrockModelId,
    };

    // AWS Bedrock credentials are injected by agentSpawner from server environment
    if (keys.AWS_BEARER_TOKEN_BEDROCK) {
      env.AWS_BEARER_TOKEN_BEDROCK = keys.AWS_BEARER_TOKEN_BEDROCK;
    }
    if (keys.AWS_REGION) {
      env.AWS_REGION = keys.AWS_REGION;
    }

    return {
      env,
      unsetEnv,
    };
  };
}

export const CLAUDE_OPUS_4_5_CONFIG: AgentConfig = {
  name: "claude/opus-4.5",
  command: "bunx",
  args: [
    "@anthropic-ai/claude-code@latest",
    "--allow-dangerously-skip-permissions",
    "--dangerously-skip-permissions",
    "--ide",
    "$PROMPT",
  ],
  environment: getClaudeEnvironment,
  checkRequirements: checkClaudeRequirements,
  applyApiKeys: createApplyClaudeApiKeys(ANTHROPIC_MODEL_OPUS_45),
  completionDetector: startClaudeCompletionDetector,
};

export const CLAUDE_SONNET_4_5_CONFIG: AgentConfig = {
  name: "claude/sonnet-4.5",
  command: "bunx",
  args: [
    "@anthropic-ai/claude-code@latest",
    "--allow-dangerously-skip-permissions",
    "--dangerously-skip-permissions",
    "--ide",
    "$PROMPT",
  ],
  environment: getClaudeEnvironment,
  checkRequirements: checkClaudeRequirements,
  completionDetector: startClaudeCompletionDetector,
  // Sonnet 4.5 not available on AWS Bedrock
  disabled: true,
  disabledReason: "Claude Sonnet 4.5 is not available on AWS Bedrock",
};

export const CLAUDE_HAIKU_4_5_CONFIG: AgentConfig = {
  name: "claude/haiku-4.5",
  command: "bunx",
  args: [
    "@anthropic-ai/claude-code@latest",
    "--allow-dangerously-skip-permissions",
    "--dangerously-skip-permissions",
    "--ide",
    "$PROMPT",
  ],
  environment: getClaudeEnvironment,
  checkRequirements: checkClaudeRequirements,
  applyApiKeys: createApplyClaudeApiKeys(ANTHROPIC_MODEL_HAIKU_45),
  completionDetector: startClaudeCompletionDetector,
};
