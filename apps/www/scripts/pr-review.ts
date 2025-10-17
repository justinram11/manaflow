#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import process from "node:process";
import readline from "node:readline/promises";
import {
  startAutomatedPrReview,
  type PrReviewJobContext,
} from "../src/pr-review";

const DEFAULT_PR_URL = "https://github.com/manaflow-ai/cmux/pull/653";

interface ParsedPrUrl {
  owner: string;
  repo: string;
  number: number;
}

function parsePrUrl(prUrl: string): ParsedPrUrl {
  let url: URL;
  try {
    url = new URL(prUrl);
  } catch (_error) {
    throw new Error(`Invalid PR URL: ${prUrl}`);
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[2] !== "pull") {
    throw new Error(
      `PR URL must be in the form https://github.com/<owner>/<repo>/pull/<number>, received: ${prUrl}`
    );
  }

  const [owner, repo, _pull, numberRaw] = parts;
  const number = Number(numberRaw);
  if (!Number.isInteger(number)) {
    throw new Error(`Invalid pull request number in URL: ${prUrl}`);
  }

  return { owner, repo, number };
}

async function main(): Promise<void> {
  const prUrlInput = process.argv[2] ?? DEFAULT_PR_URL;
  const prUrl = prUrlInput.trim();
  if (prUrl.length === 0) {
    throw new Error("PR URL argument cannot be empty");
  }

  const parsed = parsePrUrl(prUrl);
  const repoFullName = `${parsed.owner}/${parsed.repo}`;
  const repoUrl = `https://github.com/${repoFullName}.git`;
  const jobId = randomUUID();
  const sandboxLabel = randomUUID();

  console.log(`[cli] Starting PR review for ${repoFullName}#${parsed.number}`);

  const config: PrReviewJobContext = {
    jobId,
    teamId: "cli",
    repoFullName,
    repoUrl,
    prNumber: parsed.number,
    prUrl,
    commitRef: "cli-run",
    morphSnapshotId: process.env.MORPH_SNAPSHOT_ID ?? undefined,
  };

  try {
    await startAutomatedPrReview(config);
    console.log(
      `[cli] Review launched (jobId=${jobId}, sandboxHint=${sandboxLabel}).`
    );
    console.log("[cli] Press Enter to exit.");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    await rl.question("");
    rl.close();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown error");
    console.error(`[cli] Review setup failed: ${message}`);
    throw error;
  }
}

await main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error
  );
  process.exit(1);
});
