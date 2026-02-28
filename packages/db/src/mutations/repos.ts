import { eq, and } from "drizzle-orm";
import type { DbClient } from "../connection";
import { repos, branches, installStates } from "../schema/index";
import { resolveTeamId } from "../queries/teams";

export function upsertRepo(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    fullName: string;
    org: string;
    name: string;
    gitRemote: string;
    provider?: string;
    providerRepoId?: number;
    ownerLogin?: string;
    ownerType?: string;
    visibility?: string;
    defaultBranch?: string;
    connectionId?: string;
    manual?: boolean;
  },
) {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const existing = db
    .select()
    .from(repos)
    .where(and(eq(repos.teamId, teamId), eq(repos.fullName, opts.fullName)))
    .get();

  const now = Date.now();
  if (existing) {
    db.update(repos)
      .set({
        gitRemote: opts.gitRemote,
        provider: opts.provider,
        providerRepoId: opts.providerRepoId,
        ownerLogin: opts.ownerLogin,
        ownerType: opts.ownerType,
        visibility: opts.visibility,
        defaultBranch: opts.defaultBranch,
        connectionId: opts.connectionId,
        lastSyncedAt: now,
      })
      .where(eq(repos.id, existing.id))
      .run();
    return existing.id;
  } else {
    const id = crypto.randomUUID();
    db.insert(repos)
      .values({
        id,
        fullName: opts.fullName,
        org: opts.org,
        name: opts.name,
        gitRemote: opts.gitRemote,
        provider: opts.provider,
        userId: opts.userId,
        teamId,
        providerRepoId: opts.providerRepoId,
        ownerLogin: opts.ownerLogin,
        ownerType: opts.ownerType,
        visibility: opts.visibility,
        defaultBranch: opts.defaultBranch,
        connectionId: opts.connectionId,
        manual: opts.manual,
      })
      .run();
    return id;
  }
}

export function bulkInsertRepos(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    repos: Array<{
      fullName: string;
      org: string;
      name: string;
      gitRemote: string;
      provider?: string;
    }>;
  },
): string[] {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const existing = db
    .select()
    .from(repos)
    .where(and(eq(repos.teamId, teamId), eq(repos.userId, opts.userId)))
    .all();
  const existingNames = new Set(existing.map((r) => r.fullName));
  const newRepos = opts.repos.filter((r) => !existingNames.has(r.fullName));
  const now = Date.now();
  const ids: string[] = [];
  for (const repo of newRepos) {
    const id = crypto.randomUUID();
    db.insert(repos)
      .values({
        id,
        fullName: repo.fullName,
        org: repo.org,
        name: repo.name,
        gitRemote: repo.gitRemote,
        provider: repo.provider ?? "github",
        userId: opts.userId,
        teamId,
        lastSyncedAt: now,
      })
      .run();
    ids.push(id);
  }
  return ids;
}

export function bulkUpsertBranchesWithActivity(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    repo: string;
    branches: Array<{
      name: string;
      lastActivityAt?: number;
      lastCommitSha?: string;
      lastKnownBaseSha?: string;
      lastKnownMergeCommitSha?: string;
    }>;
  },
): string[] {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);
  const existing = db
    .select()
    .from(branches)
    .where(
      and(
        eq(branches.repo, opts.repo),
        eq(branches.teamId, teamId),
        eq(branches.userId, opts.userId),
      ),
    )
    .all();
  const byName = new Map(existing.map((b) => [b.name, b] as const));

  const now = Date.now();
  const ids: string[] = [];

  for (const b of opts.branches) {
    const row = byName.get(b.name);
    if (row) {
      const patch: Record<string, unknown> = {};
      if (typeof b.lastActivityAt === "number" && b.lastActivityAt !== row.lastActivityAt) {
        patch.lastActivityAt = b.lastActivityAt;
      }
      if (b.lastCommitSha && b.lastCommitSha !== row.lastCommitSha) {
        patch.lastCommitSha = b.lastCommitSha;
      }
      if (b.lastKnownBaseSha && b.lastKnownBaseSha !== row.lastKnownBaseSha) {
        patch.lastKnownBaseSha = b.lastKnownBaseSha;
      }
      if (b.lastKnownMergeCommitSha && b.lastKnownMergeCommitSha !== row.lastKnownMergeCommitSha) {
        patch.lastKnownMergeCommitSha = b.lastKnownMergeCommitSha;
      }
      if (Object.keys(patch).length > 0) {
        db.update(branches).set(patch).where(eq(branches.id, row.id)).run();
      }
      ids.push(row.id);
    } else {
      const id = crypto.randomUUID();
      db.insert(branches)
        .values({
          id,
          repo: opts.repo,
          name: b.name,
          userId: opts.userId,
          teamId,
          lastCommitSha: b.lastCommitSha,
          lastActivityAt: b.lastActivityAt ?? now,
          lastKnownBaseSha: b.lastKnownBaseSha,
          lastKnownMergeCommitSha: b.lastKnownMergeCommitSha,
        })
        .run();
      ids.push(id);
    }
  }

  return ids;
}

export function upsertBranch(
  db: DbClient,
  opts: {
    repo: string;
    repoId?: string;
    name: string;
    userId: string;
    teamId: string;
    lastCommitSha?: string;
    lastActivityAt?: number;
  },
) {
  const existing = db
    .select()
    .from(branches)
    .where(and(eq(branches.repo, opts.repo), eq(branches.name, opts.name)))
    .get();

  if (existing) {
    db.update(branches)
      .set({
        lastCommitSha: opts.lastCommitSha,
        lastActivityAt: opts.lastActivityAt,
      })
      .where(eq(branches.id, existing.id))
      .run();
    return existing.id;
  } else {
    const id = crypto.randomUUID();
    db.insert(branches)
      .values({
        id,
        repo: opts.repo,
        repoId: opts.repoId,
        name: opts.name,
        userId: opts.userId,
        teamId: opts.teamId,
        lastCommitSha: opts.lastCommitSha,
        lastActivityAt: opts.lastActivityAt,
      })
      .run();
    return id;
  }
}

/**
 * Store an install state record and return the metadata needed
 * for the route handler to construct the signed state token.
 */
export function createInstallState(
  db: DbClient,
  opts: {
    teamSlugOrId: string;
    userId: string;
    returnUrl?: string;
  },
): { teamId: string; nonce: string; iat: number; exp: number } {
  const teamId = resolveTeamId(db, opts.teamSlugOrId);

  // Generate random nonce
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = Array.from(nonceBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const now = Date.now();
  const exp = now + 10 * 60 * 1000; // 10 minutes

  const id = crypto.randomUUID();
  db.insert(installStates)
    .values({
      id,
      nonce,
      teamId,
      userId: opts.userId,
      iat: now,
      exp,
      status: "pending",
      createdAt: now,
      ...(opts.returnUrl ? { returnUrl: opts.returnUrl } : {}),
    })
    .run();

  return { teamId, nonce, iat: now, exp };
}
