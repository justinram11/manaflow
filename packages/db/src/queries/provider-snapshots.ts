import { eq, and } from "drizzle-orm";
import type { DbClient } from "../connection";
import { providerSnapshots } from "../schema/provider-snapshots";
import { resolveTeamId } from "./teams";

export function listByProvider(db: DbClient, providerId: string) {
  return db
    .select()
    .from(providerSnapshots)
    .where(eq(providerSnapshots.providerId, providerId))
    .all();
}

export function listByTeam(db: DbClient, teamSlugOrId: string) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db
    .select()
    .from(providerSnapshots)
    .where(eq(providerSnapshots.teamId, teamId))
    .all();
}

export function getById(db: DbClient, id: string) {
  return db
    .select()
    .from(providerSnapshots)
    .where(eq(providerSnapshots.id, id))
    .get();
}

export function getByExternalId(db: DbClient, providerId: string, externalId: string) {
  return db
    .select()
    .from(providerSnapshots)
    .where(
      and(
        eq(providerSnapshots.providerId, providerId),
        eq(providerSnapshots.externalId, externalId),
      ),
    )
    .get();
}
