import { eq } from "drizzle-orm";
import type { DbClient } from "../connection";
import { resourceProviders, resourceAllocations } from "../schema/resource-providers";
import { resolveTeamId } from "../queries/teams";

export function createResourceProvider(
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
    maxConcurrentBuilds?: number;
    xcodeVersion?: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const now = Date.now();
  const id = crypto.randomUUID();

  db.insert(resourceProviders)
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
      maxConcurrentBuilds: opts.maxConcurrentBuilds ?? 2,
      status: "offline",
      xcodeVersion: opts.xcodeVersion,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return { id };
}

export function updateResourceProvider(
  db: DbClient,
  id: string,
  patch: {
    name?: string;
    maxConcurrentBuilds?: number;
    osVersion?: string;
    hostname?: string;
    capabilities?: string[];
    xcodeVersion?: string;
    arch?: string;
  },
) {
  db.update(resourceProviders)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(resourceProviders.id, id))
    .run();
}

export function deleteResourceProvider(db: DbClient, id: string) {
  db.delete(resourceProviders).where(eq(resourceProviders.id, id)).run();
}

export function updateProviderStatus(
  db: DbClient,
  id: string,
  status: "online" | "offline",
) {
  db.update(resourceProviders)
    .set({
      status,
      lastHeartbeatAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(resourceProviders.id, id))
    .run();
}

export function updateProviderHeartbeat(db: DbClient, id: string) {
  db.update(resourceProviders)
    .set({ lastHeartbeatAt: Date.now(), updatedAt: Date.now() })
    .where(eq(resourceProviders.id, id))
    .run();
}

export function createAllocation(
  db: DbClient,
  opts: {
    resourceProviderId: string;
    taskRunId?: string;
    teamSlugOrId: string;
    userId: string;
    platform?: string;
    simulatorDeviceType?: string;
    simulatorRuntime?: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const now = Date.now();
  const id = crypto.randomUUID();
  const buildDir = `/tmp/cmux-builds/${id}`;

  db.insert(resourceAllocations)
    .values({
      id,
      resourceProviderId: opts.resourceProviderId,
      taskRunId: opts.taskRunId,
      teamId,
      userId: opts.userId,
      status: "active",
      buildDir,
      platform: opts.platform ?? "ios",
      simulatorDeviceType: opts.simulatorDeviceType,
      simulatorRuntime: opts.simulatorRuntime,
      createdAt: now,
    })
    .run();

  return { id, buildDir };
}

export function updateAllocationSimulator(
  db: DbClient,
  id: string,
  simulatorUdid: string,
) {
  db.update(resourceAllocations)
    .set({ simulatorUdid })
    .where(eq(resourceAllocations.id, id))
    .run();
}

export function releaseAllocation(db: DbClient, id: string) {
  db.update(resourceAllocations)
    .set({ status: "released", releasedAt: Date.now() })
    .where(eq(resourceAllocations.id, id))
    .run();
}

export function failAllocation(db: DbClient, id: string) {
  db.update(resourceAllocations)
    .set({ status: "failed", releasedAt: Date.now() })
    .where(eq(resourceAllocations.id, id))
    .run();
}
