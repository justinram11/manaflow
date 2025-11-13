import {
  createMorphCloudClient,
  startInstanceInstancePost,
  getInstanceInstanceInstanceIdGet,
  execInstanceInstanceIdExecPost,
  stopInstanceInstanceInstanceIdDelete,
  type InstanceModel,
} from "@cmux/morphcloud-openapi-client";
import { SignJWT } from "jose";
import { env } from "../_shared/convex-env";
import { fetchInstallationAccessToken } from "../_shared/githubApp";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";

const sliceOutput = (value?: string | null, length = 200): string | undefined =>
  value?.slice(0, length);

const singleQuote = (value: string): string =>
  `'${value.replace(/'/g, "'\\''")}'`;

async function repoHasCommit({
  morphClient,
  instanceId,
  repoDir,
  commitSha,
  previewRunId,
}: {
  morphClient: ReturnType<typeof createMorphCloudClient>;
  instanceId: string;
  repoDir: string;
  commitSha: string;
  previewRunId: Id<"previewRuns">;
}): Promise<boolean> {
  const response = await execInstanceInstanceIdExecPost({
    client: morphClient,
    path: { instance_id: instanceId },
    body: {
      command: ["git", "-C", repoDir, "cat-file", "-e", `${commitSha}^{commit}`],
    },
  });

  if (response.error) {
    console.warn("[preview-jobs] Failed to check commit availability", {
      previewRunId,
      commitSha,
      error: response.error,
    });
    return false;
  }

  return response.data?.exit_code === 0;
}

async function ensureCommitAvailable({
  morphClient,
  instanceId,
  repoDir,
  commitSha,
  prNumber,
  previewRunId,
  headRepoCloneUrl,
  headRef,
}: {
  morphClient: ReturnType<typeof createMorphCloudClient>;
  instanceId: string;
  repoDir: string;
  commitSha: string;
  prNumber: number;
  previewRunId: Id<"previewRuns">;
  headRepoCloneUrl?: string;
  headRef?: string;
}): Promise<void> {
  if (await repoHasCommit({ morphClient, instanceId, repoDir, commitSha, previewRunId })) {
    return;
  }

  console.warn("[preview-jobs] Commit missing after initial fetch, attempting targeted fetches", {
    previewRunId,
    commitSha,
    prNumber,
    headRepoCloneUrl,
    headRef,
  });

  const fetchAttempts: Array<{
    description: string;
    command: string[];
  }> = [
    {
      description: "fetch commit by sha",
      command: ["git", "-C", repoDir, "fetch", "origin", commitSha],
    },
    {
      description: "fetch PR head ref",
      command: [
        "git",
        "-C",
        repoDir,
        "fetch",
        "origin",
        `+refs/pull/${prNumber}/head:refs/cmux/preview/pull/${prNumber}`,
      ],
    },
  ];

  // If PR is from a fork, add fork fetch as the highest priority
  if (headRepoCloneUrl && headRef) {
    fetchAttempts.unshift({
      description: "fetch from fork",
      command: [
        "git",
        "-C",
        repoDir,
        "fetch",
        headRepoCloneUrl,
        `${headRef}:refs/cmux/preview/fork/${prNumber}`,
      ],
    });
  }

  for (const attempt of fetchAttempts) {
    console.log("[preview-jobs] Targeted fetch attempt", {
      previewRunId,
      commitSha,
      prNumber,
      description: attempt.description,
    });

    const fetchResponse = await execInstanceInstanceIdExecPost({
      client: morphClient,
      path: { instance_id: instanceId },
      body: {
        command: attempt.command,
      },
    });

    if (fetchResponse.error || fetchResponse.data?.exit_code !== 0) {
      console.warn("[preview-jobs] Targeted fetch failed", {
        previewRunId,
        commitSha,
        prNumber,
        description: attempt.description,
        exitCode: fetchResponse.data?.exit_code,
        stderr: sliceOutput(fetchResponse.data?.stderr),
        stdout: sliceOutput(fetchResponse.data?.stdout),
        error: fetchResponse.error,
      });
      continue;
    }

    if (await repoHasCommit({ morphClient, instanceId, repoDir, commitSha, previewRunId })) {
      console.log("[preview-jobs] Commit available after targeted fetch", {
        previewRunId,
        commitSha,
        prNumber,
        description: attempt.description,
      });
      return;
    }
  }

  throw new Error(
    `Commit ${commitSha} is unavailable after targeted fetch attempts for PR #${prNumber}`,
  );
}

