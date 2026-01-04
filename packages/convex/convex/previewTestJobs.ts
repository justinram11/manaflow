/**
 * Preview Test Jobs - for testing preview.new jobs without GitHub integration
 *
 * This module provides functions to create and run preview jobs for testing purposes.
 * Unlike regular preview jobs, these don't post GitHub comments or use GitHub API for reactions.
 */

import { v } from "convex/values";
import { getTeamId } from "../_shared/team";
import { internal } from "./_generated/api";
import type { Id, Doc } from "./_generated/dataModel";
import { authMutation, authQuery } from "./users/utils";
import { action } from "./_generated/server";

/**
 * Parse a GitHub PR URL to extract owner, repo, and PR number
 */
function parsePrUrl(prUrl: string): {
  owner: string;
  repo: string;
  prNumber: number;
  repoFullName: string;
} | null {
  // Handle GitHub PR URLs like:
  // https://github.com/owner/repo/pull/123
  // https://www.github.com/owner/repo/pull/123
  const match = prUrl.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i
  );
  if (!match) {
    return null;
  }
  const [, owner, repo, prNumberStr] = match;
  if (!owner || !repo || !prNumberStr) {
    return null;
  }
  return {
    owner,
    repo,
    prNumber: parseInt(prNumberStr, 10),
    repoFullName: `${owner}/${repo}`.toLowerCase(),
  };
}

/**
 * Create a test preview run from a PR URL.
 * This creates a preview run WITHOUT repoInstallationId so GitHub comments are skipped.
 */
