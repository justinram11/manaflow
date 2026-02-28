import { eq } from "drizzle-orm";
import type { DbClient } from "../connection";
import { providers, providerAllocations } from "../schema/providers";
import { resolveTeamId } from "../queries/teams";

export function createProvider(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    name: string;
    registrationToken: string;
    platform: string;
    arch: string;
    osVersion?: string;
    hostname?: string;
    capabilities?: string[];
    maxConcurrentSlots?: number;
    metadata?: Record<string, string>;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const now = Date.now();
  const id = crypto.randomUUID();

  db.insert(providers)
    .values({
      id,
      name: opts.name,
      teamId,
      userId: opts.userId,
      registrationToken: opts.registrationToken,
      platform: opts.platform,
      arch: opts.arch,
      osVersion: opts.osVersion,
      hostname: opts.hostname,
      capabilities: opts.capabilities,
      maxConcurrentSlots: opts.maxConcurrentSlots ?? 4,
      status: "offline",
      metadata: opts.metadata,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return { id };
}

export function updateProvider(
  db: DbClient,
  id: string,
  patch: {
    name?: string;
    maxConcurrentSlots?: number;
    osVersion?: string;
    hostname?: string;
    capabilities?: string[];
    metadata?: Record<string, string>;
    arch?: string;
  },
) {
  db.update(providers)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(providers.id, id))
    .run();
}

export function deleteProvider(db: DbClient, id: string) {
  db.delete(providers).where(eq(providers.id, id)).run();
}

export function updateProviderStatus(
  db: DbClient,
  id: string,
  status: "online" | "offline",
) {
  db.update(providers)
    .set({
      status,
      lastHeartbeatAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(providers.id, id))
    .run();
}

export function updateProviderHeartbeat(db: DbClient, id: string) {
  db.update(providers)
    .set({ lastHeartbeatAt: Date.now(), updatedAt: Date.now() })
    .where(eq(providers.id, id))
    .run();
}

export function createAllocation(
  db: DbClient,
  opts: {
    providerId: string;
    taskRunId?: string;
    teamSlugOrId: string;
    userId: string;
    type: "compute" | "resource";
    data?: Record<string, unknown>;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const now = Date.now();
  const id = crypto.randomUUID();

  db.insert(providerAllocations)
    .values({
      id,
      providerId: opts.providerId,
      taskRunId: opts.taskRunId,
      teamId,
      userId: opts.userId,
      type: opts.type,
      status: "active",
      data: opts.data,
      createdAt: now,
    })
    .run();

  return { id };
}

export function releaseAllocation(db: DbClient, id: string) {
  db.update(providerAllocations)
    .set({ status: "released", releasedAt: Date.now() })
    .where(eq(providerAllocations.id, id))
    .run();
}

export function failAllocation(db: DbClient, id: string) {
  db.update(providerAllocations)
    .set({ status: "failed", releasedAt: Date.now() })
    .where(eq(providerAllocations.id, id))
    .run();
}
