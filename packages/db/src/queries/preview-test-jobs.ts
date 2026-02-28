import { eq, and, desc } from "drizzle-orm";
import type { DbClient } from "../connection";
import {
  previewConfigs,
  previewRuns,
  providerConnections,
  taskRuns,
  taskRunScreenshotSets,
} from "../schema/index";
import { resolveTeamId } from "./teams";

/**
 * Parse a GitHub PR URL to extract owner, repo, and PR number
 */
function parsePrUrl(prUrl: string): {
  owner: string;
  repo: string;
  prNumber: number;
  repoFullName: string;
} | null {
  const match = prUrl.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i,
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

export { parsePrUrl };

/**
 * Check if a team has GitHub access to a repository.
 * Equivalent to Convex `api.previewTestJobs.checkRepoAccess`.
 */
export function checkRepoAccess(
  db: DbClient,
  opts: { teamSlugOrId: string; prUrl: string },
): {
  hasAccess: boolean;
  hasConfig: boolean;
  hasActiveInstallation: boolean;
  repoFullName: string | null;
  errorCode:
    | "invalid_url"
    | "no_config"
    | "no_installation"
    | "installation_inactive"
    | null;
  errorMessage: string | null;
  suggestedAction: string | null;
} {
  const parsed = parsePrUrl(opts.prUrl);
  if (!parsed) {
    return {
      hasAccess: false,
      hasConfig: false,
      hasActiveInstallation: false,
      repoFullName: null,
      errorCode: "invalid_url",
      errorMessage: "Invalid PR URL format",
      suggestedAction:
        "Enter a valid GitHub PR URL (e.g., https://github.com/owner/repo/pull/123)",
    };
  }

  const { repoFullName } = parsed;
  const teamId = resolveTeamId(db, opts.teamSlugOrId);

  // Check if preview config exists for this repo
  const config = db
    .select()
    .from(previewConfigs)
    .where(
      and(
        eq(previewConfigs.teamId, teamId),
        eq(previewConfigs.repoFullName, repoFullName),
      ),
    )
    .get();

  if (!config) {
    // No config - check if team has ANY GitHub installation
    const installations = db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.teamId, teamId))
      .all();

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
  const configInstallationId = config.repoInstallationId;
  if (!configInstallationId) {
    return {
      hasAccess: true,
      hasConfig: true,
      hasActiveInstallation: false,
      repoFullName,
      errorCode: null,
      errorMessage: null,
      suggestedAction: null,
    };
  }

  const installation = db
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.installationId, configInstallationId))
    .get();

  if (!installation) {
    return {
      hasAccess: false,
      hasConfig: true,
      hasActiveInstallation: false,
      repoFullName,
      errorCode: "no_installation",
      errorMessage: "GitHub App installation not found",
      suggestedAction:
        "Reconnect your GitHub App installation in Team Settings",
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
      suggestedAction:
        "Reconnect the GitHub App in your GitHub settings or Team Settings",
    };
  }

  return {
    hasAccess: true,
    hasConfig: true,
    hasActiveInstallation: true,
    repoFullName,
    errorCode: null,
    errorMessage: null,
    suggestedAction: null,
  };
}

interface ScreenshotImage {
  storageId: string;
  mimeType: string;
  fileName?: string;
  description?: string;
}

interface ScreenshotVideo {
  storageId: string;
  mimeType: string;
  fileName?: string;
  description?: string;
}

/**
 * List test preview runs for a team.
 * Equivalent to Convex `api.previewTestJobs.listTestRuns`.
 */
