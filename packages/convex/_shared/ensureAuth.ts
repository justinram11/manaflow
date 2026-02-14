import type {
  GenericActionCtx,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import type { DataModel } from "../convex/_generated/dataModel";
import { getLocalIdentity, isLocalAuthMode } from "./local-auth";

export async function ensureAuth(
  ctx:
    | GenericQueryCtx<DataModel>
    | GenericMutationCtx<DataModel>
    | GenericActionCtx<DataModel>
) {
  const user = await ctx.auth.getUserIdentity();
  if (!user) {
    if (isLocalAuthMode()) {
      const localIdentity = getLocalIdentity();
      return { ...localIdentity, userId: localIdentity.subject };
    }
    throw new Error("Unauthorized");
  }

  return { ...user, userId: user.subject };
}
