import { eq } from "drizzle-orm";
import { aggregatePullRequestState, type StoredPullRequestInfo } from "@cmux/shared/pull-request-state";
import type { DbClient } from "../connection";
import {
  taskRuns,
  taskRunLogChunks,
  taskRunPullRequests,
  tasks,
} from "../schema/index";

export function createTaskRun(
  db: DbClient,
  opts: {
    taskId: string;
    prompt: string;
    agentName?: string;
    status?: string;
    userId: string;
    teamId: string;
    environmentId?: string;
    isCloudWorkspace?: boolean;
    isLocalWorkspace?: boolean;
    isPreviewJob?: boolean;
    parentRunId?: string;
  },
) {
  const now = Date.now();
  const id = crypto.randomUUID();
  db.insert(taskRuns)
    .values({
      id,
      taskId: opts.taskId,
      prompt: opts.prompt,
      agentName: opts.agentName,
      status: opts.status ?? "pending",
      createdAt: now,
      updatedAt: now,
      userId: opts.userId,
      teamId: opts.teamId,
      environmentId: opts.environmentId,
      isCloudWorkspace: opts.isCloudWorkspace,
      isLocalWorkspace: opts.isLocalWorkspace,
      isPreviewJob: opts.isPreviewJob,
      parentRunId: opts.parentRunId,
    })
    .run();

  // Update task lastActivityAt
  db.update(tasks)
    .set({ lastActivityAt: now, updatedAt: now })
    .where(eq(tasks.id, opts.taskId))
    .run();

  return id;
}

/** Patch arbitrary fields on a task run */
export function patchTaskRun(
  db: DbClient,
  id: string,
  patch: Record<string, unknown>,
) {
  db.update(taskRuns)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(taskRuns.id, id))
    .run();
}

export function updateTaskRunStatus(
  db: DbClient,
  id: string,
  status: string,
  extra?: Record<string, unknown>,
) {
  const now = Date.now();
  const updates: Record<string, unknown> = {
    status,
    updatedAt: now,
    ...extra,
  };
  if (status === "completed" || status === "failed") {
    updates.completedAt = now;
  }
  db.update(taskRuns).set(updates).where(eq(taskRuns.id, id)).run();
}

export function updateTaskRunVSCode(
  db: DbClient,
  id: string,
  vscode: Record<string, unknown>,
) {
  db.update(taskRuns)
    .set({ vscode: vscode as unknown as null, updatedAt: Date.now() })
    .where(eq(taskRuns.id, id))
    .run();
}

export function updateTaskRunVSCodeStatus(
  db: DbClient,
  id: string,
  status: string,
  extra?: Record<string, unknown>,
) {
  const run = db.select().from(taskRuns).where(eq(taskRuns.id, id)).get();
  if (!run) throw new Error("Task run not found");
  const currentVscode = (run.vscode ?? {}) as Record<string, unknown>;
  db.update(taskRuns)
    .set({
      vscode: { ...currentVscode, status, ...extra } as unknown as null,
      updatedAt: Date.now(),
    })
    .where(eq(taskRuns.id, id))
    .run();
}

export function updateTaskRunVSCodeStatusMessage(
  db: DbClient,
  id: string,
  statusMessage: string | undefined,
) {
  const run = db.select().from(taskRuns).where(eq(taskRuns.id, id)).get();
  if (!run) throw new Error("Task run not found");
  const currentVscode = (run.vscode ?? {}) as Record<string, unknown>;
  db.update(taskRuns)
    .set({
      vscode: { ...currentVscode, statusMessage } as unknown as null,
      updatedAt: Date.now(),
    })
    .where(eq(taskRuns.id, id))
    .run();
}

