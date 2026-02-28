import { normalizeGitRef } from "@/lib/refWithOrigin";
import { gitDiffQueryOptions } from "@/queries/git-diff";
import {
  getApiIntegrationsGithubPrsOptions,
} from "@cmux/www-openapi-client/react-query";
import type { QueryClient } from "@tanstack/react-query";

export async function preloadPullRequestDetail({
  queryClient,
  teamSlugOrId,
  owner,
  repo,
  number,
}: {
  queryClient: QueryClient;
  teamSlugOrId: string;
  owner: string;
  repo: string;
  number: string;
}) {
  await queryClient
    .ensureQueryData(
      getApiIntegrationsGithubPrsOptions({
        query: {
          team: teamSlugOrId,
          state: "all",
        },
      })
    )
    .then(async (result) => {
      const prs = result?.pullRequests ?? [];
      const key = `${owner}/${repo}`;
      const num = Number(number);
      const target = prs.find(
        (p) => p.repository_full_name === key && p.number === num
      );
      if (target?.repository_full_name) {
        // The GitHub PRs API response uses different field names than Convex
        // We need baseRef and headRef which may not be in this response
        // If they are present (from extended data), use them for preloading
        const extended = target as Record<string, unknown>;
        const baseRef = extended.baseRef as string | undefined;
        const headRef = extended.headRef as string | undefined;
        if (baseRef && headRef) {
          await queryClient.ensureQueryData(
            gitDiffQueryOptions({
              repoFullName: target.repository_full_name,
              baseRef: normalizeGitRef(baseRef),
              headRef: normalizeGitRef(headRef),
            })
          );
        }
      }
    });
}
