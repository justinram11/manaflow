import { eq, desc } from "drizzle-orm";
import type { DbClient } from "../connection";
import { environments, environmentSnapshotVersions } from "../schema/index";
import { resolveTeamId } from "../queries/teams";

/**
 * Create an environment and its initial snapshot version (v1).
 * Mirrors Convex environments.create behavior.
 */
export function createEnvironment(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    name: string;
    morphSnapshotId: string;
    dataVaultKey: string;
    selectedRepos?: string[];
    description?: string;
    maintenanceScript?: string;
    devScript?: string;
    exposedPorts?: number[];
    provider?: string;
    incusSnapshotId?: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const now = Date.now();
  const id = crypto.randomUUID();

  const normalizeScript = (script: string | undefined): string | undefined => {
    if (script === undefined) return undefined;
    const trimmed = script.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const maintenanceScript = normalizeScript(opts.maintenanceScript);
  const devScript = normalizeScript(opts.devScript);

  db.insert(environments)
    .values({
      id,
      name: opts.name,
      teamId,
      userId: opts.userId,
      morphSnapshotId: opts.morphSnapshotId,
      dataVaultKey: opts.dataVaultKey,
      selectedRepos: opts.selectedRepos as unknown as null,
      description: opts.description,
      maintenanceScript,
      devScript,
      exposedPorts: opts.exposedPorts as unknown as null,
      provider: opts.provider,
      incusSnapshotId: opts.incusSnapshotId,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  // Create initial snapshot version (v1)
  const svId = crypto.randomUUID();
  db.insert(environmentSnapshotVersions)
    .values({
      id: svId,
      environmentId: id,
      teamId,
      morphSnapshotId: opts.morphSnapshotId,
      incusSnapshotId: opts.incusSnapshotId,
      version: 1,
      createdAt: now,
      createdByUserId: opts.userId,
      maintenanceScript,
      devScript,
    })
    .run();

  return id;
}

export function updateEnvironment(
  db: DbClient,
  id: string,
  patch: Record<string, unknown>,
) {
  db.update(environments)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(environments.id, id))
    .run();
}

/**
 * Update an environment's metadata, verifying team ownership.
 * Mirrors Convex environments.update behavior.
 */
export function updateEnvironmentByTeam(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    id: string;
    name?: string;
    description?: string;
    maintenanceScript?: string;
    devScript?: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const env = db
    .select()
    .from(environments)
    .where(eq(environments.id, opts.id))
    .get();
  if (!env || env.teamId !== teamId) {
    throw new Error("Environment not found");
  }

  const updates: Record<string, unknown> = { updatedAt: Date.now() };
  if (opts.name !== undefined) {
    updates.name = opts.name;
  }
  if (opts.description !== undefined) {
    updates.description = opts.description;
  }
  if (opts.maintenanceScript !== undefined) {
    const trimmed = opts.maintenanceScript.trim();
    updates.maintenanceScript = trimmed.length > 0 ? trimmed : null;
  }
  if (opts.devScript !== undefined) {
    const trimmed = opts.devScript.trim();
    updates.devScript = trimmed.length > 0 ? trimmed : null;
  }

  db.update(environments)
    .set(updates)
    .where(eq(environments.id, opts.id))
    .run();
}

/**
 * Update exposed ports on an environment, verifying team ownership.
 * Mirrors Convex environments.updateExposedPorts behavior.
 */
export function updateExposedPorts(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    id: string;
    ports: number[];
  },
): number[] {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const env = db
    .select()
    .from(environments)
    .where(eq(environments.id, opts.id))
    .get();
  if (!env || env.teamId !== teamId) {
    throw new Error("Environment not found");
  }

  const patch: Record<string, unknown> = {
    updatedAt: Date.now(),
    exposedPorts: opts.ports.length > 0 ? opts.ports : null,
  };

  db.update(environments)
    .set(patch)
    .where(eq(environments.id, opts.id))
    .run();

  return opts.ports;
}

export function removeEnvironment(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    id: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const env = db
    .select()
    .from(environments)
    .where(eq(environments.id, opts.id))
    .get();
  if (!env || env.teamId !== teamId) {
    throw new Error("Environment not found");
  }
  db.delete(environments).where(eq(environments.id, opts.id)).run();
}

export function createSnapshotVersion(
  db: DbClient,
  opts: {
    environmentId: string;
    teamId: string;
    morphSnapshotId: string;
    incusSnapshotId?: string;
    version: number;
    createdByUserId: string;
    label?: string;
    maintenanceScript?: string;
    devScript?: string;
  },
) {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.insert(environmentSnapshotVersions)
    .values({
      id,
      environmentId: opts.environmentId,
      teamId: opts.teamId,
      morphSnapshotId: opts.morphSnapshotId,
      incusSnapshotId: opts.incusSnapshotId,
      version: opts.version,
      createdAt: now,
      createdByUserId: opts.createdByUserId,
      label: opts.label,
      maintenanceScript: opts.maintenanceScript,
      devScript: opts.devScript,
    })
    .run();
  return id;
}

/**
 * Create a new snapshot version for an environment.
 * Mirrors Convex environmentSnapshots.create behavior:
 * - auto-increments the version number
 * - optionally activates the new version (default: true)
 */
export function createSnapshotVersionForEnvironment(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    environmentId: string;
    userId: string;
    morphSnapshotId: string;
    incusSnapshotId?: string;
    label?: string;
    activate?: boolean;
    maintenanceScript?: string;
    devScript?: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const env = db
    .select()
    .from(environments)
    .where(eq(environments.id, opts.environmentId))
    .get();
  if (!env || env.teamId !== teamId) {
    throw new Error("Environment not found");
  }

  // Get latest version number
  const latest = db
    .select()
    .from(environmentSnapshotVersions)
    .where(eq(environmentSnapshotVersions.environmentId, opts.environmentId))
    .orderBy(desc(environmentSnapshotVersions.version))
    .limit(1)
    .get();
  const nextVersion = (latest?.version ?? 0) + 1;

  const maintenanceScript =
    opts.maintenanceScript ?? env.maintenanceScript ?? undefined;
  const devScript = opts.devScript ?? env.devScript ?? undefined;

  const now = Date.now();
  const svId = crypto.randomUUID();
  db.insert(environmentSnapshotVersions)
    .values({
      id: svId,
      environmentId: opts.environmentId,
      teamId,
      morphSnapshotId: opts.morphSnapshotId,
      incusSnapshotId: opts.incusSnapshotId,
      version: nextVersion,
      createdAt: now,
      createdByUserId: opts.userId,
      label: opts.label,
      maintenanceScript,
      devScript,
    })
    .run();

  // Activate by default
  if (opts.activate ?? true) {
    const envPatch: Record<string, unknown> = {
      morphSnapshotId: opts.morphSnapshotId,
      maintenanceScript: maintenanceScript ?? null,
      devScript: devScript ?? null,
      updatedAt: now,
    };
    if (opts.incusSnapshotId !== undefined) {
      envPatch.incusSnapshotId = opts.incusSnapshotId;
    }
    db.update(environments)
      .set(envPatch)
      .where(eq(environments.id, opts.environmentId))
      .run();
  }

  return { snapshotVersionId: svId, version: nextVersion };
}

/**
 * Activate a specific snapshot version for an environment.
 * Mirrors Convex environmentSnapshots.activate behavior.
 */
export function activateSnapshotVersion(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    environmentId: string;
    snapshotVersionId: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const env = db
    .select()
    .from(environments)
    .where(eq(environments.id, opts.environmentId))
    .get();
  if (!env || env.teamId !== teamId) {
    throw new Error("Environment not found");
  }

  const versionDoc = db
    .select()
    .from(environmentSnapshotVersions)
    .where(eq(environmentSnapshotVersions.id, opts.snapshotVersionId))
    .get();
  if (
    !versionDoc ||
    versionDoc.environmentId !== opts.environmentId ||
    versionDoc.teamId !== teamId
  ) {
    throw new Error("Snapshot version not found");
  }

  const maintenanceScript =
    versionDoc.maintenanceScript ?? env.maintenanceScript ?? undefined;
  const devScript = versionDoc.devScript ?? env.devScript ?? undefined;

  const patch: Record<string, unknown> = {
    morphSnapshotId: versionDoc.morphSnapshotId,
    maintenanceScript: maintenanceScript ?? null,
    devScript: devScript ?? null,
    updatedAt: Date.now(),
  };
  if (versionDoc.incusSnapshotId !== undefined) {
    patch.incusSnapshotId = versionDoc.incusSnapshotId;
  }
  db.update(environments)
    .set(patch)
    .where(eq(environments.id, opts.environmentId))
    .run();

  return {
    morphSnapshotId: versionDoc.morphSnapshotId,
    version: versionDoc.version,
  };
}
