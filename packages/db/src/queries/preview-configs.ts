import { eq, and, desc } from "drizzle-orm";
import type { DbClient } from "../connection";
import { previewConfigs } from "../schema/index";
import { resolveTeamId } from "./teams";

function normalizeRepoFullName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.includes("/")) {
    throw new Error("repoFullName must be in the form owner/name");
  }
  return trimmed.replace(/\.git$/i, "").toLowerCase();
}

export { normalizeRepoFullName };

export function listByTeam(db: DbClient, teamSlugOrId: string) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db
    .select()
    .from(previewConfigs)
    .where(eq(previewConfigs.teamId, teamId))
    .orderBy(desc(previewConfigs.updatedAt))
    .all();
}

export function getById(db: DbClient, id: string) {
  return db.select().from(previewConfigs).where(eq(previewConfigs.id, id)).get();
}

export function getByTeamAndId(
  db: DbClient,
  opts: { teamSlugOrId: string; previewConfigId: string },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const config = db
    .select()
    .from(previewConfigs)
    .where(eq(previewConfigs.id, opts.previewConfigId))
    .get();
  if (!config || config.teamId !== teamId) {
    return null;
  }
  return config;
}

export function getByTeamAndRepo(
  db: DbClient,
  opts: { teamSlugOrId: string; repoFullName: string },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const repoFullName = normalizeRepoFullName(opts.repoFullName);
  return (
    db
      .select()
      .from(previewConfigs)
      .where(
        and(
          eq(previewConfigs.teamId, teamId),
          eq(previewConfigs.repoFullName, repoFullName),
        ),
      )
      .get() ?? null
  );
}

export function getByTeamIdAndRepo(
  db: DbClient,
  opts: { teamId: string; repoFullName: string },
) {
  const repoFullName = normalizeRepoFullName(opts.repoFullName);
  return (
    db
      .select()
      .from(previewConfigs)
      .where(
        and(
          eq(previewConfigs.teamId, opts.teamId),
          eq(previewConfigs.repoFullName, repoFullName),
        ),
      )
      .get() ?? null
  );
}
