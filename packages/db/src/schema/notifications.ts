import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const taskNotifications = sqliteTable(
  "taskNotifications",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    taskId: text("taskId").notNull(),
    taskRunId: text("taskRunId"),
    teamId: text("teamId").notNull(),
    userId: text("userId").notNull(),
    type: text("type").notNull(),
    message: text("message"),
    readAt: integer("readAt"),
    createdAt: integer("createdAt").notNull(),
  },
  (table) => [
    index("taskNotifications_by_team_user_created").on(table.teamId, table.userId, table.createdAt),
    index("taskNotifications_by_task").on(table.taskId, table.createdAt),
    index("taskNotifications_by_task_user_unread").on(table.taskId, table.userId, table.readAt),
  ],
);

export const unreadTaskRuns = sqliteTable(
  "unreadTaskRuns",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    taskRunId: text("taskRunId").notNull(),
    taskId: text("taskId"),
    userId: text("userId").notNull(),
    teamId: text("teamId").notNull(),
  },
  (table) => [
    index("unreadTaskRuns_by_run_user").on(table.taskRunId, table.userId),
    index("unreadTaskRuns_by_user").on(table.userId),
    index("unreadTaskRuns_by_team_user").on(table.teamId, table.userId),
    index("unreadTaskRuns_by_task_user").on(table.taskId, table.userId),
  ],
);
