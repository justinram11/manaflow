import { v } from "convex/values";
import { resolveTeamIdLoose } from "../_shared/team";
import { authMutation, authQuery } from "./users/utils";

export const list = authQuery({
  args: {
    teamSlugOrId: v.string(),
    environmentId: v.id("environments"),
  },
  handler: async (ctx, args) => {
    const teamId = await resolveTeamIdLoose(ctx, args.teamSlugOrId);
    const environment = await ctx.db.get(args.environmentId);
    if (!environment || environment.teamId !== teamId) {
      throw new Error("Environment not found");
    }

    const versions = await ctx.db
      .query("environmentSnapshotVersions")
      .withIndex("by_environment_version", (q) =>
        q.eq("environmentId", args.environmentId)
      )
      .order("desc")
      .collect();

    const isIncus = environment.provider === "incus";
    return versions.map((version) => ({
      ...version,
      isActive: isIncus
        ? version.incusSnapshotId === environment.incusSnapshotId
        : version.morphSnapshotId === environment.morphSnapshotId,
    }));
  },
});

export const create = authMutation({
  args: {
    teamSlugOrId: v.string(),
    environmentId: v.id("environments"),
    morphSnapshotId: v.string(),
    incusSnapshotId: v.optional(v.string()),
    label: v.optional(v.string()),
    activate: v.optional(v.boolean()),
    maintenanceScript: v.optional(v.string()),
    devScript: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const teamId = await resolveTeamIdLoose(ctx, args.teamSlugOrId);
    const environment = await ctx.db.get(args.environmentId);
    if (!environment || environment.teamId !== teamId) {
      throw new Error("Environment not found");
    }
    const userId = ctx.identity.subject;
    if (!userId) {
      throw new Error("Authentication required");
    }

    const latest = await ctx.db
      .query("environmentSnapshotVersions")
      .withIndex("by_environment_version", (q) =>
        q.eq("environmentId", args.environmentId)
      )
      .order("desc")
      .first();

    const nextVersion = (latest?.version ?? 0) + 1;
    const createdAt = Date.now();
    const maintenanceScript =
      args.maintenanceScript ?? environment.maintenanceScript ?? undefined;
    const devScript = args.devScript ?? environment.devScript ?? undefined;

    const snapshotVersionId = await ctx.db.insert(
      "environmentSnapshotVersions",
      {
        environmentId: args.environmentId,
        teamId,
        morphSnapshotId: args.morphSnapshotId,
        incusSnapshotId: args.incusSnapshotId,
        version: nextVersion,
        createdAt,
        createdByUserId: userId,
        label: args.label,
        maintenanceScript,
        devScript,
      }
    );

    if (args.activate ?? true) {
      const patch: Record<string, unknown> = {
        morphSnapshotId: args.morphSnapshotId,
        maintenanceScript,
        devScript,
        updatedAt: Date.now(),
      };
      if (args.incusSnapshotId !== undefined) {
        patch.incusSnapshotId = args.incusSnapshotId;
      }
      await ctx.db.patch(args.environmentId, patch);
    }

    return {
      snapshotVersionId,
      version: nextVersion,
    };
  },
});

export const activate = authMutation({
  args: {
    teamSlugOrId: v.string(),
    environmentId: v.id("environments"),
    snapshotVersionId: v.id("environmentSnapshotVersions"),
  },
  handler: async (ctx, args) => {
    const teamId = await resolveTeamIdLoose(ctx, args.teamSlugOrId);
    const environment = await ctx.db.get(args.environmentId);
    if (!environment || environment.teamId !== teamId) {
      throw new Error("Environment not found");
    }

    const versionDoc = await ctx.db.get(args.snapshotVersionId);
    if (
      !versionDoc ||
      versionDoc.environmentId !== args.environmentId ||
      versionDoc.teamId !== teamId
    ) {
      throw new Error("Snapshot version not found");
    }

    const maintenanceScript =
      versionDoc.maintenanceScript ?? environment.maintenanceScript ?? undefined;
    const devScript =
      versionDoc.devScript ?? environment.devScript ?? undefined;

    const patch: Record<string, unknown> = {
      morphSnapshotId: versionDoc.morphSnapshotId,
      maintenanceScript,
      devScript,
      updatedAt: Date.now(),
    };
    if (versionDoc.incusSnapshotId !== undefined) {
      patch.incusSnapshotId = versionDoc.incusSnapshotId;
    }
    await ctx.db.patch(args.environmentId, patch);

    return {
      morphSnapshotId: versionDoc.morphSnapshotId,
      version: versionDoc.version,
    };
  },
});

export const remove = authMutation({
  args: {
    teamSlugOrId: v.string(),
    environmentId: v.id("environments"),
    snapshotVersionId: v.id("environmentSnapshotVersions"),
  },
  handler: async (ctx, args) => {
    const teamId = await resolveTeamIdLoose(ctx, args.teamSlugOrId);
    const environment = await ctx.db.get(args.environmentId);

    if (!environment || environment.teamId !== teamId) {
      throw new Error("Environment not found");
    }

    const versionDoc = await ctx.db.get(args.snapshotVersionId);

    if (
      !versionDoc ||
      versionDoc.environmentId !== args.environmentId ||
      versionDoc.teamId !== teamId
    ) {
      throw new Error("Snapshot version not found");
    }

    const isIncus = environment.provider === "incus";
    const isActive = isIncus
      ? versionDoc.incusSnapshotId === environment.incusSnapshotId
      : versionDoc.morphSnapshotId === environment.morphSnapshotId;
    if (isActive) {
      throw new Error("Cannot delete the active snapshot version.");
    }

    await ctx.db.delete(args.snapshotVersionId);
  },
});

export const findBySnapshotId = authQuery({
  args: {
    teamSlugOrId: v.string(),
    snapshotId: v.string(),
  },
  handler: async (ctx, args) => {
    const teamId = await resolveTeamIdLoose(ctx, args.teamSlugOrId);

    return await ctx.db
      .query("environmentSnapshotVersions")
      .withIndex("by_team_snapshot", (q) =>
        q.eq("teamId", teamId).eq("morphSnapshotId", args.snapshotId)
      )
      .first();
  },
});
