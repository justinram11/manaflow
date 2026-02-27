import {
  convexClientCache,
  ConvexHttpClient,
} from "@cmux/shared/node/convex-cache";
import { getAuthToken } from "./requestContext";
import { env } from "./server-env";

const isLocalAuth = env.AUTH_MODE === "local";

// Return a Convex client bound to the current auth context
export function getConvex() {
  const auth = getAuthToken();

  if (isLocalAuth) {
    // In local mode, Convex can't validate JWTs (cloud can't reach localhost JWKS).
    // Create/cache a client without auth — Convex uses the local identity fallback.
    // Use the auth token as cache key if present, otherwise a fixed key.
    const cacheKey = auth ?? "__local__";
    const cachedClient = convexClientCache.get(cacheKey, env.NEXT_PUBLIC_CONVEX_URL);
    if (cachedClient) return cachedClient;
    const client = new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL);
    convexClientCache.set(cacheKey, env.NEXT_PUBLIC_CONVEX_URL, client);
    return client;
  }

  if (!auth) {
    throw new Error("No auth token found");
  }

  // Try to get from cache first
  const cachedClient = convexClientCache.get(auth, env.NEXT_PUBLIC_CONVEX_URL);
  if (cachedClient) {
    return cachedClient;
  }

  // Create new client and cache it
  const client = new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL);
  client.setAuth(auth);
  convexClientCache.set(auth, env.NEXT_PUBLIC_CONVEX_URL, client);
  return client;
}

export type { ConvexHttpClient };
