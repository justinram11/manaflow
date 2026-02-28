import { eq, and } from "drizzle-orm";
import type { DbClient } from "../connection";
import { tasks, taskVersions, taskRuns } from "../schema/index";
import { resolveTeamId } from "../queries/teams";

export function createTask(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    text: string;
    description?: string;
    projectFullName?: string;
    baseBranch?: string;
    worktreePath?: string;
    images?: unknown[];
    environmentId?: string;
    isCloudWorkspace?: boolean;
    selectedAgents?: string[];
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const now = Date.now();

  const taskId = crypto.randomUUID();
  db.insert(tasks)
    .values({
      id: taskId,
      text: opts.text,
      description: opts.description,
      projectFullName: opts.projectFullName,
      baseBranch: opts.baseBranch,
      worktreePath: opts.worktreePath,
      isCompleted: false,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      images: opts.images as unknown as null,
      userId: opts.userId,
      teamId,
      environmentId: opts.environmentId,
      isCloudWorkspace: opts.isCloudWorkspace,
    })
    .run();

  // Create task runs atomically if selectedAgents provided
  let taskRunIds: string[] | undefined;
  if (opts.selectedAgents && opts.selectedAgents.length > 0) {
    taskRunIds = opts.selectedAgents.map((agentName) => {
      const runId = crypto.randomUUID();
      db.insert(taskRuns)
        .values({
          id: runId,
          taskId,
          prompt: opts.text,
          agentName,
          status: "pending",
          createdAt: now,
          updatedAt: now,
          userId: opts.userId,
          teamId,
          environmentId: opts.environmentId,
          isCloudWorkspace: opts.isCloudWorkspace,
        })
        .run();
      return runId;
    });
  }

  return { taskId, taskRunIds };
}

export function updateTask(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    id: string;
    text: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const task = db.select().from(tasks).where(eq(tasks.id, opts.id)).get();
  if (!task || task.teamId !== teamId || task.userId !== opts.userId) {
    throw new Error("Task not found or unauthorized");
  }
  db.update(tasks)
    .set({ text: opts.text, updatedAt: Date.now() })
    .where(eq(tasks.id, opts.id))
    .run();
}

export function archiveTask(
  db: DbClient,
  opts: { teamSlugOrId: string; userId: string; id: string },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const task = db.select().from(tasks).where(eq(tasks.id, opts.id)).get();
  if (!task || task.teamId !== teamId || task.userId !== opts.userId) {
    throw new Error("Task not found or unauthorized");
  }
  db.update(tasks)
    .set({ isArchived: true, updatedAt: Date.now() })
    .where(eq(tasks.id, opts.id))
    .run();
}

export function unarchiveTask(
  db: DbClient,
  opts: { teamSlugOrId: string; userId: string; id: string },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const task = db.select().from(tasks).where(eq(tasks.id, opts.id)).get();
  if (!task || task.teamId !== teamId || task.userId !== opts.userId) {
    throw new Error("Task not found or unauthorized");
  }
  db.update(tasks)
    .set({ isArchived: false, updatedAt: Date.now() })
    .where(eq(tasks.id, opts.id))
    .run();
}

export function pinTask(
  db: DbClient,
  opts: { teamSlugOrId: string; userId: string; id: string },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const task = db.select().from(tasks).where(eq(tasks.id, opts.id)).get();
  if (!task || task.teamId !== teamId || task.userId !== opts.userId) {
    throw new Error("Task not found or unauthorized");
  }
  db.update(tasks)
    .set({ pinned: true, updatedAt: Date.now() })
    .where(eq(tasks.id, opts.id))
    .run();
}

export function unpinTask(
  db: DbClient,
  opts: { teamSlugOrId: string; userId: string; id: string },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const task = db.select().from(tasks).where(eq(tasks.id, opts.id)).get();
  if (!task || task.teamId !== teamId || task.userId !== opts.userId) {
    throw new Error("Task not found or unauthorized");
  }
  db.update(tasks)
    .set({ pinned: false, updatedAt: Date.now() })
    .where(eq(tasks.id, opts.id))
    .run();
}

