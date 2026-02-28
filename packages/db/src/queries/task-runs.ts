import { eq, and, desc, sql } from "drizzle-orm";
import type { DbClient } from "../connection";
import {
  taskRuns,
  taskRunLogChunks,
  taskRunScreenshotSets,
  containerSettings,
} from "../schema/index";
import { resolveTeamId } from "./teams";

export function getTaskRunById(db: DbClient, id: string) {
  return db.select().from(taskRuns).where(eq(taskRuns.id, id)).get();
}

export function getTaskRunsByTask(
  db: DbClient,
  opts: {
    taskId: string;
    includeArchived?: boolean;
  },
) {
  const conditions = [eq(taskRuns.taskId, opts.taskId)];
  if (!opts.includeArchived) {
    conditions.push(
      sql`(${taskRuns.isArchived} IS NULL OR ${taskRuns.isArchived} = 0)`,
    );
  }

  return db
    .select()
    .from(taskRuns)
    .where(and(...conditions))
    .orderBy(desc(taskRuns.createdAt))
    .all();
}

export function getTaskRunByContainerName(
  db: DbClient,
  containerName: string,
) {
  // vscode.containerName is stored in JSON, need to filter in JS
  const allRuns = db.select().from(taskRuns).all();
  return allRuns.find((run) => {
    const vscode = run.vscode as Record<string, unknown> | null;
    return vscode?.containerName === containerName;
  }) ?? null;
}

export function getTaskRunLogChunksByRun(db: DbClient, taskRunId: string) {
  return db
    .select()
    .from(taskRunLogChunks)
    .where(eq(taskRunLogChunks.taskRunId, taskRunId))
    .all();
}

export function getScreenshotSetsByTask(db: DbClient, taskId: string) {
  return db
    .select()
    .from(taskRunScreenshotSets)
    .where(eq(taskRunScreenshotSets.taskId, taskId))
    .orderBy(desc(taskRunScreenshotSets.capturedAt))
    .all();
}

export function getScreenshotSetsByRun(db: DbClient, runId: string) {
  return db
    .select()
    .from(taskRunScreenshotSets)
    .where(eq(taskRunScreenshotSets.runId, runId))
    .orderBy(desc(taskRunScreenshotSets.capturedAt))
    .all();
}

export function getTaskRunsByTeamUserStatus(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    status?: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const conditions = [
    eq(taskRuns.teamId, teamId),
    eq(taskRuns.userId, opts.userId),
  ];
  if (opts.status) {
    conditions.push(eq(taskRuns.status, opts.status));
  }

  return db
    .select()
    .from(taskRuns)
    .where(and(...conditions))
    .orderBy(desc(taskRuns.createdAt))
    .all();
}

interface VscodeField {
  status?: string;
  containerName?: string;
  keepAlive?: boolean;
  scheduledStopAt?: number;
  [key: string]: unknown;
}

/**
 * Get containers that have exceeded their scheduled stop time.
 * Equivalent to Convex `api.taskRuns.getContainersToStop`.
 */
export function getContainersToStop(
  db: DbClient,
  opts: { teamSlugOrId: string; userId: string },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);

  // Get container settings for min containers to keep
  const settings = db
    .select()
    .from(containerSettings)
    .where(
      and(
        eq(containerSettings.teamId, teamId),
        eq(containerSettings.userId, opts.userId),
      ),
    )
    .get();
  const autoCleanupEnabled = settings?.autoCleanupEnabled ?? true;
  const minContainersToKeep = settings?.minContainersToKeep ?? 0;

  if (!autoCleanupEnabled) {
    return [];
  }

  const now = Date.now();
  const allRuns = db
    .select()
    .from(taskRuns)
    .where(
      and(eq(taskRuns.teamId, teamId), eq(taskRuns.userId, opts.userId)),
    )
    .all();

  const runningContainers = allRuns.filter((run) => {
    const vscode = run.vscode as VscodeField | null;
    return vscode && vscode.status === "running" && !vscode.keepAlive;
  });

  // Sort containers by creation time (newest first) to identify which to keep
  const sortedContainers = [...runningContainers].sort(
    (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
  );

  // Get IDs of the most recent N containers to keep
  const containersToKeepIds = new Set(
    sortedContainers.slice(0, minContainersToKeep).map((c) => c.id),
  );

  // Filter containers that have exceeded their scheduled stop time AND are not in the keep set
  return runningContainers.filter((run) => {
    const vscode = run.vscode as VscodeField;
    return (
      vscode.scheduledStopAt &&
      vscode.scheduledStopAt <= now &&
      !containersToKeepIds.has(run.id)
    );
  });
}

/**
 * Get running containers sorted by priority for cleanup.
 * Equivalent to Convex `api.taskRuns.getRunningContainersByCleanupPriority`.
 */
export function getRunningContainersByCleanupPriority(
  db: DbClient,
  opts: { teamSlugOrId: string; userId: string },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);

  // Get container settings for min containers to keep
  const settings = db
    .select()
    .from(containerSettings)
    .where(
      and(
        eq(containerSettings.teamId, teamId),
        eq(containerSettings.userId, opts.userId),
      ),
    )
    .get();
  const minContainersToKeep = settings?.minContainersToKeep ?? 0;

  const allRuns = db
    .select()
    .from(taskRuns)
    .where(
      and(eq(taskRuns.teamId, teamId), eq(taskRuns.userId, opts.userId)),
    )
    .all();

  const runningContainers = allRuns.filter((run) => {
    const vscode = run.vscode as VscodeField | null;
    return vscode && vscode.status === "running" && !vscode.keepAlive;
  });

  // Sort all containers by creation time to identify which to keep
  const sortedByCreation = [...runningContainers].sort(
    (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
  );

  // Get IDs of the most recent N containers to keep
  const containersToKeepIds = new Set(
    sortedByCreation.slice(0, minContainersToKeep).map((c) => c.id),
  );

  // Filter out containers that should be kept
  const eligibleForCleanup = runningContainers.filter(
    (c) => !containersToKeepIds.has(c.id),
  );

  // Categorize eligible containers
  const now = Date.now();
  type TaskRunRow = (typeof eligibleForCleanup)[number];
  const activeContainers: TaskRunRow[] = [];
  const reviewContainers: TaskRunRow[] = [];

  for (const container of eligibleForCleanup) {
    if (
      container.status === "running" ||
      container.status === "pending" ||
      (container.completedAt && now - container.completedAt < 5 * 60 * 1000)
    ) {
      activeContainers.push(container);
    } else {
      reviewContainers.push(container);
    }
  }

  // Sort review containers by scheduled stop time (earliest first)
  reviewContainers.sort((a, b) => {
    const aVscode = a.vscode as VscodeField;
    const bVscode = b.vscode as VscodeField;
    const aTime = aVscode.scheduledStopAt || Infinity;
    const bTime = bVscode.scheduledStopAt || Infinity;
    return aTime - bTime;
  });

  return {
    total: runningContainers.length,
    reviewContainers,
    activeContainers,
    prioritizedForCleanup: [...reviewContainers, ...activeContainers],
    protectedCount: containersToKeepIds.size,
  };
}