export const createTestRun = authMutation({
  args: {
    teamSlugOrId: v.string(),
    prUrl: v.string(),
  },
  handler: async (ctx, args): Promise<{
    previewRunId: Id<"previewRuns">;
    taskId: Id<"tasks">;
    taskRunId: Id<"taskRuns">;
    prNumber: number;
    repoFullName: string;
  }> => {
    const teamId = await getTeamId(ctx, args.teamSlugOrId);

    // Parse PR URL
    const parsed = parsePrUrl(args.prUrl);
    if (!parsed) {
      throw new Error(
        `Invalid PR URL format. Expected: https://github.com/owner/repo/pull/123`
      );
    }

    const { prNumber, repoFullName } = parsed;

    // Find the preview config for this repo
    const config = await ctx.db
      .query("previewConfigs")
      .withIndex("by_team_repo", (q) =>
        q.eq("teamId", teamId).eq("repoFullName", repoFullName)
      )
      .first();

    if (!config) {
      throw new Error(
        `No preview configuration found for ${repoFullName}. ` +
          `Please create one first via the cmux UI at /preview.`
      );
    }

    // Verify the GitHub installation is still active
    const installation = await ctx.db
      .query("providerConnections")
      .withIndex("by_installationId", (q) =>
        q.eq("installationId", config.repoInstallationId)
      )
      .first();

    if (!installation) {
      throw new Error(
        `GitHub App installation not found. Please reconnect your GitHub App in Team Settings.`
      );
    }

    if (installation.isActive === false) {
      throw new Error(
        `GitHub App installation for ${installation.accountLogin ?? "this account"} is no longer active. ` +
          `Please reconnect the GitHub App in your GitHub settings or Team Settings.`
      );
    }

    // Fetch PR metadata from GitHub (without posting anything)
    // For test runs, we'll use placeholder values if we can't fetch
    const headSha = `test-${Date.now()}`;
    const prTitle = `Test PR #${prNumber}`;

    const now = Date.now();

    // Create preview run WITHOUT repoInstallationId - this skips GitHub comments
    const runId = await ctx.db.insert("previewRuns", {
      previewConfigId: config._id,
      teamId,
      repoFullName,
      // Explicitly NOT setting repoInstallationId - this skips GitHub comment posting
      repoInstallationId: undefined,
      prNumber,
      prUrl: args.prUrl,
      prTitle,
      prDescription: undefined,
      headSha,
      baseSha: undefined,
      headRef: undefined,
      headRepoFullName: undefined,
      headRepoCloneUrl: undefined,
      status: "pending",
      stateReason: "Test preview run",
      dispatchedAt: undefined,
      startedAt: undefined,
      completedAt: undefined,
      screenshotSetId: undefined,
      githubCommentUrl: undefined,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.patch(config._id, {
      lastRunAt: now,
      updatedAt: now,
    });

    // Get user ID from auth context
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Authentication required");
    }
    const userId = config.createdByUserId ?? "system";

    // Create task for this preview run
    const taskId: Id<"tasks"> = await ctx.runMutation(
      internal.tasks.createForPreview,
      {
        teamId,
        userId,
        previewRunId: runId,
        repoFullName,
        prNumber,
        prUrl: args.prUrl,
        headSha,
        baseBranch: config.repoDefaultBranch,
      }
    );

    // Create taskRun
    const { taskRunId }: { taskRunId: Id<"taskRuns"> } = await ctx.runMutation(
      internal.taskRuns.createForPreview,
      {
        taskId,
        teamId,
        userId,
        prUrl: args.prUrl,
        environmentId: config.environmentId,
        newBranch: undefined,
      }
    );

    // Link the taskRun to the preview run
    await ctx.runMutation(internal.previewRuns.linkTaskRun, {
      previewRunId: runId,
      taskRunId,
    });

    return {
      previewRunId: runId,
      taskId,
      taskRunId,
      prNumber,
      repoFullName,
    };
  },
});

/**
 * Dispatch a test preview job (start the actual screenshot capture)
 */
export const dispatchTestJob = action({
  args: {
    teamSlugOrId: v.string(),
    previewRunId: v.id("previewRuns"),
  },
  handler: async (ctx, args) => {
    // Manual auth check for actions (no authAction wrapper available)
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Authentication required");
    }

    // Get the preview run first
    const previewRun = await ctx.runQuery(internal.previewRuns.getById, {
      id: args.previewRunId,
    });

    if (!previewRun) {
      throw new Error("Preview run not found");
    }

    // Verify the user is a member of the team that owns this run
    const { isMember } = await ctx.runQuery(internal.teams.checkTeamMembership, {
      teamId: previewRun.teamId,
      userId: identity.subject,
    });
    if (!isMember) {
      throw new Error("Forbidden: Not a member of this team");
    }

    // Mark as dispatched
    await ctx.runMutation(internal.previewRuns.markDispatched, {
      previewRunId: args.previewRunId,
    });

    // Schedule the job to run
    await ctx.scheduler.runAfter(0, internal.preview_jobs.executePreviewJob, {
      previewRunId: args.previewRunId,
    });

    return { dispatched: true };
  },
});

/**
 * List test preview runs for a team (runs without repoInstallationId)
 */
