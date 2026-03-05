import { eq, and, isNull, sql, type InferSelectModel } from "drizzle-orm";
import type { DbClient } from "../connection";
import { tasks, taskVersions, unreadTaskRuns, taskRuns } from "../schema/index";
import { resolveTeamId } from "./teams";

type UnreadTaskRun = InferSelectModel<typeof unreadTaskRuns>;

export function getTaskById(db: DbClient, teamSlugOrId: string, id: string) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  const task = db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!task || task.teamId !== teamId) return null;
  return task;
}

export function getTasksByTeamUser(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    archived?: boolean;
    excludeLocalWorkspaces?: boolean;
    projectFullName?: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);

  const results = db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.teamId, teamId),
        eq(tasks.userId, opts.userId),
        opts.archived === true
          ? eq(tasks.isArchived, true)
          : sql`(${tasks.isArchived} IS NULL OR ${tasks.isArchived} = 0)`,
        sql`(${tasks.isPreview} IS NULL OR ${tasks.isPreview} = 0)`,
        isNull(tasks.linkedFromCloudTaskRunId),
        ...(opts.excludeLocalWorkspaces
          ? [sql`(${tasks.isLocalWorkspace} IS NULL OR ${tasks.isLocalWorkspace} = 0)`]
          : []),
        ...(opts.projectFullName
          ? [eq(tasks.projectFullName, opts.projectFullName)]
          : []),
      ),
    )
    .all();

  // Attach hasUnread
  const unreadRuns = db
    .select()
    .from(unreadTaskRuns)
    .where(
      and(eq(unreadTaskRuns.teamId, teamId), eq(unreadTaskRuns.userId, opts.userId)),
    )
    .all();

  const tasksWithUnread = new Set(
    unreadRuns.map((ur: UnreadTaskRun) => ur.taskId).filter((id: string | null): id is string => id !== null && id !== undefined),
  );

  const sorted = [...results].sort(
    (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
  );

  return sorted.map((task) => ({
    ...task,
    hasUnread: tasksWithUnread.has(task.id),
  }));
}

export function getTasksWithNotificationOrder(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    archived?: boolean;
    excludeLocalWorkspaces?: boolean;
    projectFullName?: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);

  const results = db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.teamId, teamId),
        eq(tasks.userId, opts.userId),
        opts.archived === true
          ? eq(tasks.isArchived, true)
          : sql`(${tasks.isArchived} IS NULL OR ${tasks.isArchived} = 0)`,
        sql`(${tasks.isPreview} IS NULL OR ${tasks.isPreview} = 0)`,
        isNull(tasks.linkedFromCloudTaskRunId),
        ...(opts.excludeLocalWorkspaces
          ? [sql`(${tasks.isLocalWorkspace} IS NULL OR ${tasks.isLocalWorkspace} = 0)`]
          : []),
        ...(opts.projectFullName
          ? [eq(tasks.projectFullName, opts.projectFullName)]
          : []),
      ),
    )
    .all();

  const unreadRuns = db
    .select()
    .from(unreadTaskRuns)
    .where(
      and(eq(unreadTaskRuns.teamId, teamId), eq(unreadTaskRuns.userId, opts.userId)),
    )
    .all();

  const tasksWithUnread = new Set(
    unreadRuns.map((ur: UnreadTaskRun) => ur.taskId).filter((id: string | null): id is string => id !== null && id !== undefined),
  );

  const sorted = [...results].sort((a, b) => {
    const aTime = a.lastActivityAt ?? a.createdAt ?? 0;
    const bTime = b.lastActivityAt ?? b.createdAt ?? 0;
    return bTime - aTime;
  });

  return sorted.map((task) => ({
    ...task,
    hasUnread: tasksWithUnread.has(task.id),
  }));
}

export function getPinnedTasks(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    excludeLocalWorkspaces?: boolean;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);

  const results = db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.pinned, true),
        eq(tasks.teamId, teamId),
        eq(tasks.userId, opts.userId),
        sql`(${tasks.isArchived} IS NULL OR ${tasks.isArchived} = 0)`,
        sql`(${tasks.isPreview} IS NULL OR ${tasks.isPreview} = 0)`,
        ...(opts.excludeLocalWorkspaces
          ? [sql`(${tasks.isLocalWorkspace} IS NULL OR ${tasks.isLocalWorkspace} = 0)`]
          : []),
      ),
    )
    .all();

  const unreadRuns = db
    .select()
    .from(unreadTaskRuns)
    .where(
      and(eq(unreadTaskRuns.teamId, teamId), eq(unreadTaskRuns.userId, opts.userId)),
    )
    .all();

  const tasksWithUnread = new Set(
    unreadRuns.map((ur: UnreadTaskRun) => ur.taskId).filter((id: string | null): id is string => id !== null && id !== undefined),
  );

  const sorted = [...results].sort(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );

  return sorted.map((task) => ({
    ...task,
    hasUnread: tasksWithUnread.has(task.id),
  }));
}

export function getLinkedLocalWorkspace(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    cloudTaskRunId: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);

  const linkedTask = db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.linkedFromCloudTaskRunId, opts.cloudTaskRunId),
        eq(tasks.teamId, teamId),
        eq(tasks.userId, opts.userId),
      ),
    )
    .get();

  if (!linkedTask) return null;

  const taskRun = db
    .select()
    .from(taskRuns)
    .where(eq(taskRuns.taskId, linkedTask.id))
    .get();

  if (!taskRun) return null;

  return { task: linkedTask, taskRun };
}

export function getTaskVersions(
  db: DbClient,
  teamSlugOrId: string,
  taskId: string,
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db
    .select()
    .from(taskVersions)
    .where(and(eq(taskVersions.taskId, taskId), eq(taskVersions.teamId, teamId)))
    .all();
}
