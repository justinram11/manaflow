import { eq, and } from "drizzle-orm";
import type { DbClient } from "../connection";
import { taskNotifications, unreadTaskRuns } from "../schema/index";

export function createNotification(
  db: DbClient,
  opts: {
    taskId: string;
    taskRunId?: string;
    teamId: string;
    userId: string;
    type: string;
    message?: string;
  },
) {
  const id = crypto.randomUUID();
  db.insert(taskNotifications)
    .values({
      id,
      taskId: opts.taskId,
      taskRunId: opts.taskRunId,
      teamId: opts.teamId,
      userId: opts.userId,
      type: opts.type,
      message: opts.message,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

export function markNotificationRead(db: DbClient, id: string) {
  db.update(taskNotifications)
    .set({ readAt: Date.now() })
    .where(eq(taskNotifications.id, id))
    .run();
}

export function markAllNotificationsRead(
  db: DbClient,
  teamId: string,
  userId: string,
) {
  const now = Date.now();
  const unread = db
    .select()
    .from(taskNotifications)
    .where(
      and(
        eq(taskNotifications.teamId, teamId),
        eq(taskNotifications.userId, userId),
      ),
    )
    .all();

  for (const n of unread) {
    if (!n.readAt) {
      db.update(taskNotifications)
        .set({ readAt: now })
        .where(eq(taskNotifications.id, n.id))
        .run();
    }
  }
}

export function addUnreadTaskRun(
  db: DbClient,
  opts: {
    taskRunId: string;
    taskId?: string;
    userId: string;
    teamId: string;
  },
) {
  const id = crypto.randomUUID();
  db.insert(unreadTaskRuns).values({ id, ...opts }).run();
  return id;
}

export function markTaskRunRead(
  db: DbClient,
  taskRunId: string,
  userId: string,
) {
  const existing = db
    .select()
    .from(unreadTaskRuns)
    .where(
      and(
        eq(unreadTaskRuns.taskRunId, taskRunId),
        eq(unreadTaskRuns.userId, userId),
      ),
    )
    .get();

  if (existing) {
    db.delete(unreadTaskRuns)
      .where(eq(unreadTaskRuns.id, existing.id))
      .run();
  }
}

export function markAllTaskRunsReadForTask(
  db: DbClient,
  taskId: string,
  userId: string,
) {
  const unread = db
    .select()
    .from(unreadTaskRuns)
    .where(
      and(
        eq(unreadTaskRuns.taskId, taskId),
        eq(unreadTaskRuns.userId, userId),
      ),
    )
    .all();

  for (const u of unread) {
    db.delete(unreadTaskRuns).where(eq(unreadTaskRuns.id, u.id)).run();
  }
}
