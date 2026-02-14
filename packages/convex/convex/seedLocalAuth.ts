import { internalMutation } from "./_generated/server";
import {
  LOCAL_USER_ID,
  LOCAL_TEAM_ID,
  LOCAL_TEAM_SLUG,
} from "../_shared/local-auth";

/**
 * Idempotent seed mutation that creates a local admin user, team, and membership
 * for AUTH_MODE=local (self-hosted) deployments.
 */
export const seed = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Seed user
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_userId", (q) => q.eq("userId", LOCAL_USER_ID))
      .first();
    if (!existingUser) {
      await ctx.db.insert("users", {
        userId: LOCAL_USER_ID,
        displayName: "Local Admin",
        primaryEmail: "admin@local",
        createdAt: now,
        updatedAt: now,
      });
      console.log("Seeded local admin user");
    }

    // Seed team
    const existingTeam = await ctx.db
      .query("teams")
      .withIndex("by_teamId", (q) => q.eq("teamId", LOCAL_TEAM_ID))
      .first();
    if (!existingTeam) {
      await ctx.db.insert("teams", {
        teamId: LOCAL_TEAM_ID,
        slug: LOCAL_TEAM_SLUG,
        displayName: "Local",
        createdAt: now,
        updatedAt: now,
      });
      console.log("Seeded local team");
    }

    // Seed team membership
    const existingMembership = await ctx.db
      .query("teamMemberships")
      .withIndex("by_team_user", (q) =>
        q.eq("teamId", LOCAL_TEAM_ID).eq("userId", LOCAL_USER_ID)
      )
      .first();
    if (!existingMembership) {
      await ctx.db.insert("teamMemberships", {
        teamId: LOCAL_TEAM_ID,
        userId: LOCAL_USER_ID,
        role: "owner",
        createdAt: now,
        updatedAt: now,
      });
      console.log("Seeded local team membership");
    }
  },
});
