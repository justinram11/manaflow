import {
  convexClientCache,
  ConvexHttpClient,
} from "@cmux/shared/node/convex-cache";
import { getAuthToken } from "./requestContext";
import { env } from "./server-env";

const isLocalAuth = env.AUTH_MODE === "local";
const LOCAL_CACHE_KEY = "__local__";

// Return a Convex client bound to the current auth context
export function getConvex() {
  if (isLocalAuth) {
    const cachedClient = convexClientCache.get(
      LOCAL_CACHE_KEY,
      env.NEXT_PUBLIC_CONVEX_URL,
    );
    if (cachedClient) return cachedClient;
    const client = new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL);
    convexClientCache.set(LOCAL_CACHE_KEY, env.NEXT_PUBLIC_CONVEX_URL, client);
    return client;
  }

  const auth = getAuthToken();
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
