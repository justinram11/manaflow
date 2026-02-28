// Stub: Convex has been replaced with SQLite.
// Code review features that depend on Convex are temporarily disabled.

const disabledProxy = new Proxy({} as Record<string, unknown>, {
  get(_target, prop) {
    if (typeof prop === "string") {
      return async (..._args: unknown[]) => {
        throw new Error(
          `Convex has been removed. Called .${prop}() but code review features are temporarily disabled.`
        );
      };
    }
    return undefined;
  },
});

export function getConvex(_opts: { accessToken: string }) {
  return disabledProxy as { query: (...args: unknown[]) => Promise<unknown>; mutation: (...args: unknown[]) => Promise<unknown> };
}
