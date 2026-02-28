import type { InferSelectModel } from "drizzle-orm";
import type { tasks, taskRuns } from "@cmux/db/schema";

export type TaskDoc = InferSelectModel<typeof tasks>;
export type TaskRunDoc = InferSelectModel<typeof taskRuns>;