export function setTaskCompleted(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    id: string;
    isCompleted: boolean;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const task = db.select().from(tasks).where(eq(tasks.id, opts.id)).get();
  if (!task || task.teamId !== teamId || task.userId !== opts.userId) {
    throw new Error("Task not found");
  }
  db.update(tasks)
    .set({ isCompleted: opts.isCompleted, updatedAt: Date.now() })
    .where(eq(tasks.id, opts.id))
    .run();
}

export function deleteTask(
  db: DbClient,
  opts: { teamSlugOrId: string; userId: string; id: string },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const task = db.select().from(tasks).where(eq(tasks.id, opts.id)).get();
  if (!task || task.teamId !== teamId || task.userId !== opts.userId) {
    throw new Error("Task not found or unauthorized");
  }
  db.delete(tasks).where(eq(tasks.id, opts.id)).run();
}

export function updateTaskMergeStatus(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    id: string;
    mergeStatus: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const task = db.select().from(tasks).where(eq(tasks.id, opts.id)).get();
  if (!task || task.teamId !== teamId || task.userId !== opts.userId) {
    throw new Error("Task not found");
  }
  db.update(tasks)
    .set({ mergeStatus: opts.mergeStatus, updatedAt: Date.now() })
    .where(eq(tasks.id, opts.id))
    .run();
}

export function setPullRequestTitle(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    id: string;
    pullRequestTitle?: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const task = db.select().from(tasks).where(eq(tasks.id, opts.id)).get();
  if (!task || task.teamId !== teamId || task.userId !== opts.userId) {
    throw new Error("Task not found or unauthorized");
  }
  db.update(tasks)
    .set({ pullRequestTitle: opts.pullRequestTitle, updatedAt: Date.now() })
    .where(eq(tasks.id, opts.id))
    .run();
}

export function setPullRequestDescription(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    id: string;
    pullRequestDescription?: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const task = db.select().from(tasks).where(eq(tasks.id, opts.id)).get();
  if (!task || task.teamId !== teamId || task.userId !== opts.userId) {
    throw new Error("Task not found or unauthorized");
  }
  db.update(tasks)
    .set({
      pullRequestDescription: opts.pullRequestDescription,
      updatedAt: Date.now(),
    })
    .where(eq(tasks.id, opts.id))
    .run();
}

export function updateTaskWorktreePath(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    id: string;
    worktreePath: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const task = db.select().from(tasks).where(eq(tasks.id, opts.id)).get();
  if (!task || task.teamId !== teamId || task.userId !== opts.userId) {
    throw new Error("Task not found or unauthorized");
  }
  db.update(tasks)
    .set({ worktreePath: opts.worktreePath, updatedAt: Date.now() })
    .where(eq(tasks.id, opts.id))
    .run();
}

export function createTaskVersion(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    taskId: string;
    diff: string;
    summary: string;
    files: Array<{ path: string; changes: string }>;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);

  const existingVersions = db
    .select()
    .from(taskVersions)
    .where(
      and(
        eq(taskVersions.taskId, opts.taskId),
        eq(taskVersions.teamId, teamId),
        eq(taskVersions.userId, opts.userId),
      ),
    )
    .all();

  const version = existingVersions.length + 1;

  const versionId = crypto.randomUUID();
  db.insert(taskVersions)
    .values({
      id: versionId,
      taskId: opts.taskId,
      version,
      diff: opts.diff,
      summary: opts.summary,
      files: opts.files as unknown as null,
      createdAt: Date.now(),
      userId: opts.userId,
      teamId,
    })
    .run();

  db.update(tasks)
    .set({ updatedAt: Date.now() })
    .where(eq(tasks.id, opts.taskId))
    .run();

  return versionId;
}

/** Internal: update task fields without auth check (for server-side use) */
export function patchTask(db: DbClient, id: string, patch: Record<string, unknown>) {
  db.update(tasks)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(tasks.id, id))
    .run();
}
