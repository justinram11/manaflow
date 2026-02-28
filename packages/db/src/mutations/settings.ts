import { eq, and } from "drizzle-orm";
import type { DbClient } from "../connection";
import {
  workspaceSettings,
  workspaceConfigs,
  containerSettings,
  userEditorSettings,
  apiKeys,
} from "../schema/index";
import { resolveTeamId } from "../queries/teams";

export function upsertWorkspaceSettings(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    patch: Record<string, unknown>;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const existing = db
    .select()
    .from(workspaceSettings)
    .where(
      and(
        eq(workspaceSettings.teamId, teamId),
        eq(workspaceSettings.userId, opts.userId),
      ),
    )
    .get();

  const now = Date.now();
  if (existing) {
    db.update(workspaceSettings)
      .set({ ...opts.patch, updatedAt: now })
      .where(eq(workspaceSettings.id, existing.id))
      .run();
    return existing.id;
  } else {
    const id = crypto.randomUUID();
    db.insert(workspaceSettings)
      .values({
        id,
        teamId,
        userId: opts.userId,
        createdAt: now,
        updatedAt: now,
        ...opts.patch,
      })
      .run();
    return id;
  }
}

export function upsertContainerSettings(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    patch: Record<string, unknown>;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const existing = db
    .select()
    .from(containerSettings)
    .where(
      and(
        eq(containerSettings.teamId, teamId),
        eq(containerSettings.userId, opts.userId),
      ),
    )
    .get();

  const now = Date.now();
  if (existing) {
    db.update(containerSettings)
      .set({ ...opts.patch, updatedAt: now })
      .where(eq(containerSettings.id, existing.id))
      .run();
    return existing.id;
  } else {
    const id = crypto.randomUUID();
    db.insert(containerSettings)
      .values({
        id,
        teamId,
        userId: opts.userId,
        createdAt: now,
        updatedAt: now,
        ...opts.patch,
      })
      .run();
    return id;
  }
}

export function upsertUserEditorSettings(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    patch: Record<string, unknown>;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const existing = db
    .select()
    .from(userEditorSettings)
    .where(
      and(
        eq(userEditorSettings.teamId, teamId),
        eq(userEditorSettings.userId, opts.userId),
      ),
    )
    .get();

  const now = Date.now();
  if (existing) {
    db.update(userEditorSettings)
      .set({ ...opts.patch, updatedAt: now })
      .where(eq(userEditorSettings.id, existing.id))
      .run();
    return existing.id;
  } else {
    const id = crypto.randomUUID();
    db.insert(userEditorSettings)
      .values({
        id,
        teamId,
        userId: opts.userId,
        updatedAt: now,
        ...opts.patch,
      })
      .run();
    return id;
  }
}

export function upsertApiKey(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    envVar: string;
    value: string;
    displayName: string;
    description?: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const existing = db
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.teamId, teamId),
        eq(apiKeys.userId, opts.userId),
        eq(apiKeys.envVar, opts.envVar),
      ),
    )
    .get();

  const now = Date.now();
  if (existing) {
    db.update(apiKeys)
      .set({
        value: opts.value,
        displayName: opts.displayName,
        description: opts.description,
        updatedAt: now,
      })
      .where(eq(apiKeys.id, existing.id))
      .run();
    return existing.id;
  } else {
    const id = crypto.randomUUID();
    db.insert(apiKeys)
      .values({
        id,
        teamId,
        userId: opts.userId,
        envVar: opts.envVar,
        value: opts.value,
        displayName: opts.displayName,
        description: opts.description,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return id;
  }
}

export function clearUserEditorSettings(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const existing = db
    .select()
    .from(userEditorSettings)
    .where(
      and(
        eq(userEditorSettings.teamId, teamId),
        eq(userEditorSettings.userId, opts.userId),
      ),
    )
    .get();

  if (existing) {
    db.delete(userEditorSettings)
      .where(eq(userEditorSettings.id, existing.id))
      .run();
  }
}

export function upsertWorkspaceConfig(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    projectFullName: string;
    maintenanceScript?: string;
    dataVaultKey?: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const existing = db
    .select()
    .from(workspaceConfigs)
    .where(
      and(
        eq(workspaceConfigs.teamId, teamId),
        eq(workspaceConfigs.userId, opts.userId),
        eq(workspaceConfigs.projectFullName, opts.projectFullName),
      ),
    )
    .get();

  const now = Date.now();
  if (existing) {
    db.update(workspaceConfigs)
      .set({
        maintenanceScript: opts.maintenanceScript,
        dataVaultKey: opts.dataVaultKey,
        updatedAt: now,
      })
      .where(eq(workspaceConfigs.id, existing.id))
      .run();
    return existing.id;
  } else {
    const id = crypto.randomUUID();
    db.insert(workspaceConfigs)
      .values({
        id,
        teamId,
        userId: opts.userId,
        projectFullName: opts.projectFullName,
        maintenanceScript: opts.maintenanceScript,
        dataVaultKey: opts.dataVaultKey,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return id;
  }
}

export function deleteApiKey(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    envVar: string;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const existing = db
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.teamId, teamId),
        eq(apiKeys.userId, opts.userId),
        eq(apiKeys.envVar, opts.envVar),
      ),
    )
    .get();

  if (!existing) throw new Error("API key not found");
  db.delete(apiKeys).where(eq(apiKeys.id, existing.id)).run();
}