export function failTaskRun(
  db: DbClient,
  id: string,
  errorMessage?: string,
) {
  db.update(taskRuns)
    .set({
      status: "failed",
      errorMessage,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(taskRuns.id, id))
    .run();
}

export function updateTaskRunBranch(
  db: DbClient,
  id: string,
  newBranch: string,
) {
  db.update(taskRuns)
    .set({ newBranch, updatedAt: Date.now() })
    .where(eq(taskRuns.id, id))
    .run();
}

export function updateTaskRunWorktreePath(
  db: DbClient,
  id: string,
  worktreePath: string,
) {
  db.update(taskRuns)
    .set({ worktreePath, updatedAt: Date.now() })
    .where(eq(taskRuns.id, id))
    .run();
}

export function updateTaskRunPullRequestUrl(
  db: DbClient,
  id: string,
  pullRequestUrl: string,
) {
  db.update(taskRuns)
    .set({ pullRequestUrl, updatedAt: Date.now() })
    .where(eq(taskRuns.id, id))
    .run();
}

export function updateTaskRunEnvironmentError(
  db: DbClient,
  id: string,
  environmentError: Record<string, unknown>,
) {
  db.update(taskRuns)
    .set({ environmentError: environmentError as unknown as null, updatedAt: Date.now() })
    .where(eq(taskRuns.id, id))
    .run();
}

export function updateTaskRunNetworking(
  db: DbClient,
  id: string,
  networking: unknown[],
) {
  db.update(taskRuns)
    .set({ networking: networking as unknown as null, updatedAt: Date.now() })
    .where(eq(taskRuns.id, id))
    .run();
}

export function addTaskRunLogChunk(
  db: DbClient,
  opts: {
    taskRunId: string;
    content: string;
    userId: string;
    teamId: string;
  },
) {
  const id = crypto.randomUUID();
  db.insert(taskRunLogChunks).values({ id, ...opts }).run();
  return id;
}

export function updateTaskRunPullRequestState(
  db: DbClient,
  id: string,
  pullRequestState: string,
  pullRequestNumber?: number,
  pullRequestIsDraft?: boolean,
) {
  db.update(taskRuns)
    .set({
      pullRequestState,
      ...(pullRequestNumber !== undefined ? { pullRequestNumber } : {}),
      ...(pullRequestIsDraft !== undefined ? { pullRequestIsDraft } : {}),
      updatedAt: Date.now(),
    })
    .where(eq(taskRuns.id, id))
    .run();
}

export function updateTaskRunVSCodePorts(
  db: DbClient,
  id: string,
  ports: Record<string, unknown>,
) {
  const run = db.select().from(taskRuns).where(eq(taskRuns.id, id)).get();
  if (!run) throw new Error("Task run not found");
  const currentVscode = (run.vscode ?? { provider: "docker", status: "starting" }) as Record<string, unknown>;
  db.update(taskRuns)
    .set({
      vscode: { ...currentVscode, ports } as unknown as null,
      updatedAt: Date.now(),
    })
    .where(eq(taskRuns.id, id))
    .run();
}

function normalizePullRequestRecords(
  records: readonly StoredPullRequestInfo[] | undefined,
): StoredPullRequestInfo[] | undefined {
  if (!records) return undefined;
  return records.map((record) => ({
    repoFullName: record.repoFullName.trim(),
    url: record.url,
    number: record.number,
    state: record.state,
    isDraft:
      record.isDraft !== undefined
        ? record.isDraft
        : record.state === "draft"
          ? true
          : undefined,
  }));
}

function syncTaskRunPullRequestsTable(
  db: DbClient,
  taskRunId: string,
  teamId: string,
  pullRequests: StoredPullRequestInfo[] | undefined,
) {
  const existingEntries = db
    .select()
    .from(taskRunPullRequests)
    .where(eq(taskRunPullRequests.taskRunId, taskRunId))
    .all();

  const newPrs = new Map<string, { repoFullName: string; prNumber: number }>();
  for (const pr of pullRequests ?? []) {
    if (pr.number !== undefined) {
      const key = `${pr.repoFullName}:${pr.number}`;
      newPrs.set(key, { repoFullName: pr.repoFullName, prNumber: pr.number });
    }
  }

  for (const entry of existingEntries) {
    const key = `${entry.repoFullName}:${entry.prNumber}`;
    if (!newPrs.has(key)) {
      db.delete(taskRunPullRequests)
        .where(eq(taskRunPullRequests.id, entry.id))
        .run();
    }
  }

  const existingKeys = new Set(
    existingEntries.map((e) => `${e.repoFullName}:${e.prNumber}`),
  );
  for (const [key, pr] of newPrs) {
    if (!existingKeys.has(key)) {
      db.insert(taskRunPullRequests)
        .values({
          id: crypto.randomUUID(),
          taskRunId,
          teamId,
          repoFullName: pr.repoFullName,
          prNumber: pr.prNumber,
          createdAt: Date.now(),
        })
        .run();
    }
  }
}

/**
 * Full pull request URL update with optional PR records and junction table sync.
 * Mirrors the Convex updatePullRequestUrl mutation.
 */
export function updatePullRequestUrlFull(
  db: DbClient,
  opts: {
    id: string;
    teamId: string;
    pullRequestUrl: string;
    isDraft?: boolean;
    state?: string;
    number?: number;
    pullRequests?: StoredPullRequestInfo[];
  },
) {
  const updates: Record<string, unknown> = {
    pullRequestUrl: opts.pullRequestUrl,
    updatedAt: Date.now(),
  };
  if (opts.isDraft !== undefined) {
    updates.pullRequestIsDraft = opts.isDraft;
  }
  if (opts.state) {
    updates.pullRequestState = opts.state;
  }
  if (opts.number !== undefined) {
    updates.pullRequestNumber = opts.number;
  }

  const normalized = normalizePullRequestRecords(opts.pullRequests);
  if (normalized) {
    updates.pullRequests = normalized;
    const aggregate = aggregatePullRequestState(normalized);
    updates.pullRequestState = aggregate.state;
    updates.pullRequestIsDraft = aggregate.isDraft;
    if (aggregate.url !== undefined) updates.pullRequestUrl = aggregate.url;
    if (aggregate.number !== undefined) updates.pullRequestNumber = aggregate.number;
  }

  db.update(taskRuns).set(updates).where(eq(taskRuns.id, opts.id)).run();

  if (normalized) {
    syncTaskRunPullRequestsTable(db, opts.id, opts.teamId, normalized);
  }
}

/**
 * Full pull request state update with optional PR records and junction table sync.
 * Mirrors the Convex updatePullRequestState mutation.
 */
export function updatePullRequestStateFull(
  db: DbClient,
  opts: {
    id: string;
    teamId: string;
    state: string;
    isDraft?: boolean;
    number?: number;
    url?: string;
    pullRequests?: StoredPullRequestInfo[];
  },
) {
  const updates: Record<string, unknown> = {
    pullRequestState: opts.state,
    updatedAt: Date.now(),
  };
  if (opts.isDraft !== undefined) {
    updates.pullRequestIsDraft = opts.isDraft;
  }
  if (opts.number !== undefined) {
    updates.pullRequestNumber = opts.number;
  }
  if (opts.url !== undefined) {
    updates.pullRequestUrl = opts.url;
  }

  const normalized = normalizePullRequestRecords(opts.pullRequests);
  if (normalized) {
    updates.pullRequests = normalized;
    const aggregate = aggregatePullRequestState(normalized);
    updates.pullRequestState = aggregate.state;
    updates.pullRequestIsDraft = aggregate.isDraft;
    if (aggregate.url !== undefined) updates.pullRequestUrl = aggregate.url;
    if (aggregate.number !== undefined) updates.pullRequestNumber = aggregate.number;
  }

  db.update(taskRuns).set(updates).where(eq(taskRuns.id, opts.id)).run();

  if (normalized) {
    syncTaskRunPullRequestsTable(db, opts.id, opts.teamId, normalized);
  }
}

export function updateTaskRunStatusPublic(
  db: DbClient,
  id: string,
  status: string,
) {
  const now = Date.now();
  const updates: Record<string, unknown> = { status, updatedAt: now };
  if (status === "completed" || status === "failed") {
    updates.completedAt = now;
  }
  db.update(taskRuns).set(updates).where(eq(taskRuns.id, id)).run();
}
