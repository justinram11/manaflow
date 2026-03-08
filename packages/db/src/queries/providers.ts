import { eq, and, type InferSelectModel } from "drizzle-orm";
import type { DbClient } from "../connection";
import { providers, providerAllocations } from "../schema/providers";
import { resolveTeamId } from "./teams";

type Provider = InferSelectModel<typeof providers>;

export function listByTeam(db: DbClient, teamSlugOrId: string) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db.select().from(providers).where(eq(providers.teamId, teamId)).all();
}

export function getById(db: DbClient, id: string) {
  return db.select().from(providers).where(eq(providers.id, id)).get();
}

export function getByToken(db: DbClient, hashedToken: string) {
  return db
    .select()
    .from(providers)
    .where(eq(providers.registrationToken, hashedToken))
    .get();
}

export function getOnlineByCapability(db: DbClient, teamSlugOrId: string, capability: string) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  // SQLite JSON: filter by status=online, then check capabilities in JS
  const onlineProviders = db
    .select()
    .from(providers)
    .where(and(eq(providers.teamId, teamId), eq(providers.status, "online")))
    .all();

  return onlineProviders.filter((p: Provider) => p.capabilities?.includes(capability));
}

export function isProviderAtCapacity(
  provider: { id: string; maxConcurrentSlots?: number | null },
  activeAllocationCount: number,
) {
  return activeAllocationCount >= (provider.maxConcurrentSlots ?? 4);
}

export function getAvailableOnlineByCapability(
  db: DbClient,
  teamSlugOrId: string,
  capability: string,
) {
  return getOnlineByCapability(db, teamSlugOrId, capability).filter(
    (provider: Provider) => {
      const activeAllocations = listActiveAllocationsByProvider(db, provider.id);
      return !isProviderAtCapacity(provider, activeAllocations.length);
    },
  );
}

export function listAllocations(
  db: DbClient,
  opts: { providerId?: string; taskRunId?: string; status?: string },
) {
  const conditions = [];
  if (opts.providerId) {
    conditions.push(eq(providerAllocations.providerId, opts.providerId));
  }
  if (opts.taskRunId) {
    conditions.push(eq(providerAllocations.taskRunId, opts.taskRunId));
  }
  if (opts.status) {
    conditions.push(eq(providerAllocations.status, opts.status));
  }
  if (conditions.length === 0) {
    return db.select().from(providerAllocations).all();
  }
  return db
    .select()
    .from(providerAllocations)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .all();
}

export function getAllocationById(db: DbClient, id: string) {
  return db.select().from(providerAllocations).where(eq(providerAllocations.id, id)).get();
}

export function listActiveAllocationsByProvider(db: DbClient, providerId: string) {
  return db
    .select()
    .from(providerAllocations)
    .where(
      and(
        eq(providerAllocations.providerId, providerId),
        eq(providerAllocations.status, "active"),
      ),
    )
    .all();
}
