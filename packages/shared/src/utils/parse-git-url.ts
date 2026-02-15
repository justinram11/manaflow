/**
 * Parses a generic git URL and extracts repository information.
 * Unlike `parseGithubRepoUrl`, this preserves the original URL as the clone URL
 * (e.g. SSH URLs stay as SSH URLs) instead of converting to HTTPS.
 *
 * Supports multiple formats:
 * - Simple: owner/repo (assumes GitHub HTTPS)
 * - HTTPS: https://github.com/owner/repo or https://gitlab.com/owner/repo.git
 * - SSH: git@github.com:owner/repo.git or git@gitlab.com:owner/repo.git
 *
 * @param input - The git repository URL or identifier
 * @returns Parsed repository information or null if invalid
 */
export function parseGitUrl(input: string): {
  owner: string;
  repo: string;
  fullName: string;
  cloneUrl: string;
} | null {
  if (!input) {
    return null;
  }

  const trimmed = input.trim();

  // SSH format: git@host:owner/repo.git
  const sshMatch = trimmed.match(
    /^git@[a-zA-Z0-9._-]+:([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/
  );
  if (sshMatch) {
    const [, owner, repo] = sshMatch;
    if (!owner || !repo) return null;
    const cleanRepo = repo.replace(/\.git$/, "");
    return {
      owner,
      repo: cleanRepo,
      fullName: `${owner}/${cleanRepo}`,
      cloneUrl: trimmed,
    };
  }

  // HTTPS format: https://host/owner/repo(.git)?
  const httpsMatch = trimmed.match(
    /^https?:\/\/[a-zA-Z0-9._-]+\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?(?:\/)?$/i
  );
  if (httpsMatch) {
    const [, owner, repo] = httpsMatch;
    if (!owner || !repo) return null;
    const cleanRepo = repo.replace(/\.git$/, "");
    return {
      owner,
      repo: cleanRepo,
      fullName: `${owner}/${cleanRepo}`,
      cloneUrl: trimmed,
    };
  }

  // Simple format: owner/repo (assumes GitHub HTTPS)
  const simpleMatch = trimmed.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (simpleMatch) {
    const [, owner, repo] = simpleMatch;
    if (!owner || !repo) return null;
    const cleanRepo = repo.replace(/\.git$/, "");
    return {
      owner,
      repo: cleanRepo,
      fullName: `${owner}/${cleanRepo}`,
      cloneUrl: `https://github.com/${owner}/${cleanRepo}.git`,
    };
  }

  return null;
}
