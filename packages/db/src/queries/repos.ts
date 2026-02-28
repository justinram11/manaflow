import { eq, and } from "drizzle-orm";
import type { DbClient } from "../connection";
import { repos, branches, providerConnections } from "../schema/index";
import { resolveTeamId } from "./teams";

export function getReposByTeam(db: DbClient, teamSlugOrId: string) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db
    .select()
    .from(repos)
    .where(eq(repos.teamId, teamId))
    .all();
}

export function hasReposForTeam(db: DbClient, teamSlugOrId: string): boolean {
  const teamId = resolveTeamId(db, teamSlugOrId);
  const result = db
    .select()
    .from(repos)
    .where(eq(repos.teamId, teamId))
    .limit(1)
    .all();
  return result.length > 0;
}

export function getReposByOrg(
  db: DbClient,
  teamSlugOrId: string,
  userId: string,
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  const allRepos = db
    .select()
    .from(repos)
    .where(and(eq(repos.teamId, teamId), eq(repos.userId, userId)))
    .all();
  const byOrg: Record<string, (typeof allRepos)> = {};
  for (const repo of allRepos) {
    const org = repo.org ?? "unknown";
    if (!byOrg[org]) byOrg[org] = [];
    byOrg[org].push(repo);
  }
  return byOrg;
}

export function getRepoByFullName(
  db: DbClient,
  teamSlugOrId: string,
  fullName: string,
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db
    .select()
    .from(repos)
    .where(and(eq(repos.teamId, teamId), eq(repos.fullName, fullName)))
    .get();
}

export function getBranchesByRepo(db: DbClient, repoName: string) {
  return db
    .select()
    .from(branches)
    .where(eq(branches.repo, repoName))
    .all();
}

export function getBranchesByTeam(db: DbClient, teamSlugOrId: string) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db
    .select()
    .from(branches)
    .where(eq(branches.teamId, teamId))
    .all();
}

export function listProviderConnections(
  db: DbClient,
  teamSlugOrId: string,
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return db
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.teamId, teamId))
    .all();
}

export function getProviderConnectionByInstallation(
  db: DbClient,
  installationId: number,
) {
  return db
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.installationId, installationId))
    .get();
}
