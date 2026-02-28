import { eq, and } from "drizzle-orm";
import type { DbClient } from "../connection";
import {
  previewConfigs,
  previewRuns,
  providerConnections,
} from "../schema/index";
import { resolveTeamId } from "../queries/teams";

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

/**
 * Create a test preview run from a PR URL.
 * Equivalent to Convex `api.previewTestJobs.createTestRun`.
 */
export function createTestRun(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    prUrl: string;
    prMetadata?: {
      headSha: string;
      baseSha?: string;
      prTitle: string;
      prDescription?: string;
      headRef?: string;
      headRepoFullName?: string;
      headRepoCloneUrl?: string;
    };
  },
): { previewRunId: string; prNumber: number; repoFullName: string } {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);

  const parsed = parsePrUrl(opts.prUrl);
  if (!parsed) {
    throw new Error(
      "Invalid PR URL format. Expected: https://github.com/owner/repo/pull/123",
    );
  }

  const { prNumber, repoFullName } = parsed;

  // Find the preview config for this repo
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
    throw new Error(
      `No preview configuration found for ${repoFullName}. ` +
        `Please create one first via the cmux UI at /preview.`,
    );
  }

  // Verify the GitHub installation is still active (if we have an installation ID)
  const installationId = config.repoInstallationId;
  if (installationId) {
    const installation = db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.installationId, installationId))
      .get();

    if (!installation) {
      throw new Error(
        "GitHub App installation not found. Please reconnect your GitHub App in Team Settings.",
      );
    }

    if (installation.isActive === false) {
      throw new Error(
        `GitHub App installation for ${installation.accountLogin ?? "this account"} is no longer active. ` +
          `Please reconnect the GitHub App in your GitHub settings or Team Settings.`,
      );
    }
  }

  const headSha = opts.prMetadata?.headSha ?? `test-${Date.now()}`;
  const prTitle = opts.prMetadata?.prTitle ?? `Test PR #${prNumber}`;
  const now = Date.now();

  const runId = crypto.randomUUID();
  db.insert(previewRuns)
    .values({
      id: runId,
      previewConfigId: config.id,
      teamId,
      repoFullName,
      repoInstallationId: config.repoInstallationId,
      prNumber,
      prUrl: opts.prUrl,
      prTitle,
      prDescription: opts.prMetadata?.prDescription,
      headSha,
      baseSha: opts.prMetadata?.baseSha,
      headRef: opts.prMetadata?.headRef,
      headRepoFullName: opts.prMetadata?.headRepoFullName,
      headRepoCloneUrl: opts.prMetadata?.headRepoCloneUrl,
      status: "pending",
      stateReason: "Test preview run",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.update(previewConfigs)
    .set({ lastRunAt: now, updatedAt: now })
    .where(eq(previewConfigs.id, config.id))
    .run();

  return {
    previewRunId: runId,
    prNumber,
    repoFullName,
  };
}

/**
 * Mark a preview run as dispatched and schedule execution.
 * This replaces the Convex action `api.previewTestJobs.dispatchTestJob`.
 * Note: Job scheduling is handled at the route level since we don't have Convex scheduler.
 */
export function markDispatched(
  db: DbClient,
  opts: { previewRunId: string },
): { dispatched: boolean } {
  const run = db
    .select()
    .from(previewRuns)
    .where(eq(previewRuns.id, opts.previewRunId))
    .get();

  if (!run) {
    throw new Error("Preview run not found");
  }

  const now = Date.now();
  db.update(previewRuns)
    .set({
      status: "running",
      dispatchedAt: now,
      updatedAt: now,
    })
    .where(eq(previewRuns.id, opts.previewRunId))
    .run();

  return { dispatched: true };
}

/**
 * Create a new test run for retry (internal version without auth).
 * Equivalent to Convex `internal.previewTestJobs.createTestRunInternal`.
 */
export function createTestRunInternal(
  db: DbClient,
  opts: {
    teamId: string;
    prUrl: string;
    prMetadata?: {
      headSha: string;
      baseSha?: string;
      prTitle: string;
      prDescription?: string;
      headRef?: string;
      headRepoFullName?: string;
      headRepoCloneUrl?: string;
    };
  },
): { previewRunId: string; prNumber: number; repoFullName: string } {
  const parsed = parsePrUrl(opts.prUrl);
  if (!parsed) {
    throw new Error(
      "Invalid PR URL format. Expected: https://github.com/owner/repo/pull/123",
    );
  }

  const { prNumber, repoFullName } = parsed;

  const config = db
    .select()
    .from(previewConfigs)
    .where(
      and(
        eq(previewConfigs.teamId, opts.teamId),
        eq(previewConfigs.repoFullName, repoFullName),
      ),
    )
    .get();

  if (!config) {
    throw new Error(
      `No preview configuration found for ${repoFullName}. ` +
        `Please create one first via the cmux UI at /preview.`,
    );
  }

  const headSha = opts.prMetadata?.headSha ?? `test-${Date.now()}`;
  const prTitle = opts.prMetadata?.prTitle ?? `Test PR #${prNumber}`;
  const now = Date.now();

  const runId = crypto.randomUUID();
  db.insert(previewRuns)
    .values({
      id: runId,
      previewConfigId: config.id,
      teamId: opts.teamId,
      repoFullName,
      repoInstallationId: config.repoInstallationId,
      prNumber,
      prUrl: opts.prUrl,
      prTitle,
      prDescription: opts.prMetadata?.prDescription,
      headSha,
      baseSha: opts.prMetadata?.baseSha,
      headRef: opts.prMetadata?.headRef,
      headRepoFullName: opts.prMetadata?.headRepoFullName,
      headRepoCloneUrl: opts.prMetadata?.headRepoCloneUrl,
      status: "pending",
      stateReason: "Test preview run",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.update(previewConfigs)
    .set({ lastRunAt: now, updatedAt: now })
    .where(eq(previewConfigs.id, config.id))
    .run();

  return {
    previewRunId: runId,
    prNumber,
    repoFullName,
  };
}

/**
 * Delete a test preview run.
 * Equivalent to Convex `api.previewTestJobs.deleteTestRun`.
 */
export function deleteTestRun(
  db: DbClient,
  opts: { teamSlugOrId: string; previewRunId: string },
): { deleted: boolean } {
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

  // Only allow deleting test runs
  const isTestRun =
    run.stateReason === "Test preview run" || !run.repoInstallationId;
  if (!isTestRun) {
    throw new Error("Cannot delete production preview runs");
  }

  db.delete(previewRuns).where(eq(previewRuns.id, opts.previewRunId)).run();

  return { deleted: true };
}

/**
 * Retry a failed test preview job by creating a new run and dispatching it.
 * This replaces the Convex action `api.previewTestJobs.retryTestJob`.
 * Note: Job scheduling must be handled at the route level.
 */
export function retryTestJob(
  db: DbClient,
  opts: { teamSlugOrId: string; userId: string; previewRunId: string },
): { newPreviewRunId: string; dispatched: boolean } {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);

  const previewRun = db
    .select()
    .from(previewRuns)
    .where(eq(previewRuns.id, opts.previewRunId))
    .get();

  if (!previewRun) {
    throw new Error("Preview run not found");
  }

  if (previewRun.teamId !== teamId) {
    throw new Error("Forbidden: Not a member of this team");
  }

  // Create a new test run with the same PR URL
  const newRun = createTestRunInternal(db, {
    teamId: previewRun.teamId,
    prUrl: previewRun.prUrl,
  });

  // Mark as dispatched
  markDispatched(db, { previewRunId: newRun.previewRunId });

  return {
    newPreviewRunId: newRun.previewRunId,
    dispatched: true,
  };
}
