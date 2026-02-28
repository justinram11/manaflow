import { getDb } from "./dbClient";
import { getTaskRunById } from "@cmux/db/queries/task-runs";
import { getTaskById } from "@cmux/db/queries/tasks";
import { updateTaskRunWorktreePath } from "@cmux/db/mutations/task-runs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { RepositoryManager } from "../repositoryManager";
import type { TaskDoc, TaskRunDoc } from "../types/taskDocs";
import { serverLogger } from "../utils/fileLogger";
import { getWorktreePath, setupProjectWorkspace } from "../workspace";

export type EnsureWorktreeResult = {
  run: TaskRunDoc;
  task: TaskDoc;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
};

function sanitizeBranchName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._/-]/g, "-");
}

// Deduplicate concurrent ensures for the same taskRunId within this process
const pendingEnsures = new Map<string, Promise<EnsureWorktreeResult>>();

export async function ensureRunWorktreeAndBranch(
  taskRunId: string,
  teamSlugOrId: string
): Promise<EnsureWorktreeResult> {
  const key = taskRunId;
  const existing = pendingEnsures.get(key);
  if (existing) return existing;

  const p = (async (): Promise<EnsureWorktreeResult> => {
    const db = getDb();

    const run = getTaskRunById(db, taskRunId);
    if (!run) throw new Error("Task run not found");

    const task = getTaskById(db, teamSlugOrId, run.taskId);
    if (!task) throw new Error("Task not found");

    // Determine base branch: prefer explicit task.baseBranch; otherwise detect later
    let baseBranch = task.baseBranch || "";
    const branchName = sanitizeBranchName(
      run.newBranch || `cmux-run-${taskRunId.slice(-8)}`
    );

    // Ensure worktree exists
    let worktreePath = run.worktreePath;
    let needsSetup = !worktreePath;

    // Check if the worktree directory actually exists (handle manual deletion case)
    if (worktreePath) {
      try {
        await fs.access(worktreePath);
        // Also check if it's a valid git directory
        await fs.access(path.join(worktreePath, ".git"));
      } catch {
        serverLogger.warn(
          `Worktree path ${worktreePath} doesn't exist or is not a git directory, recreating...`
        );
        needsSetup = true;
        worktreePath = null;
      }
    }

    if (needsSetup) {
      // Derive repo URL from task.projectFullName
      if (!task.projectFullName) {
        throw new Error("Missing projectFullName to set up worktree");
      }
      const repoUrl = `https://github.com/${task.projectFullName}.git`;
      const worktreeInfo = await getWorktreePath(
        {
          repoUrl,
          branch: branchName,
        },
        teamSlugOrId
      );

      const res = await setupProjectWorkspace({
        repoUrl,
        branch: baseBranch || undefined,
        worktreeInfo,
      });
      if (!res.success || !res.worktreePath) {
        throw new Error(res.error || "Failed to set up worktree");
      }
      worktreePath = res.worktreePath;
      updateTaskRunWorktreePath(db, run.id, worktreePath);

      // If baseBranch wasn't specified, detect it now from the origin repo
      if (!baseBranch) {
        const repoMgr = RepositoryManager.getInstance();
        baseBranch = await repoMgr.getDefaultBranch(worktreeInfo.originPath);
      }
    }

    // If worktree already existed and baseBranch is still empty, detect from the worktree
    if (!baseBranch && worktreePath) {
      const repoMgr = RepositoryManager.getInstance();
      baseBranch = await repoMgr.getDefaultBranch(worktreePath);
    }

    // Ensure worktreePath is defined before proceeding
    if (!worktreePath) {
      throw new Error("Failed to establish worktree path");
    }

    // Ensure we're on the correct branch without discarding changes
    const repoMgr = RepositoryManager.getInstance();
    try {
      const currentBranch = await repoMgr.getCurrentBranch(worktreePath);
      if (currentBranch !== branchName) {
        try {
          // Try to create a new branch
          await repoMgr.executeGitCommand(`git checkout -b ${branchName}`, {
            cwd: worktreePath,
          });
        } catch {
          // If branch already exists, just switch to it
          await repoMgr.executeGitCommand(`git checkout ${branchName}`, {
            cwd: worktreePath,
          });
        }
      }
      // After ensuring we're on the correct branch, attempt to fetch the remote
      // branch for this run so the local worktree reflects the pushed commits.
      // This is especially important in cloud mode where commits happen in a VM.
      try {
        // Fetch the specific branch, force-updating the remote-tracking ref
        await repoMgr.updateRemoteBranchIfStale(worktreePath, branchName);
        // If the worktree has no local changes, fast-forward/reset to origin/<branch>
        const { stdout: statusOut } = await repoMgr.executeGitCommand(
          `git status --porcelain`,
          { cwd: worktreePath }
        );
        const isClean = statusOut.trim().length === 0;
        if (isClean) {
          // Only hard reset when clean to avoid clobbering local edits
          await repoMgr.executeGitCommand(
            `git reset --hard origin/${branchName}`,
            { cwd: worktreePath }
          );
        }
      } catch (e) {
        // Non-fatal: if fetch/reset fails, continue so UI can still render whatever exists
        serverLogger.warn(
          `[ensureRunWorktree] Non-fatal fetch/update failure for ${branchName}: ${String(e)}`
        );
      }

      // Prewarm both base and run branch histories to make merge-base fast/reliable
      try {
        await repoMgr.prewarmCommitHistory(worktreePath, branchName);
      } catch (e) {
        serverLogger.warn(`Prewarm run branch failed: ${String(e)}`);
      }
    } catch (e: unknown) {
      const err = e as { message?: string; stderr?: string };
      serverLogger.error(
        `[ensureRunWorktree] Failed to ensure branch: ${err?.stderr || err?.message || "unknown"}`
      );
      console.error(e);
      throw new Error(
        `Failed to ensure branch: ${err?.stderr || err?.message || "unknown"}`
      );
    }

    return { run, task, worktreePath, branchName, baseBranch };
  })();

  pendingEnsures.set(key, p);
  try {
    return await p;
  } finally {
    pendingEnsures.delete(key);
  }
}
