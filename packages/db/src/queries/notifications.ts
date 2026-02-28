import { eq, and, isNull, desc } from "drizzle-orm";
import type { DbClient } from "../connection";
import { taskNotifications, unreadTaskRuns } from "../schema/index";
import { resolveTeamId } from "./teams";

export function getNotificationsByTeamUser(
  db: DbClient,
  teamSlugOrId: string,
  userId: string,
  opts?: { unreadOnly?: boolean },
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  const conditions = [
    eq(taskNotifications.teamId, teamId),
    eq(taskNotifications.userId, userId),
  ];
  if (opts?.unreadOnly) {
    conditions.push(isNull(taskNotifications.readAt));
  }

  return db
    .select()
    .from(taskNotifications)
    .where(and(...conditions))
    .orderBy(desc(taskNotifications.createdAt))
    .all();
}

export function getUnreadTaskRuns(
  db: DbClient,
  teamSlugOrId: string,
  userId: string,
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db
    .select()
    .from(unreadTaskRuns)
    .where(
      and(
        eq(unreadTaskRuns.teamId, teamId),
        eq(unreadTaskRuns.userId, userId),
      ),
    )
    .all();
}

export function getUnreadForTask(
  db: DbClient,
  taskId: string,
  userId: string,
) {
  return db
    .select()
    .from(unreadTaskRuns)
    .where(
      and(
        eq(unreadTaskRuns.taskId, taskId),
        eq(unreadTaskRuns.userId, userId),
      ),
    )
    .all();
}
