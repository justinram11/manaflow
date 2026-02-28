import { eq, and } from "drizzle-orm";
import type { DbClient } from "../connection";
import {
  workspaceSettings,
  workspaceConfigs,
  containerSettings,
  userEditorSettings,
  apiKeys,
} from "../schema/index";
import { resolveTeamId } from "./teams";

export function getWorkspaceSettings(
  db: DbClient,
  teamSlugOrId: string,
  userId: string,
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db
    .select()
    .from(workspaceSettings)
    .where(
      and(
        eq(workspaceSettings.teamId, teamId),
        eq(workspaceSettings.userId, userId),
      ),
    )
    .get();
}

export function getContainerSettings(
  db: DbClient,
  teamSlugOrId: string,
  userId: string,
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db
    .select()
    .from(containerSettings)
    .where(
      and(
        eq(containerSettings.teamId, teamId),
        eq(containerSettings.userId, userId),
      ),
    )
    .get();
}

export function getUserEditorSettings(
  db: DbClient,
  teamSlugOrId: string,
  userId: string,
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db
    .select()
    .from(userEditorSettings)
    .where(
      and(
        eq(userEditorSettings.teamId, teamId),
        eq(userEditorSettings.userId, userId),
      ),
    )
    .get();
}

export function getApiKeysByTeamUser(
  db: DbClient,
  teamSlugOrId: string,
  userId: string,
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.teamId, teamId), eq(apiKeys.userId, userId)))
    .all();
}

export function getApiKeysForAgents(
  db: DbClient,
  teamSlugOrId: string,
  userId: string,
): Record<string, string> {
  const teamId = resolveTeamId(db, teamSlugOrId);
  const keys = db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.teamId, teamId), eq(apiKeys.userId, userId)))
    .all();
  const keyMap: Record<string, string> = {};
  for (const key of keys) {
    if (key.envVar && key.value) {
      keyMap[key.envVar] = key.value;
    }
  }
  return keyMap;
}

export function getApiKeyByEnvVar(
  db: DbClient,
  teamSlugOrId: string,
  userId: string,
  envVar: string,
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.teamId, teamId),
        eq(apiKeys.userId, userId),
        eq(apiKeys.envVar, envVar),
      ),
    )
    .get();
}

const DEFAULT_CONTAINER_SETTINGS = {
  maxRunningContainers: 5,
  reviewPeriodMinutes: 60,
  autoCleanupEnabled: true,
  stopImmediatelyOnCompletion: false,
  minContainersToKeep: 0,
};

export function getEffectiveContainerSettings(
  db: DbClient,
  teamSlugOrId: string,
  userId: string,
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  const settings = db
    .select()
    .from(containerSettings)
    .where(
      and(
        eq(containerSettings.teamId, teamId),
        eq(containerSettings.userId, userId),
      ),
    )
    .get();
  return {
    maxRunningContainers:
      settings?.maxRunningContainers ?? DEFAULT_CONTAINER_SETTINGS.maxRunningContainers,
    reviewPeriodMinutes:
      settings?.reviewPeriodMinutes ?? DEFAULT_CONTAINER_SETTINGS.reviewPeriodMinutes,
    autoCleanupEnabled:
      settings?.autoCleanupEnabled ?? DEFAULT_CONTAINER_SETTINGS.autoCleanupEnabled,
    stopImmediatelyOnCompletion:
      settings?.stopImmediatelyOnCompletion ?? DEFAULT_CONTAINER_SETTINGS.stopImmediatelyOnCompletion,
    minContainersToKeep:
      settings?.minContainersToKeep ?? DEFAULT_CONTAINER_SETTINGS.minContainersToKeep,
  };
}

export function getWorkspaceConfig(
  db: DbClient,
  teamSlugOrId: string,
  userId: string,
  projectFullName: string,
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db
    .select()
    .from(workspaceConfigs)
    .where(
      and(
        eq(workspaceConfigs.teamId, teamId),
        eq(workspaceConfigs.userId, userId),
        eq(workspaceConfigs.projectFullName, projectFullName),
      ),
    )
    .get();
}
