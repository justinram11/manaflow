import {
  reconcilePullRequestRecords,
  type AggregatePullRequestSummary,
  type PullRequestActionResult,
  type RunPullRequestState,
  type StoredPullRequestInfo,
} from "@cmux/shared/pull-request-state";
import { getDb, getUserId } from "./utils/dbClient";
import { getEnvironmentById } from "@cmux/db/queries/environments";
import { resolveTeamId } from "@cmux/db/queries/teams";
import { updatePullRequestStateFull } from "@cmux/db/mutations/task-runs";
import { updateTaskMergeStatus } from "@cmux/db/mutations/tasks";
import { serverLogger } from "./utils/fileLogger";
import { fetchPrByHead, fetchPrDetail } from "./utils/githubPr";
import type { TaskDoc, TaskRunDoc } from "./types/taskDocs";

export type PersistedPullRequestState = {
  records: StoredPullRequestInfo[];
  aggregate: AggregatePullRequestSummary;
};

export const EMPTY_AGGREGATE: AggregatePullRequestSummary = {
  state: "none",
  isDraft: false,
  mergeStatus: "none",
};

export async function collectRepoFullNamesForRun(
  run: TaskRunDoc,
  task: TaskDoc,
  _teamSlugOrId: string,
): Promise<string[]> {
  const repos = new Set<string>();
  const project = task.projectFullName?.trim();
  if (project) {
    repos.add(project);
  }
  if (run.environmentId) {
    try {
      const db = getDb();
      const environment = getEnvironmentById(db, run.environmentId);
      const selectedRepos = (environment?.selectedRepos ?? []) as string[];
      selectedRepos.forEach((repo) => {
        const trimmed = typeof repo === "string" ? repo.trim() : "";
        if (trimmed) {
          repos.add(trimmed);
        }
      });
    } catch (error) {
      serverLogger.error("Failed to load environment repos for run", error);
    }
  }
  return Array.from(repos);
}

export function mapGitHubStateToRunState({
  state,
  draft,
  merged,
}: {
  state?: string;
  draft?: boolean;
  merged?: boolean;
}): RunPullRequestState {
  if (merged) {
    return "merged";
  }
  if (draft) {
    return "draft";
  }
  const normalized = (state ?? "").toLowerCase();
  if (normalized === "open") {
    return "open";
  }
  if (normalized === "closed") {
    return "closed";
  }
  if (!normalized) {
    return "none";
  }
  return "unknown";
}

export function toPullRequestActionResult(
  repoFullName: string,
  data: {
    html_url?: string;
    number?: number;
    state?: string;
    draft?: boolean;
    merged_at?: string | null;
  },
): PullRequestActionResult {
  const merged = Boolean(data.merged_at);
  return {
    repoFullName,
    url: data.html_url,
    number: data.number,
    state: mapGitHubStateToRunState({
      state: data.state,
      draft: data.draft,
      merged,
    }),
    isDraft: data.draft,
  };
}

export function splitRepoFullName(
  repoFullName: string,
): { owner: string; repo: string } | null {
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) {
    return null;
  }
  return { owner, repo };
}

export async function loadPullRequestDetail({
  token,
  repoFullName,
  owner,
  repo,
  branchName,
  number,
}: {
  token: string;
  repoFullName: string;
  owner: string;
  repo: string;
  branchName: string;
  number?: number;
}): Promise<Awaited<ReturnType<typeof fetchPrDetail>> | null> {
  let detail: Awaited<ReturnType<typeof fetchPrDetail>> | null = null;

  if (number) {
    try {
      detail = await fetchPrDetail(token, owner, repo, number);
    } catch (error) {
      serverLogger.warn(
        `[PullRequest] Failed to fetch PR detail for ${repoFullName}#${number}: ${String(error)}`,
      );
    }
  }

  if (!detail) {
    try {
      const basic = await fetchPrByHead(token, owner, repo, owner, branchName);
      if (basic) {
        detail = await fetchPrDetail(token, owner, repo, basic.number);
      }
    } catch (error) {
      serverLogger.warn(
        `[PullRequest] Failed to locate PR by branch for ${repoFullName}: ${String(error)}`,
      );
    }
  }

  return detail;
}

export async function persistPullRequestResults({
  teamSlugOrId,
  run,
  task,
  repoFullNames,
  results,
}: {
  teamSlugOrId: string;
  run: TaskRunDoc;
  task: TaskDoc;
  repoFullNames: readonly string[];
  results: PullRequestActionResult[];
}): Promise<PersistedPullRequestState> {
  const existing = (run.pullRequests ?? []) as StoredPullRequestInfo[];
  const { records, aggregate } = reconcilePullRequestRecords({
    existing,
    updates: results,
    repoFullNames,
  });

  const db = getDb();
  const userId = getUserId();
  const teamId = resolveTeamId(db, teamSlugOrId);

  updatePullRequestStateFull(db, {
    id: run.id,
    teamId,
    state: aggregate.state,
    isDraft: aggregate.isDraft,
    number: aggregate.number,
    url: aggregate.url,
    pullRequests: records,
  });

  updateTaskMergeStatus(db, {
    teamSlugOrId,
    userId,
    id: task.id,
    mergeStatus: aggregate.mergeStatus,
  });

  return { records, aggregate };
}
