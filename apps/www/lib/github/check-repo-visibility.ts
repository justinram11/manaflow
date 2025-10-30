import { createGitHubClient } from "./octokit";

type RepoVisibility = "public" | "private" | "unknown";

/**
 * Checks if a GitHub repository is public or private.
 * Uses unauthenticated GitHub API request - if we can fetch the repo without auth, it's public.
 */
export async function checkRepoVisibility(
  owner: string,
  repo: string
): Promise<RepoVisibility> {
  try {
    // Try to fetch repo info without authentication
    const octokit = createGitHubClient(undefined);
    const response = await octokit.rest.repos.get({
      owner,
      repo,
    });

    // If we got here, the repo is accessible without auth
    return response.data.private ? "private" : "public";
  } catch (error: unknown) {
    // If we get a 404, the repo either doesn't exist or is private
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 404
    ) {
      // We can't distinguish between private and non-existent without auth
      // So we return "unknown" - the caller should attempt authenticated request
      return "unknown";
    }

    // For other errors, also return unknown
    console.error("[checkRepoVisibility] Error checking repo visibility:", error);
    return "unknown";
  }
}

/**
 * Checks if a repository is definitely public (accessible without authentication)
 */
export async function isRepoPublic(
  owner: string,
  repo: string
): Promise<boolean> {
  const visibility = await checkRepoVisibility(owner, repo);
  return visibility === "public";
}
