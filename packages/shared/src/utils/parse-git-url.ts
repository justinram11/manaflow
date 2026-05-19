/**
 * Parses a generic git URL and extracts repository information.
 * Unlike `parseGithubRepoUrl`, this preserves the original URL as the clone URL
 * (e.g. SSH URLs stay as SSH URLs) instead of converting to HTTPS.
 *
 * Supports multiple formats:
 * - Simple: owner/repo (assumes GitHub HTTPS)
 * - HTTPS: https://github.com/owner/repo or https://gitlab.com/owner/repo.git
 * - SSH: git@github.com:owner/repo.git or git@gitlab.com:owner/repo.git
 * - Nested groups: git@gitlab.com:group/subgroup/repo.git or https://gitlab.com/group/subgroup/repo
 *
 * Any of the above may carry a trailing `#ref` fragment naming a branch, tag,
 * or commit (e.g. `https://github.com/owner/repo.git#develop`). The fragment is
 * stripped from `cloneUrl` and returned separately as `ref`.
 *
 * @param input - The git repository URL or identifier
 * @returns Parsed repository information or null if invalid
 */
export interface ParsedGitUrl {
  owner: string;
  repo: string;
  fullName: string;
  cloneUrl: string;
  /** Branch/tag/commit parsed from a trailing `#fragment`, if present. */
  ref?: string;
}

export function parseGitUrl(input: string): ParsedGitUrl | null {
  if (!input) {
    return null;
  }

  const trimmed = input.trim();

  // Split off an optional `#ref` fragment (branch/tag/commit). `#` never
  // appears in a real clone URL, so this split is unambiguous.
  let base = trimmed;
  let ref: string | undefined;
  const hashIndex = trimmed.indexOf("#");
  if (hashIndex !== -1) {
    base = trimmed.slice(0, hashIndex).trim();
    const fragment = trimmed.slice(hashIndex + 1).trim();
    ref = fragment.length > 0 ? fragment : undefined;
  }

  // SSH format: git@host:owner/repo.git (supports nested groups like group/subgroup/repo)
  const sshMatch = base.match(
    /^git@[a-zA-Z0-9._-]+:([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/
  );
  if (sshMatch) {
    const [, owner, repo] = sshMatch;
    if (!owner || !repo) return null;
    const cleanRepo = repo.replace(/\.git$/, "");
    return {
      owner,
      repo: cleanRepo,
      fullName: `${owner}/${cleanRepo}`,
      cloneUrl: base,
      ref,
    };
  }

  // HTTPS format: https://host/owner/repo(.git)? (supports nested groups like group/subgroup/repo)
  const httpsMatch = base.match(
    /^https?:\/\/[a-zA-Z0-9._-]+\/([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)\/([a-zA-Z0-9_.-]+?)(?:\.git)?(?:\/)?$/i
  );
  if (httpsMatch) {
    const [, owner, repo] = httpsMatch;
    if (!owner || !repo) return null;
    const cleanRepo = repo.replace(/\.git$/, "");
    return {
      owner,
      repo: cleanRepo,
      fullName: `${owner}/${cleanRepo}`,
      cloneUrl: base,
      ref,
    };
  }

  // Simple format: owner/repo (assumes GitHub HTTPS)
  const simpleMatch = base.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (simpleMatch) {
    const [, owner, repo] = simpleMatch;
    if (!owner || !repo) return null;
    const cleanRepo = repo.replace(/\.git$/, "");
    return {
      owner,
      repo: cleanRepo,
      fullName: `${owner}/${cleanRepo}`,
      cloneUrl: `https://github.com/${owner}/${cleanRepo}.git`,
      ref,
    };
  }

  return null;
}
