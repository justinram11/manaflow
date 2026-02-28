import { getDb } from "@cmux/db";
import type { DbClient } from "@cmux/db";
import { decodeJwt } from "jose";
import { getAuthToken } from "./requestContext";

export { getDb };
export type { DbClient };

/**
 * Extract the userId (JWT subject) from the current auth context.
 * In both local and cloud auth modes, the JWT `sub` claim is the userId.
 */
export function getUserId(): string {
  const token = getAuthToken();
  if (!token) {
    throw new Error("No auth token in current context");
  }
  const claims = decodeJwt(token);
  if (!claims.sub) {
    throw new Error("JWT has no sub claim");
  }
  return claims.sub;
}
