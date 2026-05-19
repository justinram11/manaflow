#!/usr/bin/env bun

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

interface HydrateConfig {
  workspacePath: string;
  owner?: string;
  repo?: string;
  repoFull?: string;
  cloneUrl?: string;
  maskedCloneUrl?: string;
  depth: number;
  baseBranch?: string;
  newBranch?: string;
  selectedRepos: string[];
}

/**
 * A repository entry parsed from a `selectedRepos` string.
 *
 * Each entry may be an HTTPS/SSH git URL or `owner/repo` GitHub shorthand, with
 * an optional trailing `#branch` fragment. NOTE: this script is shipped to the
 * sandbox as a standalone file and cannot import `@cmux/shared`, so the parsing
 * here intentionally mirrors `parseGitUrl` / `parseRepoEntry` in that package.
 */
interface RepoEntry {
  cloneUrl: string;
  repoName: string;
  branch?: string;
}

function log(message: string, level: "info" | "error" | "debug" = "info") {
  const prefix = `[hydrate-repo]`;
  const timestamp = new Date().toISOString();

  if (level === "error") {
    console.error(`${timestamp} ${prefix} ERROR: ${message}`);
  } else if (level === "debug") {
    console.log(`${timestamp} ${prefix} DEBUG: ${message}`);
  } else {
    console.log(`${timestamp} ${prefix} ${message}`);
  }
}

function exec(command: string, options?: { cwd?: string; throwOnError?: boolean }): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const { cwd, throwOnError = true } = options || {};

  log(`Executing: ${command.slice(0, 200)}${command.length > 200 ? '...' : ''}`, "debug");

  try {
    const stdout = execSync(command, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error) {
    const errorObj = error as { status?: number; stderr?: Buffer; stdout?: Buffer };
    const exitCode = errorObj.status || 1;
    const stderr = errorObj.stderr?.toString() || "";
    const stdout = errorObj.stdout?.toString() || "";

    log(`Command failed with exit code ${exitCode}`, "debug");
    log(`stderr: ${stderr.slice(0, 500)}`, "debug");

    if (throwOnError) {
      throw error;
    }

    return { stdout, stderr, exitCode };
  }
}

function getConfig(): HydrateConfig {
  const workspacePath = process.env.CMUX_WORKSPACE_PATH || "/root/workspace";
  const depth = parseInt(process.env.CMUX_DEPTH || "1", 10);

  // Check if we have repo config
  const owner = process.env.CMUX_OWNER;
  const repo = process.env.CMUX_REPO;
  const repoFull = process.env.CMUX_REPO_FULL;
  const cloneUrl = process.env.CMUX_CLONE_URL;
  const maskedCloneUrl = process.env.CMUX_MASKED_CLONE_URL;
  const baseBranch = process.env.CMUX_BASE_BRANCH;
  const newBranch = process.env.CMUX_NEW_BRANCH;
  const selectedReposResult = process.env.CMUX_SELECTED_REPOS_JSON
    ? JSON.parse(process.env.CMUX_SELECTED_REPOS_JSON)
    : [];
  const selectedRepos = Array.isArray(selectedReposResult)
    ? selectedReposResult.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0
      )
    : [];

  return {
    workspacePath,
    owner,
    repo,
    repoFull,
    cloneUrl,
    maskedCloneUrl,
    depth,
    baseBranch,
    newBranch,
    selectedRepos,
  };
}

/**
 * Parse a `selectedRepos` entry into a clone URL, repo name, and optional
 * branch. Accepts HTTPS, SSH, and `owner/repo` shorthand, each optionally
 * carrying a trailing `#branch` fragment. Returns null for unrecognized input.
 */
