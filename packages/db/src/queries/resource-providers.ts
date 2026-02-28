import { eq, and } from "drizzle-orm";
import type { DbClient } from "../connection";
import { resourceProviders, resourceAllocations } from "../schema/resource-providers";
import { resolveTeamId } from "./teams";

export function listByTeam(db: DbClient, teamSlugOrId: string) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db.select().from(resourceProviders).where(eq(resourceProviders.teamId, teamId)).all();
}

export function getById(db: DbClient, id: string) {
  return db.select().from(resourceProviders).where(eq(resourceProviders.id, id)).get();
}

export function getByToken(db: DbClient, hashedToken: string) {
  return db
    .select()
    .from(resourceProviders)
    .where(eq(resourceProviders.registrationToken, hashedToken))
    .get();
}

export function listAllocations(
  db: DbClient,
  opts: { resourceProviderId?: string; taskRunId?: string; status?: string },
) {
  const conditions = [];
  if (opts.resourceProviderId) {
    conditions.push(eq(resourceAllocations.resourceProviderId, opts.resourceProviderId));
  }
  if (opts.taskRunId) {
    conditions.push(eq(resourceAllocations.taskRunId, opts.taskRunId));
  }
  if (opts.status) {
    conditions.push(eq(resourceAllocations.status, opts.status));
  }
  if (conditions.length === 0) {
    return db.select().from(resourceAllocations).all();
  }
  return db
    .select()
    .from(resourceAllocations)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .all();
}

export function getAllocationById(db: DbClient, id: string) {
  return db.select().from(resourceAllocations).where(eq(resourceAllocations.id, id)).get();
}

export function listActiveAllocationsByProvider(db: DbClient, resourceProviderId: string) {
  return db
    .select()
    .from(resourceAllocations)
    .where(
      and(
        eq(resourceAllocations.resourceProviderId, resourceProviderId),
        eq(resourceAllocations.status, "active"),
      ),
    )
    .all();
}
