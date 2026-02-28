import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const providers = sqliteTable(
  "providers",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    teamId: text("teamId").notNull(),
    userId: text("userId").notNull(),
    registrationToken: text("registrationToken").notNull(),
    platform: text("platform").notNull(), // "linux" | "macos"
    arch: text("arch").notNull(), // "arm64" | "x86_64"
    osVersion: text("osVersion"),
    hostname: text("hostname"),
    capabilities: text("capabilities", { mode: "json" }).$type<string[]>(),
    maxConcurrentSlots: integer("maxConcurrentSlots").default(4),
    status: text("status").notNull().default("offline"), // "online" | "offline"
    lastHeartbeatAt: integer("lastHeartbeatAt"),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, string>>(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (table) => [
    index("providers_by_team").on(table.teamId),
    index("providers_by_status").on(table.status),
    uniqueIndex("providers_by_token").on(table.registrationToken),
  ],
);

export const providerAllocations = sqliteTable(
  "providerAllocations",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    providerId: text("providerId").notNull(),
    taskRunId: text("taskRunId"),
    teamId: text("teamId").notNull(),
    userId: text("userId").notNull(),
    type: text("type").notNull(), // "compute" | "resource"
    status: text("status").notNull().default("active"), // "active" | "released" | "failed"
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("createdAt").notNull(),
    releasedAt: integer("releasedAt"),
  },
  (table) => [
    index("providerAllocations_by_provider").on(table.providerId),
    index("providerAllocations_by_taskRun").on(table.taskRunId),
    index("providerAllocations_by_status").on(table.status),
    index("providerAllocations_by_team").on(table.teamId),
  ],
);