export const listTestRuns = authQuery({
  args: {
    teamSlugOrId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const teamId = await getTeamId(ctx, args.teamSlugOrId);
    const take = Math.max(1, Math.min(args.limit ?? 50, 100));

    // Get recent preview runs for the team
    const runs = await ctx.db
      .query("previewRuns")
      .withIndex("by_team_created", (q) => q.eq("teamId", teamId))
      .order("desc")
      .take(take * 2);

    // Filter to only test runs (those without repoInstallationId)
    const testRuns = runs
      .filter((run) => !run.repoInstallationId)
      .slice(0, take);

    // Enrich with config info and screenshot data
    const enrichedRuns = await Promise.all(
      testRuns.map(async (run) => {
        const config = await ctx.db.get(run.previewConfigId);

        let screenshotSet: Doc<"taskRunScreenshotSets"> | null = null;
        if (run.screenshotSetId) {
          screenshotSet = await ctx.db.get(run.screenshotSetId);
        }

        // Get image URLs if we have screenshots
        let imagesWithUrls: Array<{
          storageId: string;
          mimeType: string;
          fileName?: string;
          description?: string;
          url?: string;
        }> = [];

        if (screenshotSet?.images) {
          imagesWithUrls = await Promise.all(
            screenshotSet.images.map(async (img) => {
              const url = await ctx.storage.getUrl(img.storageId);
              return {
                storageId: img.storageId,
                mimeType: img.mimeType,
                fileName: img.fileName,
                description: img.description,
                url: url ?? undefined,
              };
            })
          );
        }

        return {
          _id: run._id,
          prNumber: run.prNumber,
          prUrl: run.prUrl,
          prTitle: run.prTitle,
          repoFullName: run.repoFullName,
          headSha: run.headSha,
          status: run.status,
          stateReason: run.stateReason,
          taskRunId: run.taskRunId,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          dispatchedAt: run.dispatchedAt,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          configRepoFullName: config?.repoFullName,
          screenshotSet: screenshotSet
            ? {
                _id: screenshotSet._id,
                status: screenshotSet.status,
                hasUiChanges: screenshotSet.hasUiChanges,
                capturedAt: screenshotSet.capturedAt,
                error: screenshotSet.error,
                images: imagesWithUrls,
              }
            : null,
        };
      })
    );

    return enrichedRuns;
  },
});

/**
 * Get detailed info about a test preview run including screenshots
 */
export const getTestRunDetails = authQuery({
  args: {
    teamSlugOrId: v.string(),
    previewRunId: v.id("previewRuns"),
  },
  handler: async (ctx, args) => {
    const teamId = await getTeamId(ctx, args.teamSlugOrId);

    const run = await ctx.db.get(args.previewRunId);
    if (!run) {
      throw new Error("Preview run not found");
    }

    if (run.teamId !== teamId) {
      throw new Error("Preview run does not belong to this team");
    }

    const config = await ctx.db.get(run.previewConfigId);

    let screenshotSet: Doc<"taskRunScreenshotSets"> | null = null;
    if (run.screenshotSetId) {
      screenshotSet = await ctx.db.get(run.screenshotSetId);
    }

    // Get image URLs if we have screenshots
    let imagesWithUrls: Array<{
      storageId: string;
      mimeType: string;
      fileName?: string;
      description?: string;
      url?: string;
    }> = [];

    if (screenshotSet?.images) {
      imagesWithUrls = await Promise.all(
        screenshotSet.images.map(async (img) => {
          const url = await ctx.storage.getUrl(img.storageId);
          return {
            storageId: img.storageId,
            mimeType: img.mimeType,
            fileName: img.fileName,
            description: img.description,
            url: url ?? undefined,
          };
        })
      );
    }

    // Get taskRun for trajectory link
    let taskRun: Doc<"taskRuns"> | null = null;
    if (run.taskRunId) {
      taskRun = await ctx.db.get(run.taskRunId);
    }

    return {
      _id: run._id,
      prNumber: run.prNumber,
      prUrl: run.prUrl,
      prTitle: run.prTitle,
      prDescription: run.prDescription,
      repoFullName: run.repoFullName,
      headSha: run.headSha,
      baseSha: run.baseSha,
      headRef: run.headRef,
      status: run.status,
      stateReason: run.stateReason,
      taskRunId: run.taskRunId,
      taskId: taskRun?.taskId,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      dispatchedAt: run.dispatchedAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      configRepoFullName: config?.repoFullName,
      environmentId: config?.environmentId,
      screenshotSet: screenshotSet
        ? {
            _id: screenshotSet._id,
            status: screenshotSet.status,
            hasUiChanges: screenshotSet.hasUiChanges,
            capturedAt: screenshotSet.capturedAt,
            error: screenshotSet.error,
            images: imagesWithUrls,
          }
        : null,
    };
  },
});

/**
 * Check if a team has GitHub access to a repository.
 * This validates that:
 * 1. A preview config exists for the repo
 * 2. The associated GitHub installation is active
 * Returns access status and helpful error messages for the UI.
 */
