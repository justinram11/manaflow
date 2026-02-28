// @ts-nocheck - Legacy script, uses removed Convex APIs
import type { Id } from "@cmux/convex/dataModel";
import type { ReplaceDiffEntry } from "@cmux/shared/diff-types";
import { StackAdminApp } from "@stackframe/js";
import {
  getRunDiffs,
  type GetRunDiffsPerf,
} from "../../apps/server/src/diffs/getRunDiffs";
import { GitDiffManager } from "../../apps/server/src/gitDiff";
import { runWithAuthToken } from "../../apps/server/src/utils/requestContext";

type CliArgs = {
  run?: string;
  team: string;
  user?: string;
  includeContents: boolean;
  summaryOnly: boolean;
  pretty: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    team: "default",
    includeContents: true,
    summaryOnly: false,
    pretty: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--run" || a === "-r") out.run = argv[++i];
    else if (a === "--team" || a === "-t") out.team = argv[++i] ?? out.team;
    else if (a === "--user" || a === "-u") out.user = argv[++i];
    else if (a === "--no-contents") out.includeContents = false;
    else if (a === "--summary" || a === "-s") out.summaryOnly = true;
    else if (a === "--pretty" || a === "-p") out.pretty = true;
    else if (!out.run) out.run = a; // positional run id
  }
  return out;
}

async function mintStackAccessToken(userId: string): Promise<string> {
  const {
    NEXT_PUBLIC_STACK_PROJECT_ID,
    NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY,
    STACK_SECRET_SERVER_KEY,
    STACK_SUPER_SECRET_ADMIN_KEY,
  } = process.env as Record<string, string | undefined>;

  const admin = new StackAdminApp({
    tokenStore: "memory",
    projectId: NEXT_PUBLIC_STACK_PROJECT_ID,
    publishableClientKey: NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY,
    secretServerKey: STACK_SECRET_SERVER_KEY,
    superSecretAdminKey: STACK_SUPER_SECRET_ADMIN_KEY,
  });

  const user = await admin.getUser(userId);
  if (!user) throw new Error("User not found");
  const session = await user.createSession({ expiresInMillis: 10 * 60 * 1000 });
  const tokens = await session.getTokens();
  const token = tokens.accessToken;
  if (!token) throw new Error("No access token returned");
  return token;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args.run) {
    console.error(
      "Usage: bun run scripts/stackframe/get-run-diffs.ts --run <taskRunId> [--team <slug>] [--user <uuid>] [--no-contents] [--summary]"
    );
    process.exit(1);
  }

  // Default test user used elsewhere in the repo
  const defaultTestUser = "487b5ddc-0da0-4f12-8834-f452863a83f5";
  const userId = args.user || process.env.CMUX_TEST_USER_ID || defaultTestUser;

  const tToken0 = Date.now();
  const accessToken = await mintStackAccessToken(userId);
  const tToken1 = Date.now();

  const gitDiffManager = new GitDiffManager();
  const tDiff0 = Date.now();

  const perf: GetRunDiffsPerf = {
    ensureMs: 0,
    computeMs: 0,
    watchMs: 0,
    totalMs: 0,
    watchStarted: false,
  };

  const diffs = await runWithAuthToken(accessToken, async () => {
    return await getRunDiffs({
      taskRunId: args.run as Id<"taskRuns">,
      teamSlugOrId: args.team,
      gitDiffManager,
      includeContents: args.includeContents,
      perfOut: perf,
    });
  });

  const tDiff1 = Date.now();
  const tokenMs = tToken1 - tToken0;
  const diffMs = tDiff1 - tDiff0;
  const totalMs = tokenMs + diffMs;

  if (args.summaryOnly) {
    const summary = {
      runId: args.run,
      team: args.team,
      userId,
      count: (diffs as ReplaceDiffEntry[]).length,
      tokenMs,
      diffMs,
      totalMs,
      perf,
    };
    if (args.pretty) {
      printPretty(summary);
    } else {
      console.log(JSON.stringify(summary, null, 2));
    }
  } else {
    const output = {
      runId: args.run,
      team: args.team,
      userId,
      count: (diffs as ReplaceDiffEntry[]).length,
      tokenMs,
      diffMs,
      totalMs,
      perf,
      diffs,
    };
    if (args.pretty) {
      printPretty(output);
    } else {
      console.log(JSON.stringify(output, null, 2));
    }
  }
}

void main();

function ms(n: number | undefined): string {
  if (!n || n < 0) return "0ms";
  return `${n}ms`;
}

function printPretty(data: {
  runId?: string;
  team?: string;
  userId?: string;
  count?: number;
  tokenMs?: number;
  diffMs?: number;
  totalMs?: number;
  perf?: GetRunDiffsPerf;
}): void {
  const p = data.perf;
  const lines: string[] = [];
  lines.push("cmux get-run-diffs summary");
  lines.push("--------------------------");
  if (data.runId) lines.push(`run:   ${data.runId}`);
  if (data.team) lines.push(`team:  ${data.team}`);
  if (data.userId) lines.push(`user:  ${data.userId}`);
  if (typeof data.count === "number") lines.push(`files: ${data.count}`);
  lines.push("");
  lines.push("Timings");
  lines.push("  token:      " + ms(data.tokenMs));
  lines.push("  ensure:     " + ms(p?.ensureMs));
  lines.push("  compute:    " + ms(p?.computeMs));
  lines.push("  watch:      " + ms(p?.watchMs));
  lines.push("  total:      " + ms(p?.totalMs));
  lines.push("");

  // Native ref diff does not emit granular TS perf breakdown here.
  console.log(lines.join("\n"));
}
