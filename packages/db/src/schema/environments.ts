import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const environments = sqliteTable(
  "environments",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    teamId: text("teamId").notNull(),
    userId: text("userId").notNull(),
    morphSnapshotId: text("morphSnapshotId").notNull(),
    dataVaultKey: text("dataVaultKey").notNull(),
    selectedRepos: text("selectedRepos", { mode: "json" }),
    description: text("description"),
    maintenanceScript: text("maintenanceScript"),
    devScript: text("devScript"),
    exposedPorts: text("exposedPorts", { mode: "json" }),
    provider: text("provider"),
    incusSnapshotId: text("incusSnapshotId"),
    firecrackerSnapshotId: text("firecrackerSnapshotId"),
    firecrackerVmSize: text("firecrackerVmSize"),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (table) => [
    index("environments_by_team").on(table.teamId, table.createdAt),
    index("environments_by_team_user").on(table.teamId, table.userId),
    index("environments_by_dataVaultKey").on(table.dataVaultKey),
  ],
);

export const environmentSnapshotVersions = sqliteTable(
  "environmentSnapshotVersions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    environmentId: text("environmentId").notNull(),
    teamId: text("teamId").notNull(),
    morphSnapshotId: text("morphSnapshotId").notNull(),
    incusSnapshotId: text("incusSnapshotId"),
    firecrackerSnapshotId: text("firecrackerSnapshotId"),
    version: integer("version").notNull(),
    createdAt: integer("createdAt").notNull(),
    createdByUserId: text("createdByUserId").notNull(),
    label: text("label"),
    maintenanceScript: text("maintenanceScript"),
    devScript: text("devScript"),
  },
  (table) => [
    index("environmentSnapshotVersions_by_environment_version").on(table.environmentId, table.version),
    index("environmentSnapshotVersions_by_environment_createdAt").on(table.environmentId, table.createdAt),
    index("environmentSnapshotVersions_by_team_createdAt").on(table.teamId, table.createdAt),
    index("environmentSnapshotVersions_by_team_snapshot").on(table.teamId, table.morphSnapshotId),
  ],
);
