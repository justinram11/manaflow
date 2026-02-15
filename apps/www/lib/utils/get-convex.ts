import {
  convexClientCache,
  ConvexHttpClient,
} from "@cmux/shared/node/convex-cache";
import { env } from "./www-env";

const LOCAL_AUTH_TOKEN = "local-auth-token";

// Keep a singleton for local auth mode (no JWT, no caching needed)
let localConvexClient: ConvexHttpClient | null = null;

export function getConvex({ accessToken }: { accessToken: string }) {
  // In local auth mode, don't setAuth (Convex functions check isLocalAuthMode() server-side)
  if (accessToken === LOCAL_AUTH_TOKEN) {
    if (!localConvexClient) {
      localConvexClient = new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL);
    }
    return localConvexClient;
  }

  // Try to get from cache first
  const cachedClient = convexClientCache.get(
    accessToken,
    env.NEXT_PUBLIC_CONVEX_URL
  );
  if (cachedClient) {
    return cachedClient;
  }

  // Create new client and cache it
  const client = new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL);
  client.setAuth(accessToken);
  convexClientCache.set(accessToken, env.NEXT_PUBLIC_CONVEX_URL, client);
  return client;
}
