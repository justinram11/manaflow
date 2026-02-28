import { eq, and, desc } from "drizzle-orm";
import type { DbClient } from "../connection";
import { environments, environmentSnapshotVersions } from "../schema/index";
import { resolveTeamId } from "./teams";

export function getEnvironmentById(db: DbClient, id: string) {
  return db.select().from(environments).where(eq(environments.id, id)).get();
}

/**
 * Get an environment by id, verifying it belongs to the given team.
 * Returns null if not found or team mismatch.
 */
export function getEnvironmentByTeam(
  db: DbClient,
  teamSlugOrId: string,
  id: string,
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  const env = db
    .select()
    .from(environments)
    .where(eq(environments.id, id))
    .get();
  if (!env || env.teamId !== teamId) return null;
  return env;
}

export function listEnvironments(
  db: DbClient,
  teamSlugOrId: string,
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db
    .select()
    .from(environments)
    .where(eq(environments.teamId, teamId))
    .orderBy(desc(environments.createdAt))
    .all();
}

export function listEnvironmentsByTeamUser(
  db: DbClient,
  teamSlugOrId: string,
  userId: string,
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db
    .select()
    .from(environments)
    .where(
      and(eq(environments.teamId, teamId), eq(environments.userId, userId)),
    )
    .orderBy(desc(environments.createdAt))
    .all();
}

export function getSnapshotVersions(db: DbClient, environmentId: string) {
  return db
    .select()
    .from(environmentSnapshotVersions)
    .where(eq(environmentSnapshotVersions.environmentId, environmentId))
    .orderBy(desc(environmentSnapshotVersions.version))
    .all();
}

/**
 * List snapshot versions for an environment with isActive computed.
 * Mirrors Convex environmentSnapshots.list behavior.
 */
export function listSnapshotVersionsWithActive(
  db: DbClient,
  teamSlugOrId: string,
  environmentId: string,
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  const env = db
    .select()
    .from(environments)
    .where(eq(environments.id, environmentId))
    .get();
  if (!env || env.teamId !== teamId) {
    throw new Error("Environment not found");
  }

  const versions = db
    .select()
    .from(environmentSnapshotVersions)
    .where(eq(environmentSnapshotVersions.environmentId, environmentId))
    .orderBy(desc(environmentSnapshotVersions.version))
    .all();

  const isIncus = env.provider === "incus";
  return versions.map((version) => ({
    ...version,
    isActive: isIncus
      ? version.incusSnapshotId === env.incusSnapshotId
      : version.morphSnapshotId === env.morphSnapshotId,
  }));
}

/**
 * Get a specific snapshot version by id.
 */
export function getSnapshotVersionById(db: DbClient, id: string) {
  return db
    .select()
    .from(environmentSnapshotVersions)
    .where(eq(environmentSnapshotVersions.id, id))
    .get();
}

/**
 * Find a snapshot version by team and morph snapshot ID.
 * Equivalent to Convex `api.environmentSnapshots.findBySnapshotId`.
 */
export function findSnapshotVersionBySnapshotId(
  db: DbClient,
  teamSlugOrId: string,
  snapshotId: string,
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db
    .select()
    .from(environmentSnapshotVersions)
    .where(
      and(
        eq(environmentSnapshotVersions.teamId, teamId),
        eq(environmentSnapshotVersions.morphSnapshotId, snapshotId),
      ),
    )
    .get() ?? null;
}
