import { eq, type InferSelectModel } from "drizzle-orm";
import type { DbClient } from "../connection";
import { morphInstanceActivity, taskRuns } from "../schema/index";
import { resolveTeamId } from "../queries/teams";

type TaskRun = InferSelectModel<typeof taskRuns>;

/**
 * Record that a Morph instance was resumed (authenticated).
 * Verifies the task run belongs to the given team before recording.
 * Equivalent to Convex `api.morphInstances.recordResume`.
 */
export function recordResume(
  db: DbClient,
  opts: {
    instanceId: string;
    teamSlugOrId: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);

  // Find the taskRun that uses this instance to verify ownership
  const allRuns = db.select().from(taskRuns).where(eq(taskRuns.teamId, teamId)).all();
  const taskRun = allRuns.find((run: TaskRun) => {
    const vscode = run.vscode as Record<string, unknown> | null;
    return vscode?.containerName === opts.instanceId;
  });

  if (!taskRun) {
    throw new Error("Instance not found or not authorized");
  }

  const existing = db
    .select()
    .from(morphInstanceActivity)
    .where(eq(morphInstanceActivity.instanceId, opts.instanceId))
    .get();

  if (existing) {
    db.update(morphInstanceActivity)
      .set({ lastResumedAt: Date.now() })
      .where(eq(morphInstanceActivity.id, existing.id))
      .run();
  } else {
    db.insert(morphInstanceActivity)
      .values({
        id: crypto.randomUUID(),
        instanceId: opts.instanceId,
        lastResumedAt: Date.now(),
      })
      .run();
  }
}
