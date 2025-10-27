import { promises as fs } from "node:fs";
import * as path from "node:path";

import { log } from "../logger";
import { runCommandCapture } from "../crown/utils";
import { filterTextFiles, parseFileList, resolveMergeBase } from "./git";
import {
  SCREENSHOT_COLLECTOR_DIRECTORY_URL,
  SCREENSHOT_COLLECTOR_LOG_PATH,
  logToScreenshotCollector,
} from "./logger";
import { readPrDescription } from "./context";
import {
  SCREENSHOT_STORAGE_ROOT,
  claudeCodeCapturePRScreenshots,
  normalizeScreenshotOutputDir,
  type ClaudeCodeAuthConfig,
} from "./claudeScreenshotCollector";

export interface StartScreenshotCollectionOptions {
  anthropicApiKey?: string | null;
  taskRunJwt?: string | null;
  outputPath?: string;
  prTitle?: string | null;
  prDescription?: string | null;
  headBranch?: string | null;
  baseBranch?: string | null;
  changedFiles?: string[] | null;
}

interface CapturedScreenshot {
  path: string;
  fileName: string;
}

export type ScreenshotCollectionResult =
  | {
      status: "completed";
      screenshots: CapturedScreenshot[];
      commitSha: string;
    }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

function sanitizeSegment(segment: string | null | undefined): string {
  if (!segment) {
    return "current";
  }
  const normalized = segment.trim().replace(/[^A-Za-z0-9._-]/g, "-");
  return normalized.length > 0 ? normalized : "current";
}

