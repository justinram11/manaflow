import { eq } from "drizzle-orm";
import type { DbClient } from "../connection";
import { taskComments, comments, commentReplies } from "../schema/index";

export function createTaskComment(
  db: DbClient,
  opts: {
    taskId: string;
    content: string;
    userId: string;
    teamId: string;
  },
) {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.insert(taskComments)
    .values({
      id,
      taskId: opts.taskId,
      content: opts.content,
      userId: opts.userId,
      teamId: opts.teamId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

export function createComment(
  db: DbClient,
  opts: {
    url: string;
    page: string;
    pageTitle: string;
    nodeId: string;
    x: number;
    y: number;
    content: string;
    userId: string;
    teamId: string;
    profileImageUrl?: string;
    userAgent: string;
    screenWidth: number;
    screenHeight: number;
    devicePixelRatio: number;
  },
) {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.insert(comments)
    .values({
      id,
      ...opts,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

export function updateComment(
  db: DbClient,
  id: string,
  patch: { content?: string; resolved?: boolean; archived?: boolean },
) {
  db.update(comments)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(comments.id, id))
    .run();
}

export function createCommentReply(
  db: DbClient,
  opts: {
    commentId: string;
    content: string;
    userId: string;
    teamId: string;
  },
) {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.insert(commentReplies)
    .values({
      id,
      commentId: opts.commentId,
      userId: opts.userId,
      teamId: opts.teamId,
      content: opts.content,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}