function parseRepoEntry(entry: string): RepoEntry | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;

  // Split off an optional `#branch` fragment.
  let base = trimmed;
  let branch: string | undefined;
  const hashIndex = trimmed.indexOf("#");
  if (hashIndex !== -1) {
    base = trimmed.slice(0, hashIndex).trim();
    const fragment = trimmed.slice(hashIndex + 1).trim();
    branch = fragment.length > 0 ? fragment : undefined;
  }
  if (!base) return null;

  // SSH: git@host:owner/repo(.git)? (supports nested groups)
  const sshMatch = base.match(
    /^git@[a-zA-Z0-9._-]+:([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/
  );
  if (sshMatch) {
    return { cloneUrl: base, repoName: sshMatch[2].replace(/\.git$/, ""), branch };
  }

  // HTTPS: https://host/owner/repo(.git)? (supports nested groups)
  const httpsMatch = base.match(
    /^https?:\/\/[a-zA-Z0-9._-]+\/([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)\/([a-zA-Z0-9_.-]+?)(?:\.git)?(?:\/)?$/i
  );
  if (httpsMatch) {
    return { cloneUrl: base, repoName: httpsMatch[2].replace(/\.git$/, ""), branch };
  }

  // Shorthand: owner/repo -> GitHub HTTPS
  const simpleMatch = base.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (simpleMatch) {
    const repoName = simpleMatch[2].replace(/\.git$/, "");
    return {
      cloneUrl: `https://github.com/${simpleMatch[1]}/${repoName}.git`,
      repoName,
      branch,
    };
  }

  return null;
}

function ensureWorkspace(workspacePath: string) {
  log(`Ensuring workspace exists at ${workspacePath}`);
  exec(`mkdir -p "${workspacePath}"`);
}

function checkExistingRepo(workspacePath: string, owner?: string, repo?: string): {
  hasGit: boolean;
  remoteUrl?: string;
  needsClear: boolean;
} {
  const gitPath = join(workspacePath, ".git");
  const hasGit = existsSync(gitPath);

  if (!hasGit) {
    log("No existing git repository found");
    return { hasGit: false, needsClear: false };
  }

  log("Found existing git repository");

  // Get remote URL
  const { stdout: remoteUrl, exitCode } = exec(
    `git remote get-url origin`,
    { cwd: workspacePath, throwOnError: false }
  );

  if (exitCode !== 0) {
    log("Could not get remote URL", "debug");
    return { hasGit: true, needsClear: false };
  }

  const trimmedRemoteUrl = remoteUrl.trim();
  log(`Current remote: ${trimmedRemoteUrl}`);

  // Check if remote matches expected repo
  if (owner && repo && !trimmedRemoteUrl.includes(`${owner}/${repo}`)) {
    log(`Remote mismatch: expected ${owner}/${repo}, got ${trimmedRemoteUrl}`);
    return { hasGit: true, remoteUrl: trimmedRemoteUrl, needsClear: true };
  }

  return { hasGit: true, remoteUrl: trimmedRemoteUrl, needsClear: false };
}

function clearWorkspace(workspacePath: string) {
  log("Clearing workspace directory");
  exec(`rm -rf "${workspacePath}"/* "${workspacePath}"/.[!.]* "${workspacePath}"/..?* 2>/dev/null || true`);
}

function cloneRepository(config: HydrateConfig) {
  const { workspacePath, cloneUrl, maskedCloneUrl, depth } = config;

  log(`Cloning ${maskedCloneUrl || cloneUrl} with depth=${depth}`);

  const { exitCode, stderr } = exec(
    `git clone --depth ${depth} "${cloneUrl}" "${workspacePath}"`,
    { throwOnError: false }
  );

  if (exitCode !== 0) {
    log(`Clone failed: ${stderr}`, "error");
    throw new Error(`Failed to clone repository: ${stderr}`);
  }

  log("Repository cloned successfully");
}

/**
 * Clone a repo into a target directory. When `branch` is set, clone that branch
 * directly (so shallow clones fetch the right ref); fall back to a default
 * clone if the branch does not exist on the remote.
 */
function cloneRepoInto(
  cloneUrl: string,
  targetPath: string,
  depth: number,
  branch?: string,
): boolean {
  if (branch) {
    log(`Cloning ${cloneUrl} (branch ${branch}) into ${targetPath}`);
    const branched = exec(
      `git clone --depth ${depth} --branch "${branch}" "${cloneUrl}" "${targetPath}"`,
      { throwOnError: false }
    );
    if (branched.exitCode === 0) {
      return true;
    }
    log(
      `Branch clone failed for ${cloneUrl}#${branch}, retrying on default branch: ${branched.stderr}`,
      "debug"
    );
  } else {
    log(`Cloning ${cloneUrl} into ${targetPath}`);
  }

  const result = exec(
    `git clone --depth ${depth} "${cloneUrl}" "${targetPath}"`,
    { throwOnError: false }
  );
  if (result.exitCode !== 0) {
    log(`Clone failed for ${cloneUrl}: ${result.stderr}`, "error");
    return false;
  }
  return true;
}

/** Enumerate immediate subdirectories of the workspace that are git repos. */
function listWorkspaceRepos(workspacePath: string): Map<string, string> {
  const repos = new Map<string, string>();

  try {
    const dirs = execSync(
      `find "${workspacePath}" -maxdepth 1 -mindepth 1 -type d`,
      { encoding: "utf-8" }
    )
      .trim()
      .split("\n")
      .filter(Boolean);

    for (const dir of dirs) {
      const gitPath = join(dir, ".git");
      if (!existsSync(gitPath)) continue;

      const repoName = dir.split("/").pop();
      if (!repoName) continue;

      const remoteResult = exec(`git remote get-url origin`, {
        cwd: dir,
        throwOnError: false,
      });
      repos.set(repoName, remoteResult.stdout.trim());
    }
  } catch (error) {
    log(`Could not enumerate existing workspace repos: ${error}`, "debug");
  }

  return repos;
}

function fetchUpdates(workspacePath: string) {
  log("Fetching updates from remote");

  const { exitCode, stderr } = exec(
    `git fetch --all --prune`,
    { cwd: workspacePath, throwOnError: false }
  );

  if (exitCode !== 0) {
    log(`Fetch warning: ${stderr}`, "debug");
  } else {
    log("Fetched updates successfully");
  }
}

/**
 * Bring an existing repo onto `branch` at the latest remote tip. Works on
 * shallow clones: fetches the branch explicitly, then force-sets the local
 * branch to the fetched tip (equivalent to "pull latest").
 */
function syncRepoToBranch(repoPath: string, branch: string) {
  log(`Syncing ${repoPath} to origin/${branch}`);

  const fetch = exec(`git fetch origin "${branch}"`, {
    cwd: repoPath,
    throwOnError: false,
  });
  if (fetch.exitCode !== 0) {
    log(`Could not fetch branch ${branch} in ${repoPath}: ${fetch.stderr}`, "error");
    return;
  }

  const checkout = exec(`git checkout -B "${branch}" FETCH_HEAD`, {
    cwd: repoPath,
    throwOnError: false,
  });
  if (checkout.exitCode !== 0) {
    log(`Could not checkout ${branch} in ${repoPath}: ${checkout.stderr}`, "error");
  } else {
    log(`Synced ${repoPath} to origin/${branch}`);
  }
}

/** Pull the latest changes for an existing repo on its current branch. */
function pullCurrentBranch(repoPath: string) {
  fetchUpdates(repoPath);
  const pull = exec(`git pull --ff-only`, { cwd: repoPath, throwOnError: false });
  if (pull.exitCode === 0) {
    log(`Pulled latest changes in ${repoPath}`);
    return;
  }
  if (
    pull.stderr.includes("divergent") ||
    pull.stderr.includes("Not possible to fast-forward")
  ) {
    const { stdout: branch } = exec(`git rev-parse --abbrev-ref HEAD`, {
      cwd: repoPath,
      throwOnError: false,
    });
    const branchName = branch.trim();
    if (branchName) {
      log(`Divergent branches in ${repoPath}, resetting to origin/${branchName}`, "debug");
      exec(`git reset --hard "origin/${branchName}"`, { cwd: repoPath, throwOnError: false });
    }
  } else {
    log(`Could not pull latest changes in ${repoPath} (may be up to date)`, "debug");
  }
}

function checkoutBranch(workspacePath: string, baseBranch: string, newBranch?: string) {
  log(`Checking out base branch: ${baseBranch}`);

  // Try to checkout the base branch
  let checkoutResult = exec(
    `git checkout "${baseBranch}"`,
    { cwd: workspacePath, throwOnError: false }
  );

  if (checkoutResult.exitCode !== 0) {
    log(`Direct checkout failed, trying to create from origin/${baseBranch}`);
    checkoutResult = exec(
      `git checkout -b "${baseBranch}" "origin/${baseBranch}"`,
      { cwd: workspacePath, throwOnError: false }
    );
  }

  if (checkoutResult.exitCode === 0) {
    log(`Checked out ${baseBranch}`);

    // Pull latest changes (fast-forward only)
    const { exitCode: pullExitCode, stderr: pullStderr } = exec(
      `git pull --ff-only`,
      { cwd: workspacePath, throwOnError: false }
    );

    if (pullExitCode === 0) {
      log("Pulled latest changes");
    } else if (pullStderr.includes("divergent") || pullStderr.includes("Not possible to fast-forward")) {
      // Handle divergent branches by resetting to remote
      log("Divergent branches detected, resetting to remote", "debug");
      const { exitCode: resetExitCode } = exec(
        `git reset --hard "origin/${baseBranch}"`,
        { cwd: workspacePath, throwOnError: false }
      );
      if (resetExitCode === 0) {
        log(`Reset to origin/${baseBranch}`);
      } else {
        log(`Could not reset to origin/${baseBranch}`, "error");
      }
    } else {
      log("Could not pull latest changes (may be up to date)", "debug");
    }
  } else {
    log(`Could not checkout ${baseBranch}: ${checkoutResult.stderr}`, "error");
  }

  // Create and switch to new branch if specified
  if (newBranch) {
    log(`Creating new branch: ${newBranch}`);
    const { exitCode } = exec(
      `git switch -C "${newBranch}"`,
      { cwd: workspacePath, throwOnError: false }
    );

    if (exitCode === 0) {
      log(`Switched to new branch: ${newBranch}`);
    } else {
      log(`Could not create branch ${newBranch}`, "error");
    }
  }
}

/**
 * Hydrate the repositories listed in `selectedRepos`.
 *
 * - A single repo is cloned into the workspace root.
 * - Multiple repos are each cloned into their own subdirectory.
 *
 * Each entry may be any git URL (HTTPS/SSH) or `owner/repo` shorthand, with an
 * optional `#branch` fragment. When a branch is given it is checked out and
 * kept at the latest remote tip on every hydration.
 */
function hydrateSelectedRepos(config: HydrateConfig) {
  const { workspacePath, selectedRepos, depth } = config;

  if (selectedRepos.length === 0) {
    return;
  }

  const entries: RepoEntry[] = [];
  for (const raw of selectedRepos) {
    const parsed = parseRepoEntry(raw);
    if (!parsed) {
      log(`Skipping unrecognized repository entry: ${raw}`, "error");
      continue;
    }
    entries.push(parsed);
  }

  if (entries.length === 0) {
    return;
  }

  // Single repo -> clone into the workspace root.
  if (entries.length === 1) {
    const entry = entries[0];
    const gitPath = join(workspacePath, ".git");
    const hasGit = existsSync(gitPath);

    let needsClear = false;
    if (hasGit) {
      const remote = exec(`git remote get-url origin`, {
        cwd: workspacePath,
        throwOnError: false,
      });
      const remoteUrl = remote.stdout.trim();
      if (remote.exitCode === 0 && remoteUrl && remoteUrl !== entry.cloneUrl) {
        log(`Workspace remote ${remoteUrl} does not match ${entry.cloneUrl}, re-cloning`);
        needsClear = true;
      }
    }

    if (needsClear) {
      clearWorkspace(workspacePath);
    }

    if (!hasGit || needsClear) {
      if (!cloneRepoInto(entry.cloneUrl, workspacePath, depth, entry.branch)) {
        throw new Error(`Failed to clone repository: ${entry.cloneUrl}`);
      }
      if (entry.branch) {
        // The clone landed on `branch`; still apply any requested new branch.
        checkoutBranch(workspacePath, entry.branch, config.newBranch);
      } else if (config.newBranch) {
        exec(`git switch -C "${config.newBranch}"`, {
          cwd: workspacePath,
          throwOnError: false,
        });
      }
    } else if (entry.branch) {
      syncRepoToBranch(workspacePath, entry.branch);
      if (config.newBranch) {
        exec(`git switch -C "${config.newBranch}"`, {
          cwd: workspacePath,
          throwOnError: false,
        });
      }
    } else {
      pullCurrentBranch(workspacePath);
    }
    return;
  }

  // Multiple repos -> each into its own subdirectory.
  // Resolve a unique directory name per repo (custom URLs from different hosts
  // can collide on the bare repo name, e.g. gitlab a/api vs github b/api).
  const usedDirs = new Set<string>();
  const planned: Array<{ entry: RepoEntry; dirName: string }> = [];
  for (const entry of entries) {
    let dirName = entry.repoName;
    let suffix = 2;
    while (usedDirs.has(dirName)) {
      dirName = `${entry.repoName}-${suffix}`;
      suffix += 1;
    }
    usedDirs.add(dirName);
    planned.push({ entry, dirName });
  }

  // Remove subdirectories that are no longer part of the selection.
  const existingRepos = listWorkspaceRepos(workspacePath);
  for (const [repoName] of existingRepos.entries()) {
    if (!usedDirs.has(repoName)) {
      log(`Removing stale repository ${repoName}`);
      exec(`rm -rf "${join(workspacePath, repoName)}"`, { throwOnError: false });
    }
  }

  for (const { entry, dirName } of planned) {
    const repoPath = join(workspacePath, dirName);
    const existingRemote = existingRepos.get(dirName);

    // Re-clone if missing or the remote no longer matches.
    if (!existsSync(join(repoPath, ".git"))) {
      if (!cloneRepoInto(entry.cloneUrl, repoPath, depth, entry.branch)) {
        log(`Skipping ${entry.cloneUrl}: clone failed`, "error");
      }
      continue;
    }
    if (existingRemote && existingRemote !== entry.cloneUrl) {
      log(`Repository ${dirName} remote changed (${existingRemote} -> ${entry.cloneUrl}), re-cloning`);
      exec(`rm -rf "${repoPath}"`, { throwOnError: false });
      if (!cloneRepoInto(entry.cloneUrl, repoPath, depth, entry.branch)) {
        log(`Skipping ${entry.cloneUrl}: clone failed`, "error");
      }
      continue;
    }

    // Existing repo with a matching remote -> refresh to the latest tip.
    if (entry.branch) {
      syncRepoToBranch(repoPath, entry.branch);
    } else {
      pullCurrentBranch(repoPath);
    }
  }
}

function hydrateSubdirectories(workspacePath: string) {
  log("Checking for subdirectory git repositories");

  try {
    const dirs = execSync(`find "${workspacePath}" -maxdepth 1 -type d ! -path "${workspacePath}"`, {
      encoding: "utf-8"
    }).trim().split('\n').filter(Boolean);

    for (const dir of dirs) {
      const gitPath = join(dir, ".git");
      if (existsSync(gitPath)) {
        log(`Pulling updates in ${dir}`);
        const { exitCode, stderr } = exec(`git pull --ff-only`, { cwd: dir, throwOnError: false });
        if (exitCode !== 0 && (stderr.includes("divergent") || stderr.includes("Not possible to fast-forward"))) {
          // Get current branch and reset to remote
          const { stdout: branch } = exec(`git rev-parse --abbrev-ref HEAD`, { cwd: dir, throwOnError: false });
          const branchName = branch.trim();
          if (branchName) {
            log(`Divergent branches in ${dir}, resetting to origin/${branchName}`, "debug");
            exec(`git reset --hard "origin/${branchName}"`, { cwd: dir, throwOnError: false });
          }
        }
      }
    }
  } catch (error) {
    log(`Error checking subdirectories: ${error}`, "debug");
  }
}

async function main() {
  try {
    const config = getConfig();
    log(`Starting hydration for workspace: ${config.workspacePath}`);

    // Ensure workspace exists
    ensureWorkspace(config.workspacePath);

    if (config.cloneUrl) {
      log(`Hydrating single repository: ${config.maskedCloneUrl || config.cloneUrl}`);

      // Check existing repo
      const { hasGit, needsClear } = checkExistingRepo(
        config.workspacePath,
        config.owner,
        config.repo
      );

      if (needsClear) {
        clearWorkspace(config.workspacePath);
      }

      if (!hasGit || needsClear) {
        // Clone repository
        cloneRepository(config);
      } else {
        // Fetch updates
        fetchUpdates(config.workspacePath);
      }

      // Checkout branch
      if (config.baseBranch) {
        checkoutBranch(config.workspacePath, config.baseBranch, config.newBranch);
      }

      // List files for verification
      log("Listing workspace contents:");
      const { stdout } = exec(`ls -la | head -50`, { cwd: config.workspacePath });
      console.log(stdout);
    } else if (config.selectedRepos.length > 0) {
      log(`Hydrating ${config.selectedRepos.length} selected repos`);
      hydrateSelectedRepos(config);
      log("Listing workspace contents:");
      const { stdout } = exec(`find . -maxdepth 2 | head -80`, { cwd: config.workspacePath });
      console.log(stdout);
    } else {
      log("Hydrating existing workspace repositories");
      hydrateSubdirectories(config.workspacePath);
    }

    log("Hydration completed successfully");
    process.exit(0);
  } catch (error) {
    log(`Fatal error: ${error}`, "error");
    if (error instanceof Error) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run the script
main().catch(error => {
  log(`Unhandled error: ${error}`, "error");
  process.exit(1);
});
