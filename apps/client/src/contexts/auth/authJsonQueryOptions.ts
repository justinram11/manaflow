import { env } from "@/client-env";
import { cachedGetUser } from "@/lib/cachedGetUser";
import { stackClientApp } from "@/lib/stack";
import { queryOptions } from "@tanstack/react-query";

export type AuthJson = { accessToken: string | null } | null;

export interface StackUserLike {
  getAuthJson: () => Promise<{ accessToken: string | null }>;
}

// Refresh every 9 minutes to beat the ~10 minute Stack access token expiry window
export const defaultAuthJsonRefreshInterval = 9 * 60 * 1000;
const missingAuthJsonRefreshInterval = 2 * 1000;

// For local JWT auth: refresh every 50 minutes to beat the 1hr expiry
const localAuthRefreshInterval = 50 * 60 * 1000;

export function authJsonQueryOptions() {
  return queryOptions<AuthJson>({
    queryKey: ["authJson"],
    queryFn: async () => {
      if (env.NEXT_PUBLIC_AUTH_MODE === "local") {
        const jwt = localStorage.getItem("cmux-local-jwt");
        return jwt ? { accessToken: jwt } : null;
      }
      const user = await cachedGetUser(stackClientApp);
      if (!user) return null;
      const authJson = await user.getAuthJson();
      return authJson ?? null;
    },
    refetchInterval: (query) => {
      if (env.NEXT_PUBLIC_AUTH_MODE === "local") {
        const jwt = query.state.data?.accessToken;
        return jwt ? localAuthRefreshInterval : missingAuthJsonRefreshInterval;
      }
      const accessToken = query.state.data?.accessToken;
      return accessToken
        ? defaultAuthJsonRefreshInterval
        : missingAuthJsonRefreshInterval;
    },
    refetchIntervalInBackground: true,
  });
}