async function detectHeadBranch(workspaceDir: string): Promise<string | null> {
  try {
    const output = await runCommandCapture(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: workspaceDir }
    );
    const branch = output.split("\n")[0]?.trim();
    return branch && branch.length > 0 ? branch : null;
  } catch (error) {
    log("WARN", "Failed to detect current branch for screenshots", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function resolveCommitSha(workspaceDir: string): Promise<string> {
  const raw = await runCommandCapture("git", ["rev-parse", "HEAD"], {
    cwd: workspaceDir,
  });
  const commit = raw.split("\n")[0]?.trim();
  if (!commit) {
    throw new Error("Unable to resolve HEAD commit for screenshots");
  }
  return commit;
}

function resolvePrTitle(params: {
  explicitTitle?: string | null;
  prDescription?: string | null;
  headBranch: string;
}): string {
  if (params.explicitTitle && params.explicitTitle.trim().length > 0) {
    return params.explicitTitle.trim();
  }

  if (params.prDescription) {
    const firstLine = params.prDescription
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (firstLine) {
      return firstLine.slice(0, 120);
    }
  }

  return `UI screenshots for ${params.headBranch}`;
}

function resolveOutputDirectory(
  headBranch: string,
  requestedPath?: string
): { outputDir: string; copyTarget?: string } {
  if (requestedPath) {
    const trimmed = requestedPath.trim();
    if (trimmed.length > 0) {
      if (trimmed.endsWith(".png")) {
        const normalizedCopyTarget = normalizeScreenshotOutputDir(trimmed);
        return {
          outputDir: path.dirname(normalizedCopyTarget),
          copyTarget: normalizedCopyTarget,
        };
      }
      return { outputDir: normalizeScreenshotOutputDir(trimmed) };
    }
  }

  return {
    outputDir: path.join(
      SCREENSHOT_STORAGE_ROOT,
      `${Date.now()}-${sanitizeSegment(headBranch)}`
    ),
  };
}

export async function startScreenshotCollection(
  options: StartScreenshotCollectionOptions = {}
): Promise<ScreenshotCollectionResult> {
  await logToScreenshotCollector("start-screenshot-collection triggered");
  log("INFO", "Screenshot collection trigger recorded", {
    path: SCREENSHOT_COLLECTOR_LOG_PATH,
    openVSCodeUrl: SCREENSHOT_COLLECTOR_DIRECTORY_URL,
  });

  const workspaceDir = "/root/workspace";

  await logToScreenshotCollector(
    "Determining merge base from origin HEAD branch..."
  );
  const { baseBranch: detectedBaseBranch, mergeBase } =
    await resolveMergeBase(workspaceDir);
  const baseBranch = options.baseBranch ?? detectedBaseBranch;
  await logToScreenshotCollector(
    `Using merge base ${mergeBase} from ${baseBranch}`
  );

  let changedFiles =
    options.changedFiles && options.changedFiles.length > 0
      ? options.changedFiles
      : parseFileList(
          await runCommandCapture(
            "git",
            ["diff", "--name-only", `${mergeBase}..HEAD`],
            { cwd: workspaceDir }
          )
        );

  let usedWorkingTreeFallback = false;

  if (changedFiles.length === 0) {
    await logToScreenshotCollector(
      `No merge-base diff detected; falling back to working tree changes`
    );
    log("INFO", "Falling back to working tree diff for screenshots", {
      baseBranch,
      mergeBase,
    });

    const trackedDiffOutput = await runCommandCapture(
      "git",
      ["diff", "--name-only", "HEAD"],
      { cwd: workspaceDir }
    );
    const untrackedOutput = await runCommandCapture(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      { cwd: workspaceDir }
    );

    const trackedFiles = parseFileList(trackedDiffOutput);
    const untrackedFiles = parseFileList(untrackedOutput);
    const combined = new Set<string>([...trackedFiles, ...untrackedFiles]);
    changedFiles = Array.from(combined);
    usedWorkingTreeFallback = true;
  }

  if (changedFiles.length === 0) {
    const reason =
      "No changes detected in branch commits or working tree; skipping screenshots";
    await logToScreenshotCollector(reason);
    log("INFO", reason, {
      baseBranch,
      mergeBase,
    });
    return { status: "skipped", reason };
  }

  let textFiles: string[];
  if (usedWorkingTreeFallback) {
    textFiles = changedFiles;
    await logToScreenshotCollector(
      `Working tree fallback in effect; using ${textFiles.length} file(s) from git diff HEAD`
    );
  } else {
    textFiles = await filterTextFiles(workspaceDir, mergeBase, changedFiles);
    await logToScreenshotCollector(
      `Found ${textFiles.length} text file(s) with diffs out of ${changedFiles.length} total`
    );
    if (textFiles.length === 0) {
      const reason =
        "All changed files are binary; skipping screenshot collection";
      await logToScreenshotCollector("All changed files are binary; skipping");
      log("INFO", reason, {
        baseBranch,
        mergeBase,
        changedFiles,
      });
      return { status: "skipped", reason };
    }
  }

  await logToScreenshotCollector(
    `Text files queued for screenshots: ${textFiles.join(", ")}`
  );

  let commitSha: string;
  try {
    commitSha = await resolveCommitSha(workspaceDir);
    await logToScreenshotCollector(`Resolved commit ${commitSha}`);
  } catch (commitError) {
    const message =
      commitError instanceof Error
        ? commitError.message
        : String(commitError ?? "unknown commit error");
    await logToScreenshotCollector(`Failed to resolve commit: ${message}`);
    log("ERROR", "Failed to resolve commit for screenshots", {
      error: message,
    });
    return { status: "failed", error: message };
  }

  let prDescription = options.prDescription ?? null;
  if (!prDescription) {
    try {
      prDescription = await readPrDescription(workspaceDir);
      if (prDescription) {
        await logToScreenshotCollector(
          `PR description detected (${prDescription.length} characters)`
        );
      } else {
        await logToScreenshotCollector(
          "No PR description found; proceeding without additional context"
        );
      }
    } catch (descriptionError) {
      const message =
        descriptionError instanceof Error
          ? descriptionError.message
          : String(descriptionError ?? "unknown PR description error");
      await logToScreenshotCollector(
        `Failed to read PR description: ${message}`
      );
      log("ERROR", "Failed to read PR description for screenshots", {
        error: message,
      });
    }
  }

  const trimmedTaskRunJwt = options.taskRunJwt?.trim();
  const trimmedAnthropicKey =
    options.anthropicApiKey?.trim() ?? process.env.ANTHROPIC_API_KEY;

  let claudeAuth: ClaudeCodeAuthConfig | null = null;

  if (trimmedTaskRunJwt) {
    claudeAuth = { auth: { taskRunJwt: trimmedTaskRunJwt } };
    await logToScreenshotCollector(
      "Using taskRun JWT for Claude Code screenshot collection"
    );
    await logToScreenshotCollector(
      `JWT details: present=${!!trimmedTaskRunJwt}, length=${trimmedTaskRunJwt?.length ?? 0}, first 20 chars=${trimmedTaskRunJwt?.substring(0, 20) ?? "N/A"}`
    );
  } else if (trimmedAnthropicKey) {
    claudeAuth = { auth: { anthropicApiKey: trimmedAnthropicKey } };
    await logToScreenshotCollector(
      `ANTHROPIC_API_KEY source: ${
        options.anthropicApiKey?.trim() ? "payload" : "environment"
      }`
    );
    await logToScreenshotCollector(
      `ANTHROPIC_API_KEY (first 8 chars): ${
        trimmedAnthropicKey.slice(0, 8) ?? "<none>"
      }`
    );
  } else {
    const reason =
      "Missing Claude auth (taskRunJwt or ANTHROPIC_API_KEY required for screenshot collection)";
    await logToScreenshotCollector(reason);
    await logToScreenshotCollector(
      `Auth debug: taskRunJwt=${options.taskRunJwt ? "present" : "missing"}, anthropicApiKey=${options.anthropicApiKey ? "present" : "missing"}, env ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "present" : "missing"}`
    );
    log("ERROR", reason, { baseBranch, mergeBase });
    return { status: "skipped", reason };
  }

  const headBranch =
    options.headBranch ?? (await detectHeadBranch(workspaceDir)) ?? "HEAD";
  await logToScreenshotCollector(`Using head branch ${headBranch}`);

  const prTitle = resolvePrTitle({
    explicitTitle: options.prTitle,
    prDescription,
    headBranch,
  });

  const { outputDir, copyTarget } = resolveOutputDirectory(
    headBranch,
    options.outputPath
  );

  await logToScreenshotCollector(`Claude collector output dir: ${outputDir}`);

  try {
    const claudeResult = await claudeCodeCapturePRScreenshots({
      workspaceDir,
      changedFiles: textFiles,
      prTitle,
      prDescription: prDescription ?? "",
      baseBranch,
      headBranch,
      outputDir,
      pathToClaudeCodeExecutable: "/root/.bun/bin/claude",
      ...claudeAuth,
    });

    if (claudeResult.status === "completed") {
      const screenshotPaths = claudeResult.screenshotPaths ?? [];
      if (screenshotPaths.length === 0) {
        const error = "Claude collector reported success but returned no files";
        await logToScreenshotCollector(error);
        log("ERROR", error, { headBranch, outputDir });
        return { status: "failed", error };
      }

      const screenshotEntries: CapturedScreenshot[] = screenshotPaths.map(
        (absolutePath) => ({
          path: absolutePath,
          fileName: path.basename(absolutePath),
        })
      );

      if (screenshotEntries.length === 0) {
        const error = "Claude collector produced no screenshot entries";
        await logToScreenshotCollector(error);
        log("ERROR", error, { headBranch, outputDir, screenshotPaths });
        return { status: "failed", error };
      }

      const initialPrimary = screenshotEntries[0];
      if (!initialPrimary) {
        const error = "Unable to determine primary screenshot entry";
        await logToScreenshotCollector(error);
        log("ERROR", error, { headBranch, outputDir, screenshotPaths });
        return { status: "failed", error };
      }
      let primaryScreenshot: CapturedScreenshot = initialPrimary;

      if (typeof copyTarget === "string" && copyTarget.length > 0) {
        try {
          await fs.mkdir(path.dirname(copyTarget), { recursive: true });
          await fs.copyFile(primaryScreenshot.path, copyTarget);
          const updatedScreenshot: CapturedScreenshot = {
            path: copyTarget,
            fileName: path.basename(copyTarget),
          };
          screenshotEntries[0] = updatedScreenshot;
          primaryScreenshot = updatedScreenshot;
          await logToScreenshotCollector(
            `Primary screenshot copied to requested path: ${copyTarget}`
          );
        } catch (copyError) {
          const message =
            copyError instanceof Error
              ? copyError.message
              : String(copyError ?? "unknown copy error");
          await logToScreenshotCollector(
            `Failed to copy screenshot to requested path: ${message}`
          );
          log("WARN", "Failed to copy screenshot to requested path", {
            headBranch,
            outputDir,
            copyTarget,
            error: message,
          });
        }
      }

      if (screenshotEntries.length > 1) {
        await logToScreenshotCollector(
          `Captured ${screenshotEntries.length} screenshots; using ${primaryScreenshot.path} as primary upload`
        );
      } else {
        await logToScreenshotCollector(
          `Captured 1 screenshot at ${primaryScreenshot.path}`
        );
      }

      log("INFO", "Claude screenshot collector completed", {
        headBranch,
        baseBranch,
        commitSha,
        screenshotCount: screenshotEntries.length,
      });

      return {
        status: "completed",
        screenshots: screenshotEntries,
        commitSha,
      };
    }

    if (claudeResult.status === "skipped") {
      const reason = claudeResult.reason ?? "Claude collector skipped";
      await logToScreenshotCollector(reason);
      return { status: "skipped", reason };
    }

    const error = claudeResult.error ?? "Claude collector failed";
    await logToScreenshotCollector(`Claude collector failed: ${error}`);
    log("ERROR", "Claude screenshot collector failed", {
      error,
      headBranch,
      baseBranch,
    });
    return { status: "failed", error };
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    await logToScreenshotCollector(
      `start-screenshot-collection failed: ${reason}`
    );
    log("ERROR", "Failed to run Claude screenshot collector", {
      path: SCREENSHOT_COLLECTOR_LOG_PATH,
      openVSCodeUrl: SCREENSHOT_COLLECTOR_DIRECTORY_URL,
      error: reason,
    });
    return { status: "failed", error: reason };
  }
}