export const checkRepoAccess = authQuery({
  args: {
    teamSlugOrId: v.string(),
    prUrl: v.string(),
  },
  handler: async (ctx, args): Promise<{
    hasAccess: boolean;
    hasConfig: boolean;
    hasActiveInstallation: boolean;
    repoFullName: string | null;
    errorCode: "invalid_url" | "no_config" | "no_installation" | "installation_inactive" | null;
    errorMessage: string | null;
    suggestedAction: string | null;
  }> => {
    // Parse PR URL
    const parsed = parsePrUrl(args.prUrl);
    if (!parsed) {
      return {
        hasAccess: false,
        hasConfig: false,
        hasActiveInstallation: false,
        repoFullName: null,
        errorCode: "invalid_url",
        errorMessage: "Invalid PR URL format",
        suggestedAction: "Enter a valid GitHub PR URL (e.g., https://github.com/owner/repo/pull/123)",
      };
    }

    const { repoFullName } = parsed;
    const teamId = await getTeamId(ctx, args.teamSlugOrId);

    // Check if preview config exists for this repo
    const config = await ctx.db
      .query("previewConfigs")
      .withIndex("by_team_repo", (q) =>
        q.eq("teamId", teamId).eq("repoFullName", repoFullName)
      )
      .first();

    if (!config) {
      // No config - check if team has ANY GitHub installation
      const installations = await ctx.db
        .query("providerConnections")
        .withIndex("by_team", (q) => q.eq("teamId", teamId))
        .collect();

      const hasAnyInstallation = installations.some((i) => i.isActive !== false);

      return {
        hasAccess: false,
        hasConfig: false,
        hasActiveInstallation: hasAnyInstallation,
        repoFullName,
        errorCode: "no_config",
        errorMessage: `No preview configuration found for ${repoFullName}`,
        suggestedAction: hasAnyInstallation
          ? `Add a preview configuration for ${repoFullName} in the Preview settings`
          : "Connect your GitHub account to this team first, then add a preview configuration",
      };
    }

    // Config exists - check if the installation is active
    const installation = await ctx.db
      .query("providerConnections")
      .withIndex("by_installationId", (q) =>
        q.eq("installationId", config.repoInstallationId)
      )
      .first();

    if (!installation) {
      return {
        hasAccess: false,
        hasConfig: true,
        hasActiveInstallation: false,
        repoFullName,
        errorCode: "no_installation",
        errorMessage: "GitHub App installation not found",
        suggestedAction: "Reconnect your GitHub App installation in Team Settings",
      };
    }

    if (installation.isActive === false) {
      return {
        hasAccess: false,
        hasConfig: true,
        hasActiveInstallation: false,
        repoFullName,
        errorCode: "installation_inactive",
        errorMessage: `GitHub App installation for ${installation.accountLogin ?? "this account"} is no longer active`,
        suggestedAction: "Reconnect the GitHub App in your GitHub settings or Team Settings",
      };
    }

    // All checks passed
    return {
      hasAccess: true,
      hasConfig: true,
      hasActiveInstallation: true,
      repoFullName,
      errorCode: null,
      errorMessage: null,
      suggestedAction: null,
    };
  },
});

/**
 * Delete a test preview run
 */
export const deleteTestRun = authMutation({
  args: {
    teamSlugOrId: v.string(),
    previewRunId: v.id("previewRuns"),
  },
  handler: async (ctx, args) => {
    const teamId = await getTeamId(ctx, args.teamSlugOrId);

    const run = await ctx.db.get(args.previewRunId);
    if (!run) {
      throw new Error("Preview run not found");
    }

    if (run.teamId !== teamId) {
      throw new Error("Preview run does not belong to this team");
    }

    // Only allow deleting test runs (those without repoInstallationId)
    if (run.repoInstallationId) {
      throw new Error("Cannot delete production preview runs");
    }

    await ctx.db.delete(args.previewRunId);

    return { deleted: true };
  },
});
