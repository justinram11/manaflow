import { eq, and, desc } from "drizzle-orm";
import type { DbClient } from "../connection";
import { previewRuns, previewConfigs } from "../schema/index";
import { resolveTeamId } from "./teams";

export function getById(db: DbClient, id: string) {
  return db.select().from(previewRuns).where(eq(previewRuns.id, id)).get();
}

export function listByConfig(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    previewConfigId: string;
    limit?: number;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const config = db
    .select()
    .from(previewConfigs)
    .where(eq(previewConfigs.id, opts.previewConfigId))
    .get();
  if (!config || config.teamId !== teamId) {
    throw new Error("Preview configuration not found");
  }
  const take = Math.max(1, Math.min(opts.limit ?? 25, 100));
  return db
    .select()
    .from(previewRuns)
    .where(
      and(
        eq(previewRuns.teamId, teamId),
        eq(previewRuns.previewConfigId, config.id),
      ),
    )
    .orderBy(desc(previewRuns.createdAt))
    .limit(take)
    .all();
}
