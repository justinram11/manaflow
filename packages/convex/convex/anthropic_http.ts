import { httpAction } from "./_generated/server";
import { getWorkerAuth } from "./users/utils/getWorkerAuth";
import { env } from "../_shared/convex-env";

/**
 * Direct Vertex AI URL (bypassing Cloudflare for now to debug auth).
 */
const VERTEX_AI_BASE_URL =
  "https://us-east5-aiplatform.googleapis.com/v1/projects/manaflow-420907/locations/us-east5/publishers/anthropic/models";

const JSON_HEADERS = {
  "Content-Type": "application/json",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
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
 * Base64URL encode (no padding)
 */
function base64UrlEncode(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Convert PEM private key to CryptoKey for signing
 */
async function importPrivateKey(pemKey: string): Promise<CryptoKey> {
  // Remove PEM headers and decode base64
  const pemContents = pemKey
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");

  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

/**
 * Generate a Google OAuth2 access token using service account credentials.
 */
async function getGoogleAccessToken(): Promise<string> {
  const privateKey = env.VERTEX_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("VERTEX_PRIVATE_KEY environment variable is not set");
  }

  const formattedKey = formatPrivateKey(privateKey);
  const clientEmail = "vertex-express@manaflow-420907.iam.gserviceaccount.com";
  const tokenUrl = "https://oauth2.googleapis.com/token";
  const scope = "https://www.googleapis.com/auth/cloud-platform";

  const now = Math.floor(Date.now() / 1000);
  const expiry = now + 3600; // 1 hour

  // Create JWT header and claims
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: clientEmail,
    sub: clientEmail,
    aud: tokenUrl,
    iat: now,
    exp: expiry,
    scope: scope,
  };

  // Encode header and claims
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaims = base64UrlEncode(JSON.stringify(claims));
  const signatureInput = `${encodedHeader}.${encodedClaims}`;

  // Sign with private key
  const cryptoKey = await importPrivateKey(formattedKey);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signatureInput)
  );

  const encodedSignature = base64UrlEncode(new Uint8Array(signature));
  const jwt = `${signatureInput}.${encodedSignature}`;

  // Exchange JWT for access token
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get access token: ${error}`);
  }

  const data = await response.json() as { access_token: string };
  return data.access_token;
}

const TEMPORARY_DISABLE_AUTH = true;

const hardCodedApiKey = "sk_placeholder_cmux_anthropic_api_key";

function getIsOAuthToken(token: string) {
  return token.includes("sk-ant-oat");
}

/**
 * Supported Claude models on Vertex AI.
 * These short names work directly with Vertex AI.
 */
const SUPPORTED_VERTEX_MODELS = [
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;

/**
 * Map model names to Vertex AI format.
 * For now, we just pass through supported models.
 */
function mapToVertexModel(model: string): string {
  // Pass through supported models
  if (SUPPORTED_VERTEX_MODELS.includes(model as typeof SUPPORTED_VERTEX_MODELS[number])) {
    return model;
  }
  // Default fallback
  return model;
}

/**
 * HTTP action to proxy Anthropic API requests to Vertex AI via Cloudflare.
 * This endpoint is called by Claude Code running in sandboxes.
 */
export const anthropicProxy = httpAction(async (_ctx, req) => {
  const startTime = Date.now();

  // Try to extract token payload for tracking
  const workerAuth = await getWorkerAuth(req, {
    loggerPrefix: "[anthropic-proxy]",
  });

  if (!TEMPORARY_DISABLE_AUTH && !workerAuth) {
    console.error("[anthropic-proxy] Auth error: Missing or invalid token");
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  try {
    // Get query parameters
    const url = new URL(req.url);
    const beta = url.searchParams.get("beta");

    const xApiKeyHeader = req.headers.get("x-api-key");
    const authorizationHeader = req.headers.get("authorization");
    const isOAuthToken = getIsOAuthToken(
      xApiKeyHeader || authorizationHeader || ""
    );
    const useOriginalApiKey =
      !isOAuthToken &&
      xApiKeyHeader !== hardCodedApiKey &&
      authorizationHeader !== hardCodedApiKey;

    const body = await req.json();

    // Build Vertex AI URL with model and stream suffix
    const requestedModel = body.model ?? "claude-opus-4-5";
    const vertexModel = mapToVertexModel(requestedModel);
    const streamSuffix = body.stream ? ":streamRawPredict" : ":rawPredict";
    const vertexUrl = `${VERTEX_AI_BASE_URL}/${vertexModel}${streamSuffix}`;

    console.log("[anthropic-proxy] Model mapping:", requestedModel, "->", vertexModel);

    // Get Google access token
    const accessToken = await getGoogleAccessToken();
    console.log("[anthropic-proxy] Got access token, length:", accessToken.length);

    // Build headers for Vertex AI
    const headers: Record<string, string> =
      useOriginalApiKey && !TEMPORARY_DISABLE_AUTH
        ? (() => {
            const filtered: Record<string, string> = {};
            req.headers.forEach((value, key) => {
              filtered[key] = value;
            });
            return filtered;
          })()
        : {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          };

    // Add beta header if beta param is present
    if (!useOriginalApiKey) {
      if (beta === "true") {
        headers["anthropic-beta"] = "messages-2023-12-15";
      }
    }

    console.log("[anthropic-proxy] Proxying to Vertex AI:", vertexUrl);

    // Add anthropic_version required by Vertex AI and remove model (it's in URL)
    const { model: _model, ...bodyWithoutModel } = body;
    const vertexBody = {
      ...bodyWithoutModel,
      anthropic_version: "vertex-2023-10-16",
    };

    const response = await fetch(vertexUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(vertexBody),
    });

    console.log("[anthropic-proxy] Vertex AI response status:", response.status);

    // Handle streaming responses
    if (body.stream && response.ok) {
      console.log(
        "[anthropic-proxy] Streaming response, latency:",
        Date.now() - startTime,
        "ms"
      );

      // Pass through the SSE stream
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

    // Handle non-streaming responses
    const data = await response.json();

    if (!response.ok) {
      console.error("[anthropic-proxy] Vertex AI error:", data);
      return jsonResponse(data, response.status);
    }

    console.log(
      "[anthropic-proxy] Success, latency:",
      Date.now() - startTime,
      "ms"
    );

    return jsonResponse(data);
  } catch (error) {
    console.error("[anthropic-proxy] Error:", error);
    return jsonResponse(
      { error: "Failed to proxy request to Vertex AI" },
      500
    );
  }
});
