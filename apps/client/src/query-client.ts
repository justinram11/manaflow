import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Poll frequently for near-real-time feel (replaces Convex WebSocket subscriptions)
      refetchInterval: 3000,
      // Don't refetch on window focus since we already poll
      refetchOnWindowFocus: false,
      staleTime: 2000,
    },
  },
});

// Subscribe to query cache updates to log errors centrally
queryClient.getQueryCache().subscribe((event) => {
  try {
    const query = event.query;
    if (!query) return;
    const state = query.state as { status?: string; error?: unknown };
    if (state.status === "error") {
      console.error("[ReactQueryError]", {
        queryKey: query.queryKey,
        error: state.error,
      });
    }
  } catch (e) {
    console.error("[ReactQueryError] Failed to log query error", e);
  }
});

// Attach global cmux event listeners outside React to avoid Provider effects.
try {
  if (typeof window !== "undefined") {
    const w = window as Window & { __cmuxGithubListenerAttached?: boolean };
    if (!w.__cmuxGithubListenerAttached && w.cmux?.on) {
      const off = w.cmux.on("github-connect-complete", () => {
        try {
          // Refresh data that depends on GitHub connection state
          void queryClient.invalidateQueries();
        } catch (_e) {
          console.error(
            "[QueryClient] Failed to invalidate on github-connect-complete"
          );
        }
      });
      // Mark as attached to avoid duplicate subscriptions under HMR
      w.__cmuxGithubListenerAttached = true;
      void off;
    }
  }
} catch {
  // Non-fatal if cmux or window is not available (e.g., SSR, tests)
}
