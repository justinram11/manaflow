import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const warmPool = sqliteTable(
  "warmPool",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    instanceId: text("instanceId").notNull(),
    snapshotId: text("snapshotId").notNull(),
    status: text("status").notNull(),
    teamId: text("teamId").notNull(),
    userId: text("userId").notNull(),
    repoUrl: text("repoUrl"),
    branch: text("branch"),
    vscodeUrl: text("vscodeUrl"),
    workerUrl: text("workerUrl"),
    claimedAt: integer("claimedAt"),
    claimedByTaskRunId: text("claimedByTaskRunId"),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
    errorMessage: text("errorMessage"),
  },
  (table) => [
    index("warmPool_by_status").on(table.status, table.createdAt),
    index("warmPool_by_instanceId").on(table.instanceId),
    index("warmPool_by_team_status").on(table.teamId, table.status, table.createdAt),
  ],
);
