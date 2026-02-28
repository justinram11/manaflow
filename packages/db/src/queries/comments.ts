import { eq } from "drizzle-orm";
import type { DbClient } from "../connection";
import { taskComments, comments, commentReplies } from "../schema/index";

export function getTaskComments(db: DbClient, taskId: string) {
  return db
    .select()
    .from(taskComments)
    .where(eq(taskComments.taskId, taskId))
    .orderBy(taskComments.createdAt)
    .all();
}

export function getCommentsByUrl(db: DbClient, url: string) {
  return db
    .select()
    .from(comments)
    .where(eq(comments.url, url))
    .orderBy(comments.createdAt)
    .all();
}

export function getCommentById(db: DbClient, id: string) {
  return db.select().from(comments).where(eq(comments.id, id)).get();
}

export function getCommentReplies(db: DbClient, commentId: string) {
  return db
    .select()
    .from(commentReplies)
    .where(eq(commentReplies.commentId, commentId))
    .orderBy(commentReplies.createdAt)
    .all();
}
