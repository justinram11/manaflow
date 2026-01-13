export const CLOUDFLARE_ANTHROPIC_BASE_URL =
  "https://gateway.ai.cloudflare.com/v1/0c1675e0def6de1ab3a50a4e17dc5656/cmux-ai-proxy/anthropic";

export const VERTEX_MODEL_OPUS_45 = "claude-opus-4-5";
export const VERTEX_MODEL_SONNET_45 = "claude-sonnet-4-5";
export const VERTEX_MODEL_HAIKU_45 = "claude-haiku-4-5";

/**
 * AWS Bedrock model IDs for Claude models.
 * Used by code review heatmap feature. Claude Code fallback now uses Vertex AI.
 */
export const ANTHROPIC_MODEL_OPUS_45 =
  "global.anthropic.claude-opus-4-5-20251101-v1:0";
export const ANTHROPIC_MODEL_HAIKU_45 =
  "us.anthropic.claude-haiku-4-5-20251001-v1:0";
export const BEDROCK_AWS_REGION = "us-west-1";
