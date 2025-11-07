/**
 * Parses a GitHub repository URL and extracts repository information.
 * Supports multiple formats:
 * - Simple: owner/repo
 * - HTTPS: https://github.com/owner/repo or https://github.com/owner/repo.git
 * - SSH: git@github.com:owner/repo.git
 *
 * @param input - The GitHub repository URL or identifier
 * @returns Parsed repository information or null if invalid
 */
export function parseGithubRepoUrl(input: string): {
  owner: string;
  repo: string;
  fullName: string;
  url: string;
  gitUrl: string;
} | null {
  if (!input) {
    return null;
  }

  const trimmed = input.trim();

  // Pattern 1: owner/repo (simple format)
  const simpleMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (simpleMatch) {
    const [, owner, repo] = simpleMatch;
    if (!owner || !repo) return null;
    const cleanRepo = repo.replace(/\.git$/, "");
    return {
      owner,
      repo: cleanRepo,
      fullName: `${owner}/${cleanRepo}`,
      url: `https://github.com/${owner}/${cleanRepo}`,
      gitUrl: `https://github.com/${owner}/${cleanRepo}.git`,
    };
  }

  // Pattern 2: https://github.com/owner/repo or https://github.com/owner/repo.git
  const httpsMatch = trimmed.match(
    /^https?:\/\/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?(?:\/)?$/i
  );
  if (httpsMatch) {
    const [, owner, repo] = httpsMatch;
    if (!owner || !repo) return null;
    const cleanRepo = repo.replace(/\.git$/, "");
    return {
      owner,
      repo: cleanRepo,
      fullName: `${owner}/${cleanRepo}`,
      url: `https://github.com/${owner}/${cleanRepo}`,
      gitUrl: `https://github.com/${owner}/${cleanRepo}.git`,
    };
  }

  // Pattern 3: git@github.com:owner/repo.git
  const sshMatch = trimmed.match(
    /^git@github\.com:([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/i
  );
  if (sshMatch) {
    const [, owner, repo] = sshMatch;
    if (!owner || !repo) return null;
    const cleanRepo = repo.replace(/\.git$/, "");
    return {
      owner,
      repo: cleanRepo,
      fullName: `${owner}/${cleanRepo}`,
      url: `https://github.com/${owner}/${cleanRepo}`,
      gitUrl: `https://github.com/${owner}/${cleanRepo}.git`,
    };
  }

  return null;
}
