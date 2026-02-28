import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const workspaceSettings = sqliteTable(
  "workspaceSettings",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    worktreePath: text("worktreePath"),
    autoPrEnabled: integer("autoPrEnabled", { mode: "boolean" }),
    autoSyncEnabled: integer("autoSyncEnabled", { mode: "boolean" }),
    nextLocalWorkspaceSequence: integer("nextLocalWorkspaceSequence"),
    heatmapModel: text("heatmapModel"),
    heatmapThreshold: real("heatmapThreshold"),
    heatmapTooltipLanguage: text("heatmapTooltipLanguage"),
    heatmapColors: text("heatmapColors", { mode: "json" }),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
    userId: text("userId").notNull(),
    teamId: text("teamId").notNull(),
  },
  (table) => [
    uniqueIndex("workspaceSettings_by_team_user").on(table.teamId, table.userId),
  ],
);

export const workspaceConfigs = sqliteTable(
  "workspaceConfigs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    projectFullName: text("projectFullName").notNull(),
    maintenanceScript: text("maintenanceScript"),
    dataVaultKey: text("dataVaultKey"),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
    userId: text("userId").notNull(),
    teamId: text("teamId").notNull(),
  },
  (table) => [
    index("workspaceConfigs_by_team_user_repo").on(table.teamId, table.userId, table.projectFullName),
  ],
);

export const containerSettings = sqliteTable(
  "containerSettings",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    maxRunningContainers: integer("maxRunningContainers"),
    reviewPeriodMinutes: integer("reviewPeriodMinutes"),
    autoCleanupEnabled: integer("autoCleanupEnabled", { mode: "boolean" }),
    stopImmediatelyOnCompletion: integer("stopImmediatelyOnCompletion", { mode: "boolean" }),
    minContainersToKeep: integer("minContainersToKeep"),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
    userId: text("userId").notNull(),
    teamId: text("teamId").notNull(),
  },
  (table) => [
    uniqueIndex("containerSettings_by_team_user").on(table.teamId, table.userId),
  ],
);

export const userEditorSettings = sqliteTable(
  "userEditorSettings",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    teamId: text("teamId").notNull(),
    userId: text("userId").notNull(),
    settingsJson: text("settingsJson"),
    keybindingsJson: text("keybindingsJson"),
    snippets: text("snippets", { mode: "json" }),
    extensions: text("extensions"),
    updatedAt: integer("updatedAt").notNull(),
  },
  (table) => [
    uniqueIndex("userEditorSettings_by_team_user").on(table.teamId, table.userId),
  ],
);

export const apiKeys = sqliteTable(
  "apiKeys",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    envVar: text("envVar").notNull(),
    value: text("value").notNull(),
    displayName: text("displayName").notNull(),
    description: text("description"),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
    userId: text("userId").notNull(),
    teamId: text("teamId").notNull(),
  },
  (table) => [
    index("apiKeys_by_envVar").on(table.envVar),
    index("apiKeys_by_team_user").on(table.teamId, table.userId),
  ],
);
