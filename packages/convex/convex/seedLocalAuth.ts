import { internalMutation } from "./_generated/server";
import {
  LOCAL_USER_ID,
  LOCAL_TEAM_ID,
  LOCAL_TEAM_SLUG,
  LOCAL_USERS,
} from "../_shared/local-auth";

/**
 * Idempotent seed mutation that creates local users, teams, and memberships
 * for AUTH_MODE=local (self-hosted) deployments.
 */
export const seed = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Seed legacy local-admin user (backward compat for existing data)
    const existingLegacyUser = await ctx.db
      .query("users")
      .withIndex("by_userId", (q) => q.eq("userId", LOCAL_USER_ID))
      .first();
    if (!existingLegacyUser) {
      await ctx.db.insert("users", {
        userId: LOCAL_USER_ID,
        displayName: "Local Admin",
        primaryEmail: "admin@local",
        createdAt: now,
        updatedAt: now,
      });
      console.log("Seeded legacy local admin user");
    }

    // Seed legacy team
    const existingLegacyTeam = await ctx.db
      .query("teams")
      .withIndex("by_teamId", (q) => q.eq("teamId", LOCAL_TEAM_ID))
      .first();
    if (!existingLegacyTeam) {
      await ctx.db.insert("teams", {
        teamId: LOCAL_TEAM_ID,
        slug: LOCAL_TEAM_SLUG,
        displayName: "Local",
        createdAt: now,
        updatedAt: now,
      });
      console.log("Seeded legacy local team");
    }

    // Seed legacy membership
    const existingLegacyMembership = await ctx.db
      .query("teamMemberships")
      .withIndex("by_team_user", (q) =>
        q.eq("teamId", LOCAL_TEAM_ID).eq("userId", LOCAL_USER_ID)
      )
      .first();
    if (!existingLegacyMembership) {
      await ctx.db.insert("teamMemberships", {
        teamId: LOCAL_TEAM_ID,
        userId: LOCAL_USER_ID,
        role: "owner",
        createdAt: now,
        updatedAt: now,
      });
      console.log("Seeded legacy local team membership");
    }

    // Seed multi-user local auth users
    for (const localUser of LOCAL_USERS) {
      // Seed user
      const existingUser = await ctx.db
        .query("users")
        .withIndex("by_userId", (q) => q.eq("userId", localUser.id))
        .first();
      if (!existingUser) {
        await ctx.db.insert("users", {
          userId: localUser.id,
          displayName: localUser.displayName,
          primaryEmail: localUser.email,
          createdAt: now,
          updatedAt: now,
        });
        console.log(`Seeded local user: ${localUser.displayName}`);
      }

      // Seed team
      const existingTeam = await ctx.db
        .query("teams")
        .withIndex("by_teamId", (q) => q.eq("teamId", localUser.teamId))
        .first();
      if (!existingTeam) {
        await ctx.db.insert("teams", {
          teamId: localUser.teamId,
          slug: localUser.teamSlug,
          displayName: localUser.displayName,
          createdAt: now,
          updatedAt: now,
        });
        console.log(`Seeded local team: ${localUser.teamSlug}`);
      }

      // Seed membership for the user's own account
      const existingMembership = await ctx.db
        .query("teamMemberships")
        .withIndex("by_team_user", (q) =>
          q.eq("teamId", localUser.teamId).eq("userId", localUser.id)
        )
        .first();
      if (!existingMembership) {
        await ctx.db.insert("teamMemberships", {
          teamId: localUser.teamId,
          userId: localUser.id,
          role: "owner",
          createdAt: now,
          updatedAt: now,
        });
        console.log(`Seeded local team membership: ${localUser.displayName} → ${localUser.teamSlug}`);
      }

      // Also add the legacy local-admin to this team so the Convex identity fallback
      // (which uses LOCAL_USER_ID) can access all local teams.
      const legacyAdminMembership = await ctx.db
        .query("teamMemberships")
        .withIndex("by_team_user", (q) =>
          q.eq("teamId", localUser.teamId).eq("userId", LOCAL_USER_ID)
        )
        .first();
      if (!legacyAdminMembership) {
        await ctx.db.insert("teamMemberships", {
          teamId: localUser.teamId,
          userId: LOCAL_USER_ID,
          role: "owner",
          createdAt: now,
          updatedAt: now,
        });
        console.log(`Seeded legacy admin membership in team: ${localUser.teamSlug}`);
      }
    }
  },
});
