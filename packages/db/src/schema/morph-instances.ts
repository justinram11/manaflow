import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

export const morphInstanceActivity = sqliteTable(
  "morphInstanceActivity",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    instanceId: text("instanceId").notNull(),
    lastPausedAt: integer("lastPausedAt"),
    lastResumedAt: integer("lastResumedAt"),
    stoppedAt: integer("stoppedAt"),
  },
  (table) => [
    uniqueIndex("morphInstanceActivity_by_instanceId").on(table.instanceId),
  ],
);
