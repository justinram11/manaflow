/**
 * Benchmark script for /morph/setup-instance endpoint
 *
 * This script calls the endpoint with client-side timing to measure end-to-end latency.
 * Server-side timing is captured via Sentry tracing.
 *
 * Run with: bun apps/www/scripts/bench-morph-setup.ts
 */

import { __TEST_INTERNAL_ONLY_GET_STACK_TOKENS } from "@/lib/test-utils/__TEST_INTERNAL_ONLY_GET_STACK_TOKENS";
import { __TEST_INTERNAL_ONLY_MORPH_CLIENT } from "@/lib/test-utils/__TEST_INTERNAL_ONLY_MORPH_CLIENT";
import { testApiClient } from "@/lib/test-utils/openapi-client";
import { postApiMorphSetupInstance } from "@cmux/www-openapi-client";

interface TimingResult {
  label: string;
  durationMs: number;
}

const timings: TimingResult[] = [];

function formatMs(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  return `${ms.toFixed(0)}ms`;
}

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const duration = performance.now() - start;
    timings.push({ label, durationMs: duration });
    console.log(`  [${formatMs(duration)}] ${label}`);
  }
}

function printSummary() {
  console.log("\n" + "=".repeat(60));
  console.log("TIMING SUMMARY");
  console.log("=".repeat(60));

  const sorted = [...timings].sort((a, b) => b.durationMs - a.durationMs);
  const total = timings
    .filter((t) => t.label.startsWith("Total:"))
    .reduce((sum, t) => sum + t.durationMs, 0);

  for (const { label, durationMs } of sorted) {
    const pct = total > 0 ? ((durationMs / total) * 100).toFixed(1) : "-";
    console.log(`${formatMs(durationMs).padStart(8)}  ${pct.padStart(5)}%  ${label}`);
  }

  console.log("=".repeat(60));
}

async function main() {
  let createdInstanceId: string | null = null;

  try {
    console.log("Benchmarking /morph/setup-instance endpoint\n");

    const tokens = await time("Get Stack auth tokens", async () => {
      return __TEST_INTERNAL_ONLY_GET_STACK_TOKENS();
    });

    console.log("\n--- Creating new instance (no repos) ---");
    const createResult = await time("Total: Create new instance", async () => {
      return postApiMorphSetupInstance({
        client: testApiClient,
        headers: { "x-stack-auth": JSON.stringify(tokens) },
        body: {
          teamSlugOrId: "manaflow",
          ttlSeconds: 300,
        },
      });
    });

    if (createResult.response.status !== 200) {
      console.error("Failed to create instance:", createResult.response.status);
      console.error("Error:", createResult.error);
      process.exit(1);
    }

    const instanceId = createResult.data?.instanceId;
    if (!instanceId) {
      console.error("No instanceId in response");
      process.exit(1);
    }
    createdInstanceId = instanceId;
    console.log(`  Created instance: ${instanceId}`);

    console.log("\n--- Reusing existing instance (no repos) ---");
    await time("Total: Reuse instance (no repos)", async () => {
      return postApiMorphSetupInstance({
        client: testApiClient,
        headers: { "x-stack-auth": JSON.stringify(tokens) },
        body: {
          teamSlugOrId: "manaflow",
          instanceId,
          ttlSeconds: 300,
        },
      });
    });

    console.log("\n--- Cloning 1 repo ---");
    const cloneResult = await time("Total: Clone 1 repo", async () => {
      return postApiMorphSetupInstance({
        client: testApiClient,
        headers: { "x-stack-auth": JSON.stringify(tokens) },
        body: {
          teamSlugOrId: "manaflow",
          instanceId,
          selectedRepos: ["manaflow-ai/manaflow-ai-cmux-testing-repo-1"],
          ttlSeconds: 300,
        },
      });
    });

    if (cloneResult.response.status === 200) {
      console.log(`  Cloned: ${cloneResult.data?.clonedRepos?.join(", ") || "none"}`);
    }

    console.log("\n--- Cloning 3 repos ---");
    const clone3Result = await time("Total: Clone 3 repos", async () => {
      return postApiMorphSetupInstance({
        client: testApiClient,
        headers: { "x-stack-auth": JSON.stringify(tokens) },
        body: {
          teamSlugOrId: "manaflow",
          instanceId,
          selectedRepos: [
            "manaflow-ai/manaflow-ai-cmux-testing-repo-1",
            "manaflow-ai/manaflow-ai-cmux-testing-repo-2",
            "manaflow-ai/manaflow-ai-cmux-testing-repo-3",
          ],
          ttlSeconds: 300,
        },
      });
    });

    if (clone3Result.response.status === 200) {
      console.log(`  Cloned: ${clone3Result.data?.clonedRepos?.join(", ") || "none"}`);
    }

    printSummary();
  } finally {
    if (createdInstanceId) {
      console.log(`\nCleaning up: stopping instance ${createdInstanceId}`);
      try {
        const inst = await __TEST_INTERNAL_ONLY_MORPH_CLIENT.instances.get({
          instanceId: createdInstanceId,
        });
        await inst.stop();
        console.log("Instance stopped.");
      } catch (e) {
        console.warn("Cleanup failed:", e);
      }
    }
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
