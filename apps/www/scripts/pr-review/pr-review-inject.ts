#!/usr/bin/env bun

import { rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const execFileAsync = promisify(execFile);

type CallbackPayload =
  | {
      status: "success";
      jobId: string;
      sandboxInstanceId: string;
      codeReviewOutput: Record<string, unknown>;
    }
  | {
      status: "error";
      jobId: string;
      sandboxInstanceId?: string;
      errorCode?: string;
      errorDetail?: string;
    };

interface CallbackContext {
  url: string;
  token: string;
  jobId: string;
  sandboxInstanceId?: string;
}

async function sendCallback(
  context: CallbackContext,
  payload: CallbackPayload
): Promise<void> {
  const response = await fetch(context.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${context.token}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Callback failed with status ${response.status}: ${text.slice(0, 2048)}`
    );
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {}
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      cwd: options.cwd,
      env: options.env,
      shell: false,
    });

    child.once("error", (error) => reject(error));
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Command "${command} ${args.join(" ")}" exited with ${
            code === null ? `signal ${String(signal)}` : `code ${code}`
          }`
        )
      );
    });
  });
}

async function runCommandCapture(
  command: string,
  args: readonly string[],
  options: CommandOptions = {}
): Promise<string> {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseFileList(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

function logFileSection(label: string, files: string[]): void {
  console.log("[inject] ------------------------------");
  console.log(`[inject] ${label} (${files.length})`);
  if (files.length === 0) {
    console.log("[inject]   (none)");
    return;
  }
  files.forEach((file) => {
    console.log(`[inject]   ${file}`);
  });
}

function logIndentedBlock(header: string, content: string): void {
  console.log(header);
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    console.log("[inject]   (empty response)");
    return;
  }
  normalized.split("\n").forEach((line) => {
    console.log(`[inject]   ${line}`);
  });
}

interface RepoIdentifier {
  owner: string;
  name: string;
}

function parseRepoUrl(repoUrl: string): RepoIdentifier {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch (error) {
    throw new Error(
      `Unable to parse repository URL (${repoUrl}): ${String(
        error instanceof Error ? error.message : error
      )}`
    );
  }

  const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
  const [owner, name] = path.split("/");
  if (!owner || !name) {
    throw new Error(
      `Repository URL must be in the form https://github.com/<owner>/<repo>[.git], received: ${repoUrl}`
    );
  }
  return { owner, name };
}

function extractPathFromDiff(rawPath: string): string {
  const trimmed = rawPath.trim();
  const arrowIndex = trimmed.indexOf(" => ");
  if (arrowIndex === -1) {
    return trimmed;
  }

  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.indexOf("}");
  if (
    braceStart !== -1 &&
    braceEnd !== -1 &&
    braceEnd > braceStart &&
    braceStart < arrowIndex &&
    braceEnd > arrowIndex
  ) {
    const prefix = trimmed.slice(0, braceStart);
    const braceContent = trimmed.slice(braceStart + 1, braceEnd);
    const suffix = trimmed.slice(braceEnd + 1);
    const braceParts = braceContent.split(" => ");
    const replacement = braceParts[braceParts.length - 1] ?? "";
    return `${prefix}${replacement}${suffix}`;
  }

  const parts = trimmed.split(" => ");
  return parts[parts.length - 1] ?? trimmed;
}

async function filterTextFiles(
  workspaceDir: string,
  baseRevision: string,
  files: readonly string[]
): Promise<string[]> {
  if (files.length === 0) {
    return [];
  }

  const fileSet = new Set(files);
  const args = ["diff", "--numstat", `${baseRevision}..HEAD`, "--", ...files];

  const output = await runCommandCapture("git", args, { cwd: workspaceDir });
  const textFiles = new Set<string>();

  output.split("\n").forEach((line) => {
    if (!line.trim()) {
      return;
    }
    const parts = line.split("\t");
    if (parts.length < 3) {
      return;
    }
    const [addedRaw, deletedRaw, ...pathParts] = parts;
    if (!addedRaw || !deletedRaw || pathParts.length === 0) {
      return;
    }
    const added = addedRaw.trim();
    const deleted = deletedRaw.trim();
    if (added === "-" || deleted === "-") {
      // Binary diff shows "-" for text stats.
      return;
    }
    const rawPath = pathParts.join("\t").trim();
    if (!rawPath) {
      return;
    }
    const normalizedPath = extractPathFromDiff(rawPath);
    if (fileSet.has(normalizedPath)) {
      textFiles.add(normalizedPath);
      return;
    }
    if (fileSet.has(rawPath)) {
      textFiles.add(rawPath);
      return;
    }
    textFiles.add(normalizedPath);
  });

  return files.filter((file) => textFiles.has(file));
}

interface CodexReviewContext {
  workspaceDir: string;
  baseRevision: string;
  files: readonly string[];
}

async function runCodexReviews({
  workspaceDir,
  baseRevision,
  files,
}: CodexReviewContext): Promise<void> {
  if (files.length === 0) {
    console.log("[inject] No text files require Codex review.");
    return;
  }

  const openAiApiKey = requireEnv("OPENAI_API_KEY");

  console.log(
    `[inject] Launching Codex reviews for ${files.length} file(s)...`
  );

  const { Codex } = await import("@openai/codex-sdk");
  const codex = new Codex({ apiKey: openAiApiKey });

  const reviewResults = await Promise.allSettled(
    files.map(async (file) => {
      const diff = await runCommandCapture(
        "git",
        ["diff", `${baseRevision}..HEAD`, "--", file],
        { cwd: workspaceDir }
      );
      const thread = codex.startThread({ workingDirectory: workspaceDir });
      // const prompt = [
      //   "You are a senior engineer performing a focused pull request review.",
      //   `File path: ${file}`,
      //   "",
      //   "Review the diff below and identify bugs, risky changes, missing tests, or regressions.",
      //   'Respond with a concise bullet list of findings. If there is nothing to flag, respond with a single bullet stating "No issues found."',
      //   "",
      //   "Diff:",
      //   diff || "(no diff output)",
      // ].join("\n");
      const prompt = `\
You are a senior engineer performing a focused pull request review, focusing only on the file provided.
File path: ${file}
Return a JSON object of type { lines: { line: string, hasChanged: boolean, shouldBeReviewedScore?: boolean, shouldReviewWhy?: string, mostImportantCharacterIndex: number }[] }.
You should only have the "post-diff" array of lines in the JSON object, with the hasChanged true or false.

shouldBeReviewedScore and shouldReviewWhy should only be given if hasChanged is true. shouldReviewWhy should only be given if there is something interesting to say that might be non-obvious to the dev.

shouldBeReviewedScore is a number from 0 to 1 that indicates how careful the reviewer should be when reviewing this line of code.
Anything that feels like it might be off or might warrant a comment should have a high score, even if it's technically correct.

shouldReviewWhy should be a concise (4-10 words) hint on why the reviewer should maybe review this line of code, but it shouldn't state obvious things, instead it should only be a hint for the reviewer as to what exactly you meant when you flagged it.
In most cases, the reason should follow a template like "<X> <verb> <Y>" (eg. "line is too long" or "code accesses sensitive data").
It should be understandable by a human and make sense (break the "X is Y" rule if it helps you make it more understandable).

mostImportantCharacterIndex should be the index of the character that you deem most important in the review; if you're not sure or there are multiple, just choose any one of them.

Ugly code should be given a higher score.
Code that may be hard to read for a human should also be given a higher score.
Non-clean code too.

DO NOT BE LAZY DO THE ENTIRE FILE. FROM START TO FINISH. DO NOT BE LAZY.

The diff:
${diff || "(no diff output)"}`;

      const turn = await thread.run(prompt);
      const response = turn.finalResponse ?? "";
      logIndentedBlock(`[inject] Codex review for ${file}`, response);
      return response;
    })
  );

  let failureCount = 0;
  reviewResults.forEach((result, index) => {
    if (result.status === "rejected") {
      failureCount += 1;
      const file = files[index] ?? "(unknown file)";
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      console.error(`[inject] Codex review failed for ${file}: ${reason}`);
    }
  });

  if (failureCount > 0) {
    throw new Error(
      `[inject] Codex review encountered ${failureCount} failure(s). See logs above.`
    );
  }

  console.log("[inject] Codex reviews completed.");
}

async function main(): Promise<void> {
  const workspaceDir = requireEnv("WORKSPACE_DIR");
  const prUrl = requireEnv("PR_URL");
  const headRepoUrl = requireEnv("GIT_REPO_URL");
  const headRefName = requireEnv("GIT_BRANCH");
  const baseRepoUrl = requireEnv("BASE_REPO_URL");
  const baseRefName = requireEnv("BASE_REF_NAME");
  const callbackUrl = process.env.CALLBACK_URL ?? null;
  const callbackToken = process.env.CALLBACK_TOKEN ?? null;
  const jobId = requireEnv("JOB_ID");
  const sandboxInstanceId = requireEnv("SANDBOX_INSTANCE_ID");
  const logFilePath = process.env.LOG_FILE_PATH ?? null;
  const logSymlinkPath = process.env.LOG_SYMLINK_PATH ?? null;
  const teamId = process.env.TEAM_ID ?? null;
  const repoFullName = process.env.REPO_FULL_NAME ?? null;
  const commitRef = process.env.COMMIT_REF ?? null;

  const callbackContext: CallbackContext | null =
    callbackUrl && callbackToken
      ? {
          url: callbackUrl,
          token: callbackToken,
          jobId,
          sandboxInstanceId,
        }
      : null;

  if (logFilePath) {
    console.log(`[inject] Logging output to ${logFilePath}`);
  }
  if (logSymlinkPath) {
    console.log(`[inject] Workspace log symlink will be ${logSymlinkPath}`);
  }

  const headRepo = parseRepoUrl(headRepoUrl);
  const baseRepo = parseRepoUrl(baseRepoUrl);

  console.log(`[inject] Preparing review workspace for ${prUrl}`);
  console.log(
    `[inject] Head ${headRepo.owner}/${headRepo.name}@${headRefName}`
  );
  console.log(
    `[inject] Base ${baseRepo.owner}/${baseRepo.name}@${baseRefName}`
  );

  try {
    console.log(`[inject] Clearing workspace ${workspaceDir}...`);
    await rm(workspaceDir, { recursive: true, force: true });

    const cloneAndCheckout = (async () => {
      console.log(`[inject] Cloning ${headRepoUrl} into ${workspaceDir}...`);
      await runCommand("git", ["clone", headRepoUrl, workspaceDir]);
      console.log(`[inject] Checking out branch ${headRefName}...`);
      await runCommand("git", ["checkout", headRefName], {
        cwd: workspaceDir,
      });
    })();

    const installCodex = (async () => {
      console.log("[inject] Installing @openai/codex globally...");
      await runCommand("bun", [
        "add",
        "-g",
        "@openai/codex@latest",
        "@openai/codex-sdk@latest",
      ]);
    })();

    await Promise.all([cloneAndCheckout, installCodex]);

    if (logFilePath && logSymlinkPath) {
      try {
        await runCommand("ln", ["-sf", logFilePath, logSymlinkPath]);
        console.log(
          `[inject] Linked ${logSymlinkPath} -> ${logFilePath} for log access`
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error ?? "unknown error");
        console.warn(
          `[inject] Failed to create workspace log symlink: ${message}`
        );
      }
    }

    const baseRemote =
      headRepo.owner === baseRepo.owner && headRepo.name === baseRepo.name
        ? "origin"
        : "base";

    if (baseRemote !== "origin") {
      console.log(`[inject] Adding remote ${baseRemote} -> ${baseRepoUrl}`);
      await runCommand("git", ["remote", "add", baseRemote, baseRepoUrl], {
        cwd: workspaceDir,
      });
    }

    console.log(`[inject] Fetching ${baseRemote}/${baseRefName}...`);
    await runCommand("git", ["fetch", baseRemote, baseRefName], {
      cwd: workspaceDir,
    });

    const baseRevision = `${baseRemote}/${baseRefName}`;
    const mergeBaseRaw = await runCommandCapture(
      "git",
      ["merge-base", "HEAD", baseRevision],
      { cwd: workspaceDir }
    );
    const mergeBaseRevision = mergeBaseRaw.split("\n")[0]?.trim();
    if (!mergeBaseRevision) {
      throw new Error(
        `[inject] Unable to determine merge base between HEAD and ${baseRevision}`
      );
    }
    console.log(
      `[inject] Using merge-base ${mergeBaseRevision} for diff comparisons`
    );
    const [changedFilesOutput, modifiedFilesOutput] = await Promise.all([
      runCommandCapture(
        "git",
        ["diff", "--name-only", `${mergeBaseRevision}..HEAD`],
        {
          cwd: workspaceDir,
        }
      ),
      runCommandCapture(
        "git",
        [
          "diff",
          "--diff-filter=M",
          "--name-only",
          `${mergeBaseRevision}..HEAD`,
        ],
        { cwd: workspaceDir }
      ),
    ]);

    const changedFiles = parseFileList(changedFilesOutput);
    const modifiedFiles = parseFileList(modifiedFilesOutput);

    logFileSection("All changed files", changedFiles);
    logFileSection("All modified files", modifiedFiles);

    const [textChangedFiles, textModifiedFiles] = await Promise.all([
      filterTextFiles(workspaceDir, mergeBaseRevision, changedFiles),
      filterTextFiles(workspaceDir, mergeBaseRevision, modifiedFiles),
    ]);

    logFileSection("Changed text files", textChangedFiles);
    logFileSection("Modified text files", textModifiedFiles);

    await runCodexReviews({
      workspaceDir,
      baseRevision: mergeBaseRevision,
      files: textChangedFiles,
    });

    console.log("[inject] Done with PR review.");

    const reviewOutput: Record<string, unknown> = {
      prUrl,
      repoFullName:
        repoFullName ?? `${headRepo.owner}/${headRepo.name}`,
      headRefName,
      baseRefName,
      mergeBaseRevision,
      changedTextFiles: textChangedFiles,
      modifiedTextFiles: textModifiedFiles,
      logFilePath,
      logSymlinkPath,
      commitRef,
      teamId,
    };

    if (callbackContext) {
      await sendCallback(callbackContext, {
        status: "success",
        jobId,
        sandboxInstanceId,
        codeReviewOutput: reviewOutput,
      });
      console.log("[inject] Success callback delivered.");
    } else {
      console.log("[inject] Callback disabled; skipping success callback.");
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    console.error(`[inject] Error during review: ${message}`);
    if (callbackContext) {
      try {
        await sendCallback(callbackContext, {
          status: "error",
          jobId,
          sandboxInstanceId,
          errorCode: "inject_failed",
          errorDetail: message,
        });
        console.log("[inject] Failure callback delivered.");
      } catch (callbackError) {
        const callbackMessage =
          callbackError instanceof Error
            ? callbackError.message
            : String(callbackError ?? "unknown callback error");
        console.error(
          `[inject] Failed to send error callback: ${callbackMessage}`
        );
      }
    } else {
      console.log("[inject] Callback disabled; skipping error callback.");
    }
    throw error;
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
