import { getUserFromRequest } from "@/lib/utils/auth";
import { env } from "@/lib/utils/www-env";
import { getDb } from "@cmux/db";
import { createInstallState } from "@cmux/db/mutations/repos";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";
import { githubPrivateKey } from "../utils/githubPrivateKey";

export const githubInstallStateRouter = new OpenAPIHono();

const RequestBody = z
  .object({
    teamSlugOrId: z
      .string()
      .min(1)
      .openapi({ description: "Team slug or UUID" }),
    returnUrl: z
      .string()
      .url()
      .optional()
      .openapi({
        description:
          "Optional URL to redirect to after installation (web flows)",
      }),
  })
  .openapi("GithubInstallStateRequest");

const ResponseBody = z
  .object({
    state: z.string(),
    installUrl: z.string().url(),
  })
  .openapi("GithubInstallStateResponse");

function base64urlFromBytes(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const x = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += abc[(x >> 18) & 63];
    out += abc[(x >> 12) & 63];
    out += abc[(x >> 6) & 63];
    out += abc[x & 63];
  }
  if (i + 1 === bytes.length) {
    const x = bytes[i]! << 16;
    out += abc[(x >> 18) & 63];
    out += abc[(x >> 12) & 63];
  } else if (i < bytes.length) {
    const x = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += abc[(x >> 18) & 63];
    out += abc[(x >> 12) & 63];
    out += abc[(x >> 6) & 63];
  }
  return out;
}

async function hmacSha256(secret: string, payload: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign("HMAC", key, enc.encode(payload));
}

githubInstallStateRouter.openapi(
  createRoute({
    method: "post" as const,
    path: "/integrations/github/install-state",
    tags: ["Integrations"],
    summary: "Generate a signed install state token for GitHub App installation",
    request: {
      body: {
        content: {
          "application/json": {
            schema: RequestBody,
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "OK",
        content: {
          "application/json": {
            schema: ResponseBody,
          },
        },
      },
      401: { description: "Unauthorized" },
      403: { description: "Forbidden" },
      500: { description: "Server error" },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) {
      return c.text("Unauthorized", 401);
    }

    const body = c.req.valid("json");

    try {
      const installStateSecret = env.INSTALL_STATE_SECRET;
      if (!installStateSecret) {
        return c.text("INSTALL_STATE_SECRET is not configured", 500);
      }

      const db = getDb();
      const { teamId, nonce, iat, exp } = createInstallState(db, {
        teamSlugOrId: body.teamSlugOrId,
        userId: user.id,
        returnUrl: body.returnUrl,
      });

      // Build signed token matching the Convex mintInstallState format
      const payloadObj = {
        ver: 1,
        teamId,
        userId: user.id,
        iat,
        exp,
        nonce,
        ...(body.returnUrl ? { returnUrl: body.returnUrl } : {}),
      };
      const payload = JSON.stringify(payloadObj);
      const sigBuf = await hmacSha256(installStateSecret, payload);
      const payloadB64 = base64urlFromBytes(new TextEncoder().encode(payload));
      const sigB64 = base64urlFromBytes(sigBuf);
      const token = `v2.${payloadB64}.${sigB64}`;

      const octokit = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: env.CMUX_GITHUB_APP_ID,
          privateKey: githubPrivateKey,
        },
      });

      const appMeta = await octokit.request("GET /app");
      const appSlug =
        appMeta.data?.slug || process.env.NEXT_PUBLIC_GITHUB_APP_SLUG || null;
      if (!appSlug) {
        return c.text("GitHub App slug is not configured", 500);
      }

      const installUrl = new URL(
        `https://github.com/apps/${appSlug}/installations/new`,
      );
      installUrl.searchParams.set("state", token);

      return c.json({ state: token, installUrl: installUrl.toString() });
    } catch (error) {
      console.error("[githubInstallState] Failed to mint install state", error);
      const message = error instanceof Error ? error.message : "Unknown error";

      if (message.includes("Forbidden") || message.includes("Unknown team") || message.includes("Team not found")) {
        return c.text("Forbidden", 403);
      }

      return c.text("Internal server error", 500);
    }
  },
);
