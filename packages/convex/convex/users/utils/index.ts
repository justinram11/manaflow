import {
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "../../_generated/server";
import { ConvexError, v } from "convex/values";
import {
  customCtx,
  customMutation,
  customQuery,
} from "convex-helpers/server/customFunctions";
import { getLocalIdentity, isLocalAuthMode } from "../../../_shared/local-auth";

export const authQuery = customQuery(
  query,
  customCtx(async (ctx) => {
    const identity = await AuthenticationRequired({ ctx });
    return { identity };
  })
);

export const authMutation = customMutation(
  mutation,
  customCtx(async (ctx) => {
    const identity = await AuthenticationRequired({ ctx });
    return { identity };
  })
);

type Identity = NonNullable<
  Awaited<ReturnType<QueryCtx["auth"]["getUserIdentity"]>>
>;

export async function AuthenticationRequired({
  ctx,
}: {
  ctx: QueryCtx | MutationCtx | ActionCtx;
}): Promise<Identity> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    if (isLocalAuthMode()) {
      // Safety net: if JWT validation hasn't kicked in yet (e.g. during seed),
      // fall back to the legacy local identity. Log a warning so we know.
      console.warn(
        "[LocalAuth] Falling back to hardcoded local identity — JWT auth may not be configured yet"
      );
      return getLocalIdentity() as Identity;
    }
    throw new ConvexError("Not authenticated!");
  }
  return identity;
}

// Custom validator for task IDs that accepts both real and fake IDs
export const taskIdWithFake = v.union(
  v.id("tasks"),
  v.string() // Accepts fake IDs like "fake-xxx"
);