async function waitForInstanceReady(
  morphClient: ReturnType<typeof createMorphCloudClient>,
  instanceId: string,
  readinessTimeoutMs = 5 * 60 * 1000,
): Promise<InstanceModel> {
  const start = Date.now();
  while (true) {
    const response = await getInstanceInstanceInstanceIdGet({
      client: morphClient,
      path: { instance_id: instanceId },
    });

    if (response.error) {
      throw new Error(`Failed to get instance status: ${JSON.stringify(response.error)}`);
    }

    const instance = response.data;
    if (!instance) {
      throw new Error("Instance data missing from response");
    }

    if (instance.status === "ready") {
      return instance;
    }
    if (instance.status === "error") {
      throw new Error("Morph instance entered error state");
    }
    if (Date.now() - start > readinessTimeoutMs) {
      throw new Error("Morph instance did not become ready before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function startMorphInstance(
  morphClient: ReturnType<typeof createMorphCloudClient>,
  options: {
    snapshotId: string;
    metadata?: Record<string, string>;
    ttlSeconds?: number;
    ttlAction?: "stop" | "pause";
    readinessTimeoutMs?: number;
  },
): Promise<InstanceModel> {
  const response = await startInstanceInstancePost({
    client: morphClient,
    query: {
      snapshot_id: options.snapshotId,
    },
    body: {
      metadata: options.metadata,
      ttl_seconds: options.ttlSeconds,
      ttl_action: options.ttlAction,
    },
  });

  if (response.error) {
    throw new Error(`Failed to start instance: ${JSON.stringify(response.error)}`);
  }

  const instance = response.data;
  if (!instance) {
    throw new Error("Instance data missing from start response");
  }

  return await waitForInstanceReady(
    morphClient,
    instance.id,
    options.readinessTimeoutMs,
  );
}

async function stopMorphInstance(
  morphClient: ReturnType<typeof createMorphCloudClient>,
  instanceId: string,
) {
  await stopInstanceInstanceInstanceIdDelete({
    client: morphClient,
    path: { instance_id: instanceId },
  });
}

async function triggerWorkerScreenshotCollection(
  workerUrl: string,
  previewRunId: Id<"previewRuns">,
  config?: {
    taskId?: Id<"tasks">;
    taskRunId?: Id<"taskRuns">;
    taskRunJwt?: string;
    convexUrl?: string;
    anthropicApiKey?: string;
  },
): Promise<void> {
  const pollingBase = `${workerUrl}/socket.io/?EIO=4&transport=polling`;

  console.log("[preview-jobs] Starting Socket.IO handshake", {
    previewRunId,
    workerUrl,
    pollingBase,
  });

  // Step 1: Handshake to get session ID
  const handshakeResponse = await fetch(`${pollingBase}&t=${Date.now()}`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!handshakeResponse.ok) {
    throw new Error(`Socket.IO handshake failed: ${handshakeResponse.status} ${handshakeResponse.statusText}`);
  }

  const handshakeText = await handshakeResponse.text();
  console.log("[preview-jobs] Socket.IO handshake response", {
    previewRunId,
    status: handshakeResponse.status,
    responseLength: handshakeText.length,
    responsePreview: handshakeText.slice(0, 200),
  });

  // Parse session ID from response like: 0{"sid":"xxx","upgrades":[],"pingInterval":25000,"pingTimeout":20000}
  const startIdx = handshakeText.indexOf('{');
  const endIdx = handshakeText.lastIndexOf('}') + 1;
  if (startIdx === -1 || endIdx === 0) {
    throw new Error(`Failed to parse Socket.IO handshake response: ${handshakeText.slice(0, 200)}`);
  }
  const handshake = JSON.parse(handshakeText.slice(startIdx, endIdx)) as { sid: string };
  const sid = handshake.sid;

  console.log("[preview-jobs] Socket.IO session established", {
    previewRunId,
    sessionId: sid.slice(0, 8) + "...",
  });

  // Step 2: Connect to /management namespace
  const connectResponse = await fetch(`${pollingBase}&sid=${sid}&t=${Date.now()}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: "40/management",
    signal: AbortSignal.timeout(10_000),
  });

  if (!connectResponse.ok) {
    throw new Error(`Socket.IO namespace connect failed: ${connectResponse.status} ${connectResponse.statusText}`);
  }

  console.log("[preview-jobs] Connected to /management namespace", {
    previewRunId,
    status: connectResponse.status,
  });

  // Step 3: Send worker:start-screenshot-collection event
  const eventPayload = config && {
    taskId: config.taskId,
    taskRunId: config.taskRunId,
    taskRunJwt: config.taskRunJwt,
    convexUrl: config.convexUrl,
    anthropicApiKey: config.anthropicApiKey,
  };
  const eventBody = `42/management,${JSON.stringify(["worker:start-screenshot-collection", eventPayload])}`;
  const eventResponse = await fetch(`${pollingBase}&sid=${sid}&t=${Date.now()}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: eventBody,
    signal: AbortSignal.timeout(10_000),
  });

  if (!eventResponse.ok) {
    throw new Error(`Socket.IO event send failed: ${eventResponse.status} ${eventResponse.statusText}`);
  }

  console.log("[preview-jobs] Screenshot collection event sent", {
    previewRunId,
    status: eventResponse.status,
    hasConfig: Boolean(config),
    hasTaskId: Boolean(config?.taskId),
    hasTaskRunId: Boolean(config?.taskRunId),
    hasJwt: Boolean(config?.taskRunJwt),
  });
}

export async function runPreviewJob( 
  ctx: ActionCtx,
  previewRunId: Id<"previewRuns">,
) {
  const morphApiKey = env.MORPH_API_KEY;
  if (!morphApiKey) {
    console.warn("[preview-jobs] MORPH_API_KEY not configured; skipping run", {
      previewRunId,
    });
    await ctx.runMutation(internal.previewRuns.updateStatus, {
      previewRunId,
      status: "failed",
      stateReason: "Morph API key is not configured",
    });
    return;
  }

  const morphClient = createMorphCloudClient({
    auth: morphApiKey,
  });

  const payload = await ctx.runQuery(internal.previewRuns.getRunWithConfig, {
    previewRunId,
  });
  if (!payload?.run || !payload.config) {
    console.warn("[preview-jobs] Missing run/config for dispatch", {
      previewRunId,
    });
    return;
  }

  const { run, config } = payload;

  if (!config.environmentId) {
    console.warn("[preview-jobs] Preview config missing environmentId; skipping run", {
      previewRunId,
      repoFullName: run.repoFullName,
      prNumber: run.prNumber,
    });
    await ctx.runMutation(internal.previewRuns.updateStatus, {
      previewRunId,
      status: "skipped",
      stateReason: "No environment configured for preview run",
    });
    return;
  }

  const environment = await ctx.runQuery(internal.environments.getByIdInternal, {
    id: config.environmentId,
  });

  if (!environment) {
    console.warn("[preview-jobs] Environment not found for preview run; skipping", {
      previewRunId,
      environmentId: config.environmentId,
    });
    await ctx.runMutation(internal.previewRuns.updateStatus, {
      previewRunId,
      status: "skipped",
      stateReason: "Environment not found for preview run",
    });
    return;
  }

  if (!environment.morphSnapshotId) {
    console.warn("[preview-jobs] Environment missing morph snapshot; skipping", {
      previewRunId,
      environmentId: environment._id,
    });
    await ctx.runMutation(internal.previewRuns.updateStatus, {
      previewRunId,
      status: "skipped",
      stateReason: "Environment has no associated Morph snapshot",
    });
    return;
  }

  const snapshotId = environment.morphSnapshotId;
  let instance: InstanceModel | null = null;

  console.log("[preview-jobs] Launching Morph instance", {
    previewRunId,
    snapshotId,
    repoFullName: run.repoFullName,
    prNumber: run.prNumber,
    headSha: run.headSha,
    baseSha: run.baseSha,
  });

  await ctx.runMutation(internal.previewRuns.updateStatus, {
    previewRunId,
    status: "running",
    stateReason: "Provisioning Morph workspace",
  });

  try {
    instance = await startMorphInstance(morphClient, {
      snapshotId,
      metadata: {
        app: "cmux-preview",
        previewRunId: previewRunId,
        repo: run.repoFullName,
        prNumber: String(run.prNumber),
        headSha: run.headSha,
      },
      ttlSeconds: 600,
      ttlAction: "stop",
      readinessTimeoutMs: 5 * 60 * 1000,
    });

    const workerService = instance.networking?.http_services?.find(
      (service: { port?: number }) => service.port === 39377,
    );
    if (!workerService) {
      throw new Error("Worker service not found on instance");
    }

    const vscodeService = instance.networking?.http_services?.find(
      (service: { port?: number }) => service.port === 39378,
    );
    const vscodeUrl = vscodeService?.url
      ? `${vscodeService.url}?folder=/root/workspace`
      : null;

    console.log("[preview-jobs] Worker service ready", {
      previewRunId,
      instanceId: instance.id,
      vscodeUrl,
      workerUrl: workerService.url,
      workerHealthUrl: `${workerService.url}/health`,
      screenshotLogUrl: `${workerService.url.replace(':39377', ':39376')}/file?path=/root/.cmux/screenshot-collector/screenshot-collector.log`,
    });

    // Step 2: Fetch latest changes and checkout PR
    // Preview environment snapshots have the repo pre-cloned at /root/workspace
    const repoSearchRoot = "/root/workspace";

    await ctx.runMutation(internal.previewRuns.updateStatus, {
      previewRunId,
      status: "running",
      stateReason: "Fetching latest changes",
    });

    // The repository is always at /root/workspace directly
    const repoDir = repoSearchRoot;

    console.log("[preview-jobs] Using pre-cloned repository", {
      previewRunId,
      repoFullName: run.repoFullName,
      repoDir,
    });

    console.log("[preview-jobs] Starting GitHub authentication setup", {
      previewRunId,
      hasInstallationId: Boolean(run.repoInstallationId),
      installationId: run.repoInstallationId,
    });

    // Get GitHub App installation token for fetching from private repos
    if (run.repoInstallationId) {
      console.log("[preview-jobs] Fetching installation access token", {
        previewRunId,
        installationId: run.repoInstallationId,
      });

      let accessToken: string | null = null;
      try {
        accessToken = await fetchInstallationAccessToken(run.repoInstallationId);
      } catch (error) {
        console.error("[preview-jobs] Failed to fetch installation token", {
          previewRunId,
          installationId: run.repoInstallationId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      console.log("[preview-jobs] Installation token fetch result", {
        previewRunId,
        hasToken: Boolean(accessToken),
      });

      if (accessToken) {
        const escapedToken = singleQuote(accessToken);

        // Configure GitHub authentication using gh CLI with retry logic (same approach as cloud workspaces)
        let lastError: Error | undefined;
        let authSucceeded = false;
        const maxRetries = 5;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const shellScript = `cd ${repoDir} && printf %s ${escapedToken} | gh auth login --with-token && gh auth setup-git 2>&1`;

            const ghAuthResponse = await execInstanceInstanceIdExecPost({
              client: morphClient,
              path: { instance_id: instance.id },
              body: {
                command: ["bash", "-lc", shellScript],
              },
            });

            console.log("[preview-jobs] GitHub auth response received", {
              previewRunId,
              attempt,
              hasError: Boolean(ghAuthResponse.error),
              exitCode: ghAuthResponse.data?.exit_code,
              stdout: sliceOutput(ghAuthResponse.data?.stdout, 500),
              stderr: sliceOutput(ghAuthResponse.data?.stderr, 500),
            });

            if (ghAuthResponse.error) {
              lastError = new Error(`API error: ${JSON.stringify(ghAuthResponse.error)}`);
              console.error("[preview-jobs] GitHub auth API error", {
                previewRunId,
                attempt,
                error: ghAuthResponse.error,
              });
            } else if (ghAuthResponse.data?.exit_code === 0) {
              console.log("[preview-jobs] GitHub authentication configured successfully", {
                previewRunId,
                attempt,
                stdout: sliceOutput(ghAuthResponse.data?.stdout, 500),
                stderr: sliceOutput(ghAuthResponse.data?.stderr, 500),
              });
              authSucceeded = true;
              break;
            } else {
              const errorMessage = ghAuthResponse.data?.stderr || ghAuthResponse.data?.stdout || "Unknown error";
              lastError = new Error(`GitHub auth failed: ${errorMessage.slice(0, 500)}`);
              console.warn("[preview-jobs] GitHub auth command failed", {
                previewRunId,
                attempt,
                exitCode: ghAuthResponse.data?.exit_code,
                stderr: sliceOutput(ghAuthResponse.data?.stderr, 200),
                stdout: sliceOutput(ghAuthResponse.data?.stdout, 200),
              });
            }

            if (attempt < maxRetries) {
              const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
              console.log("[preview-jobs] Retrying GitHub auth", {
                previewRunId,
                attempt,
                delayMs: delay,
              });
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          } catch (error) {
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            lastError = normalizedError;
            console.error("[preview-jobs] GitHub auth attempt threw error", {
              previewRunId,
              attempt,
              error: normalizedError.message,
            });

            if (attempt < maxRetries) {
              const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }
        }

        if (!authSucceeded) {
          console.error("[preview-jobs] GitHub authentication failed after all retries", {
            previewRunId,
            maxRetries,
            lastError: lastError?.message,
          });
          const finalErrorMessage = lastError?.message || "Unknown error";
          throw new Error(
            `GitHub authentication failed after ${maxRetries} attempts: ${finalErrorMessage}`
          );
        }
      } else {
        console.warn("[preview-jobs] Failed to fetch installation token, falling back to public fetch", {
          previewRunId,
          installationId: run.repoInstallationId,
        });
      }
    } else {
      console.log("[preview-jobs] No installation ID, skipping GitHub authentication", {
        previewRunId,
      });
    }

    console.log("[preview-jobs] Starting git fetch from origin", {
      previewRunId,
      repoDir,
    });

    // Fetch the latest changes from origin (fetch all refs)
    const fetchResponse = await execInstanceInstanceIdExecPost({
      client: morphClient,
      path: { instance_id: instance.id },
      body: {
        command: ["git", "-C", repoDir, "fetch", "origin"],
      },
    });

    if (fetchResponse.error || fetchResponse.data?.exit_code !== 0) {
      console.error("[preview-jobs] Fetch failed", {
        previewRunId,
        exitCode: fetchResponse.data?.exit_code,
        stdout: fetchResponse.data?.stdout,
        stderr: fetchResponse.data?.stderr,
      });
      throw new Error(
        `Failed to fetch from origin (exit ${fetchResponse.data?.exit_code}): ${fetchResponse.data?.stderr || fetchResponse.data?.stdout}`
      );
    }

    console.log("[preview-jobs] Fetched latest changes from origin", {
      previewRunId,
      headSha: run.headSha,
    });

    await ensureCommitAvailable({
      morphClient,
      instanceId: instance.id,
      repoDir,
      commitSha: run.headSha,
      prNumber: run.prNumber,
      previewRunId,
      headRepoCloneUrl: run.headRepoCloneUrl,
      headRef: run.headRef,
    });

    console.log("[preview-jobs] Starting git checkout", {
      previewRunId,
      headSha: run.headSha,
      repoDir,
    });

    // Step 3: Checkout the PR commit
    await ctx.runMutation(internal.previewRuns.updateStatus, {
      previewRunId,
      status: "running",
      stateReason: "Checking out PR commit",
    });

    const checkoutResponse = await execInstanceInstanceIdExecPost({
      client: morphClient,
      path: { instance_id: instance.id },
      body: {
        command: ["git", "-C", repoDir, "checkout", run.headSha],
      },
    });

    if (checkoutResponse.error) {
      throw new Error(
        `Failed to checkout PR branch ${run.headSha}: ${JSON.stringify(checkoutResponse.error)}`,
      );
    }

    const checkoutResult = checkoutResponse.data;
    if (!checkoutResult) {
      throw new Error("Checkout command returned no data");
    }

    if (checkoutResult.exit_code !== 0) {
      console.error("[preview-jobs] Checkout failed - full output", {
        previewRunId,
        headSha: run.headSha,
        exitCode: checkoutResult.exit_code,
        stdout: checkoutResult.stdout,
        stderr: checkoutResult.stderr,
      });
      throw new Error(
        `Failed to checkout PR branch ${run.headSha} (exit ${checkoutResult.exit_code}): stderr="${checkoutResult.stderr}" stdout="${checkoutResult.stdout}"`,
      );
    }

    console.log("[preview-jobs] Checked out PR branch", {
      previewRunId,
      headSha: run.headSha,
      stdout: checkoutResult.stdout?.slice(0, 200),
    });

    // Step 4: Trigger screenshot collection
    await ctx.runMutation(internal.previewRuns.updateStatus, {
      previewRunId,
      status: "running",
      stateReason: "Collecting screenshots",
    });

    console.log("[preview-jobs] Triggering screenshot collection", {
      previewRunId,
      workerUrl: workerService.url,
      screenshotLogUrl: `${workerService.url.replace(':39377', ':39376')}/file?path=/root/.cmux/screenshot-collector/screenshot-collector.log`,
    });

    // Get taskRunId and taskId for screenshot upload workflow
    let screenshotConfig:
      | { taskId: Id<"tasks">; taskRunId: Id<"taskRuns">; taskRunJwt: string; convexUrl: string; anthropicApiKey?: string }
      | undefined;

    if (run.taskRunId) {
      const taskRun = await ctx.runQuery(internal.taskRuns.getById, {
        id: run.taskRunId,
      });

      if (taskRun) {
        console.log("[preview-jobs] Preparing screenshot config", {
          previewRunId,
          taskId: taskRun.taskId,
          taskRunId: run.taskRunId,
        });

        // Generate JWT for screenshot upload authentication
        const jwt = await new SignJWT({
          taskRunId: run.taskRunId,
          teamId: run.teamId,
          userId: taskRun.userId,
        })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuedAt()
          .setExpirationTime("12h")
          .sign(new TextEncoder().encode(env.CMUX_TASK_RUN_JWT_SECRET));

        screenshotConfig = {
          taskId: taskRun.taskId,
          taskRunId: run.taskRunId,
          taskRunJwt: jwt,
          convexUrl: env.BASE_APP_URL,
          anthropicApiKey: env.ANTHROPIC_API_KEY,
        };
      } else {
        console.warn("[preview-jobs] TaskRun not found for preview run", {
          previewRunId,
          taskRunId: run.taskRunId,
        });
      }
    } else {
      console.warn("[preview-jobs] No taskRunId linked to preview run", {
        previewRunId,
      });
    }

    await triggerWorkerScreenshotCollection(workerService.url, previewRunId, screenshotConfig);

    console.log("[preview-jobs] Screenshot collection triggered", {
      previewRunId,
      hasScreenshotConfig: Boolean(screenshotConfig),
    });

    // Step 5: Wait for screenshots to complete
    // The worker will now use runTaskScreenshots() which uploads directly to taskRunScreenshotSets
    await ctx.runMutation(internal.previewRuns.updateStatus, {
      previewRunId,
      status: "running",
      stateReason: "Waiting for screenshot collection to complete",
    });

    console.log("[preview-jobs] Waiting for screenshots to complete...", {
      previewRunId,
      waitTimeSeconds: 120,
    });

    // Wait 2 minutes for screenshot collection
    // TODO: Replace with listening to worker:screenshot-collection-complete event
    await new Promise((resolve) => setTimeout(resolve, 120_000));

    console.log("[preview-jobs] Screenshot collection wait complete", {
      previewRunId,
    });

    // Check if screenshots were uploaded to taskRunScreenshotSets
    if (run.taskRunId) {
      const taskRun = await ctx.runQuery(internal.taskRuns.getById, {
        id: run.taskRunId,
      });

      if (taskRun?.latestScreenshotSetId) {
        console.log("[preview-jobs] Screenshots uploaded to taskRunScreenshotSets", {
          previewRunId,
          screenshotSetId: taskRun.latestScreenshotSetId,
        });

        await ctx.runMutation(internal.previewRuns.updateStatus, {
          previewRunId,
          status: "completed",
          stateReason: "Screenshots collected and uploaded",
        });

        // TODO: Trigger GitHub comment using screenshots from taskRunScreenshotSets
        console.log("[preview-jobs] Preview job completed with screenshots", { previewRunId });
      } else {
        console.warn("[preview-jobs] No screenshots found in taskRunScreenshotSets", {
          previewRunId,
          taskRunId: run.taskRunId,
        });

        await ctx.runMutation(internal.previewRuns.updateStatus, {
          previewRunId,
          status: "completed",
          stateReason: "No screenshots generated",
        });
      }
    } else {
      console.warn("[preview-jobs] No taskRunId to check for screenshots", {
        previewRunId,
      });

      await ctx.runMutation(internal.previewRuns.updateStatus, {
        previewRunId,
        status: "completed",
        stateReason: "Screenshot collection completed (no taskRun)",
      });
    }

    console.log("[preview-jobs] Preview job completed", { previewRunId });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "Unknown error");
    console.error("[preview-jobs] Preview job failed", {
      previewRunId,
      error: message,
    });

    try {
      await ctx.runMutation(internal.previewRuns.updateStatus, {
        previewRunId,
        status: "failed",
        stateReason: message,
      });
    } catch (statusError) {
      console.error("[preview-jobs] Failed to update preview status", {
        previewRunId,
        error: statusError,
      });
    }

    throw error;
  } finally {
    if (instance) {
      try {
        await stopMorphInstance(morphClient, instance.id);
      } catch (stopError) {
        console.warn("[preview-jobs] Failed to stop Morph instance", {
          previewRunId,
          instanceId: instance.id,
          error: stopError,
        });
      }
    }
  }
}
