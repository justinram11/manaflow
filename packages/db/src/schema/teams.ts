import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const teams = sqliteTable(
  "teams",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    teamId: text("teamId").notNull(),
    slug: text("slug"),
    displayName: text("displayName"),
    name: text("name"),
    profileImageUrl: text("profileImageUrl"),
    clientMetadata: text("clientMetadata", { mode: "json" }),
    clientReadOnlyMetadata: text("clientReadOnlyMetadata", { mode: "json" }),
    serverMetadata: text("serverMetadata", { mode: "json" }),
    createdAtMillis: integer("createdAtMillis"),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (table) => [
    uniqueIndex("teams_by_teamId").on(table.teamId),
    index("teams_by_slug").on(table.slug),
  ],
);

export const teamMemberships = sqliteTable(
  "teamMemberships",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    teamId: text("teamId").notNull(),
    userId: text("userId").notNull(),
    role: text("role"),
    createdAt: integer("createdAt"),
    updatedAt: integer("updatedAt"),
  },
  (table) => [
    index("teamMemberships_by_team_user").on(table.teamId, table.userId),
    index("teamMemberships_by_user").on(table.userId),
    index("teamMemberships_by_team").on(table.teamId),
  ],
);
