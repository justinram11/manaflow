import { eq } from "drizzle-orm";
import type { DbClient } from "../connection";
import { users } from "../schema/index";

export function getUserByUserId(db: DbClient, userId: string) {
  return db.select().from(users).where(eq(users.userId, userId)).get();
}

type OAuthProvider = { id: string; accountId: string; email?: string };

function isOAuthProvider(obj: unknown): obj is OAuthProvider {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  const idOk = typeof o.id === "string";
  const acctOk = typeof o.accountId === "string";
  const emailOk = o.email === undefined || typeof o.email === "string";
  return idOk && acctOk && emailOk;
}

/**
 * Get basic user info needed for git identity configuration.
 * Equivalent to Convex `api.users.getCurrentBasic`.
 */
export function getCurrentBasic(db: DbClient, userId: string) {
  const user = getUserByUserId(db, userId);

  const displayName = user?.displayName ?? null;
  const primaryEmail = user?.primaryEmail ?? null;

  let githubAccountId: string | null = null;
  if (Array.isArray(user?.oauthProviders)) {
    for (const prov of user.oauthProviders as unknown[]) {
      if (isOAuthProvider(prov) && prov.id.toLowerCase().includes("github")) {
        githubAccountId = prov.accountId;
        break;
      }
    }
  }

  return {
    userId,
    displayName,
    primaryEmail,
    githubAccountId,
  };
}
