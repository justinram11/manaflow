import { eq, and } from "drizzle-orm";
import type { DbClient } from "../connection";
import { pullRequests } from "../schema/index";
import { resolveTeamId } from "../queries/teams";

export type UpsertPullRequestRecord = {
  providerPrId?: number;
  repositoryId?: number;
  title: string;
  state: "open" | "closed";
  merged?: boolean;
  draft?: boolean;
  authorLogin?: string;
  authorId?: number;
  htmlUrl?: string;
  baseRef?: string;
  headRef?: string;
  baseSha?: string;
  headSha?: string;
  mergeCommitSha?: string;
  createdAt?: number;
  updatedAt?: number;
  closedAt?: number;
  mergedAt?: number;
  commentsCount?: number;
  reviewCommentsCount?: number;
  commitsCount?: number;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
};

export function upsertPullRequest(
  db: DbClient,
  args: {
    teamSlugOrId: string;
    installationId: number;
    repoFullName: string;
    number: number;
    record: UpsertPullRequestRecord;
  },
) {
  const teamId = resolveTeamId(db, args.teamSlugOrId);

  const existing = db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.teamId, teamId),
        eq(pullRequests.repoFullName, args.repoFullName),
        eq(pullRequests.number, args.number),
      ),
    )
    .get();

  if (existing) {
    const existingUpdatedAt = existing.updatedAt;
    const incomingUpdatedAt = args.record.updatedAt;
    const isStale =
      typeof existingUpdatedAt === "number" &&
      typeof incomingUpdatedAt === "number" &&
      existingUpdatedAt >= incomingUpdatedAt;

    if (isStale) {
      return existing.id;
    }

    db.update(pullRequests)
      .set({
        ...args.record,
        installationId: args.installationId,
        repoFullName: args.repoFullName,
        number: args.number,
        provider: "github",
        teamId,
      })
      .where(eq(pullRequests.id, existing.id))
      .run();

    return existing.id;
  }

  const result = db
    .insert(pullRequests)
    .values({
      provider: "github",
      teamId,
      installationId: args.installationId,
      repoFullName: args.repoFullName,
      number: args.number,
      ...args.record,
    })
    .returning({ id: pullRequests.id })
    .get();

  return result.id;
}
