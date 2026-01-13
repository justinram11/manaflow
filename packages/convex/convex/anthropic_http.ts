import { httpAction } from "./_generated/server";
import { getWorkerAuth } from "./users/utils/getWorkerAuth";
import { env } from "../_shared/convex-env";

/**
 * Cloudflare AI Gateway configuration.
 */
const CLOUDFLARE_ACCOUNT_ID = "0c1675e0def6de1ab3a50a4e17dc5656";
const CLOUDFLARE_GATEWAY_ID = "cmux-ai-proxy";

const hardCodedApiKey = "sk_placeholder_cmux_anthropic_api_key";

/**
 * Google Cloud project configuration.
 */
const GCP_PROJECT_ID = "manaflow-420907";
const GCP_REGION = "us-east5";

/**
 * Cloudflare AI Gateway base URL for Google Vertex AI.
 */
const CLOUDFLARE_VERTEX_BASE_URL =
  `https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_GATEWAY_ID}/google-vertex-ai/v1/projects/${GCP_PROJECT_ID}/locations/${GCP_REGION}/publishers/anthropic/models`;

export const CLOUDFLARE_ANTHROPIC_BASE_URL =
  "https://gateway.ai.cloudflare.com/v1/0c1675e0def6de1ab3a50a4e17dc5656/cmux-ai-proxy/anthropic";

const JSON_HEADERS = {
  "Content-Type": "application/json",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Check if the key is a valid Anthropic API key format.
 * Anthropic keys start with "sk-ant-" (regular) or "sk-ant-oat" (OAuth).
 */
function isAnthropicApiKey(key: string | null): boolean {
  return key !== null && key.startsWith("sk-ant-");
}

/**
 * Check if user provided their own valid Anthropic API key (not the placeholder).
 */
function hasUserApiKey(key: string | null): boolean {
  return key !== null && key !== hardCodedApiKey && isAnthropicApiKey(key);
}

/**
 * Convert Anthropic API model ID to Vertex AI model ID format.
 * Anthropic uses: claude-haiku-4-5-20251001
 * Vertex AI uses: claude-haiku-4-5@20251001
 * The pattern is to replace the last dash before the 8-digit date with @
 */
function toVertexModelId(anthropicModelId: string): string {
  // Match model name ending with -YYYYMMDD (8 digit date)
  const match = anthropicModelId.match(/^(.+)-(\d{8})$/);
  if (match) {
    return `${match[1]}@${match[2]}`;
  }
  // If no date suffix, return as-is (Vertex will likely fail, but let's pass it through)
  return anthropicModelId;
}

/**
 * Handle private key - convert literal \n if present, otherwise use as-is.
 */
function formatPrivateKey(key: string): string {
  if (key.includes("\\n")) {
    return key.replace(/\\n/g, "\n");
  }
  return key;
}

/**
 * Build the service account JSON for Cloudflare AI Gateway authentication.
 * Cloudflare handles token generation internally when given the service account JSON.
 */
function buildServiceAccountJson(): string {
  const privateKey = env.VERTEX_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("VERTEX_PRIVATE_KEY environment variable is not set");
  }

  const serviceAccount = {
    type: "service_account",
    project_id: GCP_PROJECT_ID,
    private_key_id: "aff18cf6b6f38c0827cba7cb8bd143269560e435",
    private_key: formatPrivateKey(privateKey),
    client_email: "vertex-express@manaflow-420907.iam.gserviceaccount.com",
    client_id: "113976467144405037333",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/vertex-express%40manaflow-420907.iam.gserviceaccount.com",
    universe_domain: "googleapis.com",
    region: GCP_REGION,
  };

  return JSON.stringify(serviceAccount);
}

const TEMPORARY_DISABLE_AUTH = true;

/**
 * HTTP action to proxy Anthropic API requests.
 * Routes to:
 * 1. Anthropic direct (via Cloudflare) - when user provides their own API key
 * 2. Vertex AI (via Cloudflare) - when using platform credits (placeholder key)
 */
export const anthropicProxy = httpAction(async (_ctx, req) => {
  // Try to extract token payload for tracking
  const workerAuth = await getWorkerAuth(req, {
    loggerPrefix: "[anthropic-proxy]",
  });

  if (!TEMPORARY_DISABLE_AUTH && !workerAuth) {
    console.error("[anthropic-proxy] Auth error: Missing or invalid token");
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  try {
    const xApiKey = req.headers.get("x-api-key");
    const useUserApiKey = hasUserApiKey(xApiKey);
    const body = await req.json();
    const requestedModel = body.model;

    // Debug: log key prefix to see what we're receiving
    console.log("[anthropic-proxy] Received key prefix:", {
      keyPrefix: xApiKey?.substring(0, 15) ?? "null",
      isPlaceholder: xApiKey === hardCodedApiKey,
      useUserApiKey,
    });

    if (useUserApiKey) {
      // User provided their own API key → pass through all original headers to Anthropic
      console.log("[anthropic-proxy] Routing to ANTHROPIC DIRECT (user API key)", {
        model: requestedModel,
      });

      // Pass through all original headers like WWW does
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        // Skip hop-by-hop headers and internal headers
        if (!["host", "x-cmux-token", "content-length"].includes(key.toLowerCase())) {
          headers[key] = value;
        }
      });

      const response = await fetch(`${CLOUDFLARE_ANTHROPIC_BASE_URL}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      // If auth fails, fall back to Vertex AI
      if (response.status === 401) {
        const errorData = await response.json();
        console.log("[anthropic-proxy] Invalid API key, falling back to VERTEX AI", {
          model: requestedModel,
          error: errorData,
        });
        // Continue to Vertex AI path below
      } else {
        return handleResponse(response, body.stream);
      }
    }

    // Vertex AI path: either placeholder key or fallback from invalid user key
    {
      const vertexModelId = toVertexModelId(requestedModel);
      const streamSuffix = body.stream ? ":streamRawPredict" : ":rawPredict";
      const cloudflareUrl = `${CLOUDFLARE_VERTEX_BASE_URL}/${vertexModelId}${streamSuffix}`;

      console.log("[anthropic-proxy] Routing to VERTEX AI (platform credits)", {
        model: requestedModel,
        vertexModelId,
      });

      // Build service account JSON for Cloudflare authentication
      const serviceAccountJson = buildServiceAccountJson();

      // Add anthropic_version required by Vertex AI and remove model (it's in URL)
      const { model: _model, ...bodyWithoutModel } = body;
      const vertexBody = {
        ...bodyWithoutModel,
        anthropic_version: "vertex-2023-10-16",
      };

      const response = await fetch(cloudflareUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: serviceAccountJson,
        },
        body: JSON.stringify(vertexBody),
      });

      return handleResponse(response, body.stream);
    }
  } catch (error) {
    console.error("[anthropic-proxy] Error:", error);
    return jsonResponse({ error: "Failed to proxy request" }, 500);
  }
});

/**
 * Handle API response for both streaming and non-streaming.
 */
async function handleResponse(response: Response, isStreaming: boolean): Promise<Response> {
  if (isStreaming && response.ok) {
    const stream = response.body;
    if (!stream) {
      return jsonResponse({ error: "No response body" }, 500);
    }

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  const data = await response.json();

  if (!response.ok) {
    console.error("[anthropic-proxy] API error:", data);
    return jsonResponse(data, response.status);
  }

  return jsonResponse(data);
}
