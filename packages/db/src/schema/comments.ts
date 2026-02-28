import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

export const taskComments = sqliteTable(
  "taskComments",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    taskId: text("taskId").notNull(),
    content: text("content").notNull(),
    userId: text("userId").notNull(),
    teamId: text("teamId").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (table) => [
    index("taskComments_by_task").on(table.taskId, table.createdAt),
    index("taskComments_by_team_task").on(table.teamId, table.taskId, table.createdAt),
    index("taskComments_by_team_user").on(table.teamId, table.userId),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    url: text("url").notNull(),
    page: text("page").notNull(),
    pageTitle: text("pageTitle").notNull(),
    nodeId: text("nodeId").notNull(),
    x: real("x").notNull(),
    y: real("y").notNull(),
    content: text("content").notNull(),
    resolved: integer("resolved", { mode: "boolean" }),
    archived: integer("archived", { mode: "boolean" }),
    userId: text("userId").notNull(),
    teamId: text("teamId").notNull(),
    profileImageUrl: text("profileImageUrl"),
    userAgent: text("userAgent").notNull(),
    screenWidth: integer("screenWidth").notNull(),
    screenHeight: integer("screenHeight").notNull(),
    devicePixelRatio: real("devicePixelRatio").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (table) => [
    index("comments_by_url").on(table.url, table.createdAt),
    index("comments_by_page").on(table.page, table.createdAt),
    index("comments_by_user").on(table.userId, table.createdAt),
    index("comments_by_resolved").on(table.resolved, table.createdAt),
    index("comments_by_team_user").on(table.teamId, table.userId),
  ],
);

export const commentReplies = sqliteTable(
  "commentReplies",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    commentId: text("commentId").notNull(),
    userId: text("userId").notNull(),
    teamId: text("teamId").notNull(),
    content: text("content").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (table) => [
    index("commentReplies_by_comment").on(table.commentId, table.createdAt),
    index("commentReplies_by_user").on(table.userId, table.createdAt),
    index("commentReplies_by_team_user").on(table.teamId, table.userId),
  ],
);
