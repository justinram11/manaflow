import { env } from "@/lib/utils/www-env";
import { stackServerAppJs } from "@/lib/utils/stack";
import { LOCAL_USERS, LOCAL_AUTH_ISSUER } from "@/lib/utils/local-jwt";
import { decodeJwt } from "jose";
import { getDb } from "@cmux/db";
import { listTeamMemberships } from "@cmux/db/queries/teams";

export async function getAccessTokenFromRequest(
  req: Request
): Promise<string | null> {
  if (env.AUTH_MODE === "local") {
    return getLocalAccessToken(req);
  }

  // First, try to get user from Stack Auth's token store (cookies)
  try {
    const user = await stackServerAppJs.getUser({ tokenStore: req });
    if (user) {
      const { accessToken } = await user.getAuthJson();
      if (accessToken) return accessToken;
    }
  } catch (_e) {
    // Fall through to try Bearer token
  }

  // Fallback: Check for Bearer token in Authorization header (for CLI clients)
  // We validate the token by passing it to the Stack Auth SDK, which
  // performs cryptographic signature verification.
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7); // Remove "Bearer " prefix

    try {
      // Validate token by having Stack Auth SDK verify it
      const user = await stackServerAppJs.getUser({
        tokenStore: { accessToken: token, refreshToken: token },
      });
      if (user) {
        return token;
      }
    } catch (_e) {
      // Token validation failed
    }
  }

  return null;
}

/**
 * Get Stack Auth user from request, supporting both cookie-based (web) and
 * Bearer token (CLI) authentication.
 *
 * For CLI clients, we pass the access token directly to the Stack Auth SDK
 * which performs cryptographic signature verification.
 */
export async function getUserFromRequest(req: Request) {
  if (env.AUTH_MODE === "local") {
    return getLocalUser(req);
  }

  // First, try cookie-based auth (standard web flow)
  try {
    const user = await stackServerAppJs.getUser({ tokenStore: req });
    if (user) {
      return user;
    }
  } catch (_e) {
    // Fall through to try Bearer token
  }

  // Fallback: Check for Bearer token in Authorization header (for CLI clients)
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7); // Remove "Bearer " prefix

    try {
      // Pass the token to Stack Auth SDK for cryptographic verification
      const user = await stackServerAppJs.getUser({
        tokenStore: { accessToken: token, refreshToken: token },
      });
      if (user) {
        return user;
      }
    } catch (_e) {
      // Bearer token auth failed
    }
  }

  return null;
}

/**
 * Extract JWT from Authorization header, decode it, and look up the local user.
 */
function getLocalAccessToken(req: Request): string | null {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice(7);
  try {
    const claims = decodeJwt(token);
    if (claims.iss !== LOCAL_AUTH_ISSUER || !claims.sub) {
      return null;
    }
    const user = LOCAL_USERS.find((u) => u.id === claims.sub);
    if (!user) return null;
    return token;
  } catch {
    return null;
  }
}

function getLocalUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice(7);
  try {
    const claims = decodeJwt(token);
    if (claims.iss !== LOCAL_AUTH_ISSUER || !claims.sub) {
      return null;
    }
    const user = LOCAL_USERS.find((u) => u.id === claims.sub);
    if (!user) return null;

    const db = getDb();
    const memberships = listTeamMemberships(db, user.id);
    const userTeams = memberships.map((m: { teams: { teamId: string; displayName: string } }) => ({
      id: m.teams.teamId,
      displayName: m.teams.displayName,
    }));

    return {
      id: user.id,
      getAuthJson: async () => ({ accessToken: token }),
      getAuthHeaders: async () => ({
        Authorization: `Bearer ${token}`,
      }) as Record<string, string>,
      listTeams: async () => userTeams,
      getConnectedAccount: async () => null,
    };
  } catch {
    return null;
  }
}
