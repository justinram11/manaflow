import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const repos = sqliteTable(
  "repos",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    fullName: text("fullName").notNull(),
    org: text("org").notNull(),
    name: text("name").notNull(),
    gitRemote: text("gitRemote").notNull(),
    provider: text("provider"),
    userId: text("userId").notNull(),
    teamId: text("teamId").notNull(),
    providerRepoId: integer("providerRepoId"),
    ownerLogin: text("ownerLogin"),
    ownerType: text("ownerType"),
    visibility: text("visibility"),
    defaultBranch: text("defaultBranch"),
    connectionId: text("connectionId"),
    lastSyncedAt: integer("lastSyncedAt"),
    lastPushedAt: integer("lastPushedAt"),
    manual: integer("manual", { mode: "boolean" }),
    incusSnapshotId: text("incusSnapshotId"),
  },
  (table) => [
    index("repos_by_org").on(table.org),
    index("repos_by_gitRemote").on(table.gitRemote),
    index("repos_by_team_user").on(table.teamId, table.userId),
    index("repos_by_team").on(table.teamId),
    index("repos_by_team_fullName").on(table.teamId, table.fullName),
  ],
);

export const branches = sqliteTable(
  "branches",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    repo: text("repo").notNull(),
    repoId: text("repoId"),
    name: text("name").notNull(),
    userId: text("userId").notNull(),
    teamId: text("teamId").notNull(),
    lastCommitSha: text("lastCommitSha"),
    lastActivityAt: integer("lastActivityAt"),
    lastKnownBaseSha: text("lastKnownBaseSha"),
    lastKnownMergeCommitSha: text("lastKnownMergeCommitSha"),
  },
  (table) => [
    index("branches_by_repo").on(table.repo),
    index("branches_by_repoId").on(table.repoId),
    index("branches_by_team_user").on(table.teamId, table.userId),
    index("branches_by_team").on(table.teamId),
  ],
);

export const installStates = sqliteTable(
  "installStates",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    nonce: text("nonce").notNull(),
    teamId: text("teamId").notNull(),
    userId: text("userId").notNull(),
    iat: integer("iat").notNull(),
    exp: integer("exp").notNull(),
    status: text("status").notNull(), // "pending" | "used" | "expired"
    createdAt: integer("createdAt").notNull(),
    returnUrl: text("returnUrl"),
  },
  (table) => [
    uniqueIndex("installStates_by_nonce").on(table.nonce),
  ],
);

export const providerConnections = sqliteTable(
  "providerConnections",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    teamId: text("teamId"),
    connectedByUserId: text("connectedByUserId"),
    type: text("type").notNull().default("github_app"),
    installationId: integer("installationId").notNull(),
    accountLogin: text("accountLogin"),
    accountId: integer("accountId"),
    accountType: text("accountType"),
    isActive: integer("isActive", { mode: "boolean" }),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (table) => [
    index("providerConnections_by_installationId").on(table.installationId),
    index("providerConnections_by_team").on(table.teamId),
    index("providerConnections_by_team_type").on(table.teamId, table.type),
  ],
);
