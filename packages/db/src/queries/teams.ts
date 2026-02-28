import { eq, and } from "drizzle-orm";
import type { DbClient } from "../connection";
import { teams, teamMemberships } from "../schema/index";

export function getTeamByTeamId(db: DbClient, teamId: string) {
  return db.select().from(teams).where(eq(teams.teamId, teamId)).get();
}

export function getTeamBySlug(db: DbClient, slug: string) {
  return db.select().from(teams).where(eq(teams.slug, slug)).get();
}

export function getTeamById(db: DbClient, id: string) {
  return db.select().from(teams).where(eq(teams.id, id)).get();
}

export function getTeamBySlugOrId(db: DbClient, teamSlugOrId: string) {
  // Try by teamId first
  const byTeamId = db
    .select()
    .from(teams)
    .where(eq(teams.teamId, teamSlugOrId))
    .get();
  if (byTeamId) return byTeamId;

  // Try by slug
  const bySlug = db
    .select()
    .from(teams)
    .where(eq(teams.slug, teamSlugOrId))
    .get();
  if (bySlug) return bySlug;

  return null;
}

/**
 * Resolve a teamSlugOrId to a canonical teamId.
 * Accepts either a slug or a teamId.
 */
export function resolveTeamId(db: DbClient, teamSlugOrId: string): string {
  // Try by teamId first (exact match on teams.teamId)
  const byTeamId = db
    .select()
    .from(teams)
    .where(eq(teams.teamId, teamSlugOrId))
    .get();
  if (byTeamId) return byTeamId.teamId;

  // Try by slug
  const bySlug = db
    .select()
    .from(teams)
    .where(eq(teams.slug, teamSlugOrId))
    .get();
  if (bySlug) return bySlug.teamId;

  throw new Error(`Team not found: ${teamSlugOrId}`);
}

export function listTeamMemberships(db: DbClient, userId: string) {
  return db
    .select()
    .from(teamMemberships)
    .innerJoin(teams, eq(teamMemberships.teamId, teams.teamId))
    .where(eq(teamMemberships.userId, userId))
    .all();
}

export function getTeamMembership(
  db: DbClient,
  teamId: string,
  userId: string,
) {
  return db
    .select()
    .from(teamMemberships)
    .where(
      and(
        eq(teamMemberships.teamId, teamId),
        eq(teamMemberships.userId, userId),
      ),
    )
    .get();
}