export function listTestRuns(
  db: DbClient,
  opts: { teamSlugOrId: string; limit?: number },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const take = Math.max(1, Math.min(opts.limit ?? 50, 100));

  const runs = db
    .select()
    .from(previewRuns)
    .where(eq(previewRuns.teamId, teamId))
    .orderBy(desc(previewRuns.createdAt))
    .limit(take * 2)
    .all();

  // Filter to only test runs
  const testRuns = runs
    .filter(
      (run) =>
        run.stateReason === "Test preview run" || !run.repoInstallationId,
    )
    .slice(0, take);

  return testRuns.map((run) => {
    const config = run.previewConfigId
      ? db
          .select()
          .from(previewConfigs)
          .where(eq(previewConfigs.id, run.previewConfigId))
          .get()
      : null;

    // Get taskRun to extract taskId
    let taskId: string | undefined;
    if (run.taskRunId) {
      const taskRun = db
        .select()
        .from(taskRuns)
        .where(eq(taskRuns.id, run.taskRunId))
        .get();
      taskId = taskRun?.taskId;
    }

    let screenshotSet: {
      id: string;
      status: string;
      hasUiChanges: boolean | null;
      capturedAt: number;
      error: string | null;
      images: ScreenshotImage[];
      videos: ScreenshotVideo[];
    } | null = null;

    if (run.screenshotSetId) {
      const ss = db
        .select()
        .from(taskRunScreenshotSets)
        .where(eq(taskRunScreenshotSets.id, run.screenshotSetId))
        .get();
      if (ss) {
        screenshotSet = {
          id: ss.id,
          status: ss.status,
          hasUiChanges: ss.hasUiChanges ?? null,
          capturedAt: ss.capturedAt,
          error: ss.error ?? null,
          images: (ss.images as ScreenshotImage[]) ?? [],
          videos: (ss.videos as ScreenshotVideo[]) ?? [],
        };
      }
    }

    return {
      _id: run.id,
      prNumber: run.prNumber,
      prUrl: run.prUrl,
      prTitle: run.prTitle ?? null,
      repoFullName: run.repoFullName,
      headSha: run.headSha,
      status: run.status,
      stateReason: run.stateReason ?? null,
      taskId: taskId ?? null,
      taskRunId: run.taskRunId ?? null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      dispatchedAt: run.dispatchedAt ?? null,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
      configRepoFullName: config?.repoFullName ?? null,
      screenshotSet: screenshotSet
        ? {
            _id: screenshotSet.id,
            status: screenshotSet.status,
            hasUiChanges: screenshotSet.hasUiChanges,
            capturedAt: screenshotSet.capturedAt,
            error: screenshotSet.error,
            images: screenshotSet.images.map((img) => ({
              storageId: img.storageId,
              mimeType: img.mimeType,
              fileName: img.fileName ?? null,
              description: img.description ?? null,
              url: null, // No storage URL service in SQLite
            })),
            videos: screenshotSet.videos.map((vid) => ({
              storageId: vid.storageId,
              mimeType: vid.mimeType,
              fileName: vid.fileName ?? null,
              description: vid.description ?? null,
              url: null,
            })),
          }
        : null,
    };
  });
}

/**
 * Get detailed info about a test preview run.
 * Equivalent to Convex `api.previewTestJobs.getTestRunDetails`.
 */
export function getTestRunDetails(
  db: DbClient,
  opts: { teamSlugOrId: string; previewRunId: string },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);

  const run = db
    .select()
    .from(previewRuns)
    .where(eq(previewRuns.id, opts.previewRunId))
    .get();
  if (!run) {
    throw new Error("Preview run not found");
  }
  if (run.teamId !== teamId) {
    throw new Error("Preview run does not belong to this team");
  }

  const config = run.previewConfigId
    ? db
        .select()
        .from(previewConfigs)
        .where(eq(previewConfigs.id, run.previewConfigId))
        .get()
    : null;

  let screenshotSet: {
    id: string;
    status: string;
    hasUiChanges: boolean | null;
    capturedAt: number;
    error: string | null;
    images: ScreenshotImage[];
    videos: ScreenshotVideo[];
  } | null = null;

  if (run.screenshotSetId) {
    const ss = db
      .select()
      .from(taskRunScreenshotSets)
      .where(eq(taskRunScreenshotSets.id, run.screenshotSetId))
      .get();
    if (ss) {
      screenshotSet = {
        id: ss.id,
        status: ss.status,
        hasUiChanges: ss.hasUiChanges ?? null,
        capturedAt: ss.capturedAt,
        error: ss.error ?? null,
        images: (ss.images as ScreenshotImage[]) ?? [],
        videos: (ss.videos as ScreenshotVideo[]) ?? [],
      };
    }
  }

  // Get taskRun for trajectory link
  let taskId: string | undefined;
  if (run.taskRunId) {
    const taskRun = db
      .select()
      .from(taskRuns)
      .where(eq(taskRuns.id, run.taskRunId))
      .get();
    taskId = taskRun?.taskId;
  }

  return {
    _id: run.id,
    prNumber: run.prNumber,
    prUrl: run.prUrl,
    prTitle: run.prTitle ?? null,
    prDescription: run.prDescription ?? null,
    repoFullName: run.repoFullName,
    headSha: run.headSha,
    baseSha: run.baseSha ?? null,
    headRef: run.headRef ?? null,
    status: run.status,
    stateReason: run.stateReason ?? null,
    taskRunId: run.taskRunId ?? null,
    taskId: taskId ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    dispatchedAt: run.dispatchedAt ?? null,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    configRepoFullName: config?.repoFullName ?? null,
    environmentId: config?.environmentId ?? null,
    screenshotSet: screenshotSet
      ? {
          _id: screenshotSet.id,
          status: screenshotSet.status,
          hasUiChanges: screenshotSet.hasUiChanges,
          capturedAt: screenshotSet.capturedAt,
          error: screenshotSet.error,
          images: screenshotSet.images.map((img) => ({
            storageId: img.storageId,
            mimeType: img.mimeType,
            fileName: img.fileName ?? null,
            description: img.description ?? null,
            url: null,
          })),
          videos: screenshotSet.videos.map((vid) => ({
            storageId: vid.storageId,
            mimeType: vid.mimeType,
            fileName: vid.fileName ?? null,
            description: vid.description ?? null,
            url: null,
          })),
        }
      : null,
  };
}
