import { eq, and } from "drizzle-orm";
import type { DbClient } from "../connection";
import { previewConfigs, environments } from "../schema/index";
import { resolveTeamId } from "../queries/teams";

function normalizeRepoFullName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.includes("/")) {
    throw new Error("repoFullName must be in the form owner/name");
  }
  return trimmed.replace(/\.git$/i, "").toLowerCase();
}

/**
 * Create or update a preview configuration.
 * Equivalent to Convex `api.previewConfigs.upsert`.
 */
export function upsertPreviewConfig(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    repoFullName: string;
    environmentId?: string;
    repoInstallationId?: number;
    repoDefaultBranch?: string;
    status?: "active" | "paused" | "disabled";
  },
): string {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const repoFullName = normalizeRepoFullName(opts.repoFullName);
  const now = Date.now();

  // Verify environment exists and belongs to team if provided
  if (opts.environmentId) {
    const environment = db
      .select()
      .from(environments)
      .where(eq(environments.id, opts.environmentId))
      .get();
    if (!environment || environment.teamId !== teamId) {
      throw new Error("Environment not found");
    }
  }

  const existing = db
    .select()
    .from(previewConfigs)
    .where(
      and(
        eq(previewConfigs.teamId, teamId),
        eq(previewConfigs.repoFullName, repoFullName),
      ),
    )
    .get();

  if (existing) {
    db.update(previewConfigs)
      .set({
        environmentId: opts.environmentId ?? existing.environmentId,
        repoInstallationId:
          opts.repoInstallationId ?? existing.repoInstallationId,
        repoDefaultBranch:
          opts.repoDefaultBranch ?? existing.repoDefaultBranch,
        status: opts.status ?? existing.status ?? "active",
        updatedAt: now,
      })
      .where(eq(previewConfigs.id, existing.id))
      .run();
    return existing.id;
  }

  const id = crypto.randomUUID();
  db.insert(previewConfigs)
    .values({
      id,
      teamId,
      createdByUserId: opts.userId,
      repoFullName,
      repoProvider: "github",
      environmentId: opts.environmentId,
      repoInstallationId: opts.repoInstallationId,
      repoDefaultBranch: opts.repoDefaultBranch,
      status: opts.status ?? "active",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

/**
 * Delete a preview configuration.
 * Equivalent to Convex `api.previewConfigs.remove`.
 */
export function removePreviewConfig(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    previewConfigId: string;
  },
): { id: string } {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const config = db
    .select()
    .from(previewConfigs)
    .where(eq(previewConfigs.id, opts.previewConfigId))
    .get();
  if (!config || config.teamId !== teamId) {
    throw new Error("Preview config not found");
  }
  db.delete(previewConfigs)
    .where(eq(previewConfigs.id, opts.previewConfigId))
    .run();
  return { id: opts.previewConfigId };
}
