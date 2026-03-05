import { eq, and, desc, type InferSelectModel } from "drizzle-orm";
import type { DbClient } from "../connection";
import { pullRequests } from "../schema/index";
import { resolveTeamId } from "./teams";

type PullRequest = InferSelectModel<typeof pullRequests>;

export function listPullRequests(
  db: DbClient,
  teamSlugOrId: string,
  opts?: {
    state?: "open" | "closed" | "all";
    search?: string;
    limit?: number;
  },
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  const state = opts?.state ?? "open";

  let rows;
  if (state === "all") {
    rows = db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.teamId, teamId))
      .orderBy(desc(pullRequests.updatedAt))
      .all();
  } else {
    rows = db
      .select()
      .from(pullRequests)
      .where(
        and(eq(pullRequests.teamId, teamId), eq(pullRequests.state, state)),
      )
      .orderBy(desc(pullRequests.updatedAt))
      .all();
  }

  const q = (opts?.search ?? "").trim().toLowerCase();
  const filtered = !q
    ? rows
    : rows.filter(
        (r: PullRequest) =>
          r.title.toLowerCase().includes(q) ||
          (r.authorLogin ?? "").toLowerCase().includes(q) ||
          r.repoFullName.toLowerCase().includes(q),
      );

  const limited =
    typeof opts?.limit === "number"
      ? filtered.slice(0, Math.max(1, opts.limit))
      : filtered;

  return limited;
}

export function getPullRequest(
  db: DbClient,
  teamSlugOrId: string,
  repoFullName: string,
  number: number,
) {
  const teamId = resolveTeamId(db, teamSlugOrId);
  return (
    db
      .select()
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.teamId, teamId),
          eq(pullRequests.repoFullName, repoFullName),
          eq(pullRequests.number, number),
        ),
      )
      .get() ?? null
  );
}
