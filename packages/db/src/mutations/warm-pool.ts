import { eq, and } from "drizzle-orm";
import type { DbClient } from "../connection";
import { warmPool } from "../schema/index";

/**
 * Create a prewarm entry when a user starts typing a task description.
 * Equivalent to Convex `api.warmPool.createPrewarmEntry`.
 */
export function createPrewarmEntry(
  db: DbClient,
  opts: {
    teamId: string;
    userId: string;
    snapshotId: string;
    repoUrl?: string;
    branch?: string;
  },
): { id: string; alreadyExists: boolean } {
  const now = Date.now();

  // Cancel any existing provisioning/ready entries for this user+team+repo
  const existing = db
    .select()
    .from(warmPool)
    .where(
      and(eq(warmPool.teamId, opts.teamId), eq(warmPool.status, "provisioning")),
    )
    .all();

  const existingReady = db
    .select()
    .from(warmPool)
    .where(
      and(eq(warmPool.teamId, opts.teamId), eq(warmPool.status, "ready")),
    )
    .all();

  for (const entry of [...existing, ...existingReady]) {
    if (entry.userId === opts.userId) {
      // If same repo is already prewarming/ready, skip creating a new one
      if (entry.repoUrl === (opts.repoUrl ?? null)) {
        return { id: entry.id, alreadyExists: true };
      }
      // Different repo - mark old one as failed so cleanup removes it
      db.update(warmPool)
        .set({
          status: "failed",
          errorMessage: "Superseded by new prewarm request",
          updatedAt: now,
        })
        .where(eq(warmPool.id, entry.id))
        .run();
    }
  }

  const id = crypto.randomUUID();
  db.insert(warmPool)
    .values({
      id,
      instanceId: "",
      snapshotId: opts.snapshotId,
      status: "provisioning",
      teamId: opts.teamId,
      userId: opts.userId,
      repoUrl: opts.repoUrl ?? null,
      branch: opts.branch ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return { id, alreadyExists: false };
}

/**
 * Claim a ready prewarmed instance matching the given team and repo.
 * Equivalent to Convex `api.warmPool.claimInstance`.
 */
export function claimInstance(
  db: DbClient,
  opts: {
    teamId: string;
    repoUrl?: string;
    taskRunId: string;
  },
) {
  const readyInstances = db
    .select()
    .from(warmPool)
    .where(
      and(eq(warmPool.teamId, opts.teamId), eq(warmPool.status, "ready")),
    )
    .all();

  const match = readyInstances.find(
    (entry) => entry.repoUrl === (opts.repoUrl ?? null),
  );

  if (!match) {
    return null;
  }

  const now = Date.now();
  db.update(warmPool)
    .set({
      status: "claimed",
      claimedAt: now,
      claimedByTaskRunId: opts.taskRunId,
      updatedAt: now,
    })
    .where(eq(warmPool.id, match.id))
    .run();

  return {
    instanceId: match.instanceId,
    vscodeUrl: match.vscodeUrl,
    workerUrl: match.workerUrl,
    repoUrl: match.repoUrl,
    branch: match.branch,
  };
}

/**
 * Mark a provisioning instance as ready with its instance details.
 * Equivalent to Convex `api.warmPool.markInstanceReady`.
 */
export function markInstanceReady(
  db: DbClient,
  opts: {
    id: string;
    instanceId: string;
    vscodeUrl: string;
    workerUrl: string;
  },
) {
  const entry = db
    .select()
    .from(warmPool)
    .where(eq(warmPool.id, opts.id))
    .get();

  if (!entry || entry.status !== "provisioning") {
    return;
  }

  db.update(warmPool)
    .set({
      status: "ready",
      instanceId: opts.instanceId,
      vscodeUrl: opts.vscodeUrl,
      workerUrl: opts.workerUrl,
      updatedAt: Date.now(),
    })
    .where(eq(warmPool.id, opts.id))
    .run();
}

/**
 * Mark a provisioning instance as failed.
 * Equivalent to Convex `api.warmPool.markInstanceFailed`.
 */
export function markInstanceFailed(
  db: DbClient,
  opts: {
    id: string;
    errorMessage: string;
  },
) {
  const entry = db
    .select()
    .from(warmPool)
    .where(eq(warmPool.id, opts.id))
    .get();

  if (!entry) return;

  db.update(warmPool)
    .set({
      status: "failed",
      errorMessage: opts.errorMessage,
      updatedAt: Date.now(),
    })
    .where(eq(warmPool.id, opts.id))
    .run();
}
