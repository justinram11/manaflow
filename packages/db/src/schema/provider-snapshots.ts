import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const providerSnapshots = sqliteTable(
  "providerSnapshots",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    providerId: text("providerId").notNull(),
    teamId: text("teamId").notNull(),
    externalId: text("externalId").notNull(), // e.g. "cmux-1234/snap1" for Incus
    name: text("name").notNull(),
    stateful: integer("stateful", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("createdAt").notNull(),
  },
  (table) => [
    index("providerSnapshots_by_provider").on(table.providerId),
    index("providerSnapshots_by_team").on(table.teamId),
  ],
);
