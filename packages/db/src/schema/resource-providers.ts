import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const resourceProviders = sqliteTable(
  "resourceProviders",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    teamId: text("teamId").notNull(),
    userId: text("userId").notNull(),
    registrationToken: text("registrationToken").notNull(),
    platform: text("platform").notNull(), // "macos" | "linux"
    arch: text("arch").notNull(), // "arm64" | "x86_64"
    osVersion: text("osVersion"),
    hostname: text("hostname"),
    capabilities: text("capabilities", { mode: "json" }).$type<string[]>(),
    maxConcurrentBuilds: integer("maxConcurrentBuilds").default(2),
    status: text("status").notNull().default("offline"), // "online" | "offline"
    lastHeartbeatAt: integer("lastHeartbeatAt"),
    xcodeVersion: text("xcodeVersion"),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull(),
  },
  (table) => [
    index("resourceProviders_by_team").on(table.teamId),
    index("resourceProviders_by_status").on(table.status),
    uniqueIndex("resourceProviders_by_token").on(table.registrationToken),
  ],
);

export const resourceAllocations = sqliteTable(
  "resourceAllocations",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    resourceProviderId: text("resourceProviderId").notNull(),
    taskRunId: text("taskRunId"),
    teamId: text("teamId").notNull(),
    userId: text("userId").notNull(),
    status: text("status").notNull().default("active"), // "active" | "released" | "failed"
    buildDir: text("buildDir"),
    simulatorUdid: text("simulatorUdid"),
    simulatorDeviceType: text("simulatorDeviceType"),
    simulatorRuntime: text("simulatorRuntime"),
    platform: text("platform").notNull().default("ios"), // "ios" | "android"
    createdAt: integer("createdAt").notNull(),
    releasedAt: integer("releasedAt"),
  },
  (table) => [
    index("resourceAllocations_by_provider").on(table.resourceProviderId),
    index("resourceAllocations_by_taskRun").on(table.taskRunId),
    index("resourceAllocations_by_status").on(table.status),
    index("resourceAllocations_by_team").on(table.teamId),
  ],
);
