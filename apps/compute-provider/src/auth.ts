import type { Context, Next } from "hono";
import { env } from "./env.ts";

/**
 * Bearer token middleware for compute-provider API authentication.
 *
 * Validates that the request has a valid Authorization: Bearer <token> header
 * matching the COMPUTE_PROVIDER_API_KEY environment variable.
 */
export async function bearerAuth(c: Context, next: Next): Promise<Response | void> {
  const authHeader = c.req.header("authorization");
  if (!authHeader) {
    return c.json({ code: 401, message: "Missing Authorization header" }, 401);
  }

  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return c.json({ code: 401, message: "Invalid Authorization header format" }, 401);
  }

  if (token !== env.COMPUTE_PROVIDER_API_KEY) {
    return c.json({ code: 401, message: "Invalid API key" }, 401);
  }

  return next();
}
