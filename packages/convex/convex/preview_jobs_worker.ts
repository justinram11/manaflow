import {
  createMorphCloudClient,
  startInstanceInstancePost,
  getInstanceInstanceInstanceIdGet,
  execInstanceInstanceIdExecPost,
  stopInstanceInstanceInstanceIdDelete,
  type InstanceModel,
} from "@cmux/morphcloud-openapi-client";
import { env } from "../_shared/convex-env";
import { fetchInstallationAccessToken } from "../_shared/githubApp";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";

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
): Promise<void> {
  const pollingBase = `${workerUrl}/socket.io/?EIO=4&transport=polling`;

  // Step 1: Handshake to get session ID
  const handshakeResponse = await fetch(`${pollingBase}&t=${Date.now()}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const handshakeText = await handshakeResponse.text();

  // Parse session ID from response like: 0{"sid":"xxx","upgrades":[],"pingInterval":25000,"pingTimeout":20000}
  const startIdx = handshakeText.indexOf('{');
  const endIdx = handshakeText.lastIndexOf('}') + 1;
  if (startIdx === -1 || endIdx === 0) {
    throw new Error("Failed to parse Socket.IO handshake response");
  }
  const handshake = JSON.parse(handshakeText.slice(startIdx, endIdx)) as { sid: string };
  const sid = handshake.sid;

  // Step 2: Connect to /management namespace
  await fetch(`${pollingBase}&sid=${sid}&t=${Date.now()}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: "40/management",
    signal: AbortSignal.timeout(10_000),
  });

  // Step 3: Send worker:start-screenshot-collection event
  await fetch(`${pollingBase}&sid=${sid}&t=${Date.now()}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: `42/management,${JSON.stringify(["worker:start-screenshot-collection"])}`,
    signal: AbortSignal.timeout(10_000),
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

    console.log("[preview-jobs] Worker service ready", {
      previewRunId,
      instanceId: instance.id,
      workerUrl: workerService.url,
      workerHealthUrl: `${workerService.url}/health`,
      screenshotLogUrl: `${workerService.url.replace(':39377', ':39376')}/file?path=/root/.cmux/screenshot-collector/screenshot-collector.log`,
    });

    // Step 2: Clone the repository
    await ctx.runMutation(internal.previewRuns.updateStatus, {
      previewRunId,
      status: "running",
      stateReason: "Cloning repository",
    });

    // Get GitHub App installation token for cloning private repos
    let cloneUrl = `https://github.com/${run.repoFullName}.git`;
    if (run.repoInstallationId) {
      const accessToken = await fetchInstallationAccessToken(run.repoInstallationId);
      if (accessToken) {
        cloneUrl = `https://x-access-token:${accessToken}@github.com/${run.repoFullName}.git`;
      } else {
        console.warn("[preview-jobs] Failed to fetch installation token, falling back to public clone", {
          previewRunId,
          installationId: run.repoInstallationId,
        });
      }
    }

    const workspaceDir = "/workspace";

    console.log("[preview-jobs] Executing git clone", {
      previewRunId,
      repoFullName: run.repoFullName,
      targetDir: workspaceDir,
      hasToken: cloneUrl.includes("x-access-token"),
    });

    const cloneResponse = await execInstanceInstanceIdExecPost({
      client: morphClient,
      path: { instance_id: instance.id },
      body: {
        command: ["git", "clone", cloneUrl, workspaceDir],
      },
    });

    if (cloneResponse.error) {
      throw new Error(
        `Failed to clone repository ${run.repoFullName}: ${JSON.stringify(cloneResponse.error)}`,
      );
    }

    const cloneResult = cloneResponse.data;
    if (!cloneResult) {
      throw new Error("Clone command returned no data");
    }

    console.log("[preview-jobs] Clone command output", {
      previewRunId,
      exitCode: cloneResult.exit_code,
      stdout: cloneResult.stdout?.slice(0, 500),
      stderr: cloneResult.stderr?.slice(0, 500),
    });

    if (cloneResult.exit_code !== 0) {
      console.error("[preview-jobs] Clone failed - full output", {
        previewRunId,
        exitCode: cloneResult.exit_code,
        stdout: cloneResult.stdout,
        stderr: cloneResult.stderr,
        stdoutLength: cloneResult.stdout?.length || 0,
        stderrLength: cloneResult.stderr?.length || 0,
      });
      throw new Error(
        `Failed to clone repository ${run.repoFullName} (exit ${cloneResult.exit_code}): stderr="${cloneResult.stderr}" stdout="${cloneResult.stdout}"`,
      );
    }

    // Verify the clone created a .git directory
    const verifyResponse = await execInstanceInstanceIdExecPost({
      client: morphClient,
      path: { instance_id: instance.id },
      body: {
        command: ["test", "-d", `${workspaceDir}/.git`],
      },
    });

    const verifyResult = verifyResponse.data;
    console.log("[preview-jobs] Verify .git directory", {
      previewRunId,
      exitCode: verifyResult?.exit_code,
    });

    if (verifyResult?.exit_code !== 0) {
      throw new Error(
        `Git clone succeeded but ${workspaceDir}/.git not found. Clone output: ${cloneResult.stdout}`
      );
    }

    console.log("[preview-jobs] Cloned repository", {
      previewRunId,
      repoFullName: run.repoFullName,
    });

    // Step 3: Checkout the PR branch
    await ctx.runMutation(internal.previewRuns.updateStatus, {
      previewRunId,
      status: "running",
      stateReason: "Checking out PR branch",
    });

    const checkoutResponse = await execInstanceInstanceIdExecPost({
      client: morphClient,
      path: { instance_id: instance.id },
      body: {
        command: ["git", "-C", workspaceDir, "checkout", run.headSha],
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

    await triggerWorkerScreenshotCollection(workerService.url);

    console.log("[preview-jobs] Screenshot collection triggered", {
      previewRunId,
    });

    // Step 5: Wait for screenshots to complete (give Claude time to collect)
    await ctx.runMutation(internal.previewRuns.updateStatus, {
      previewRunId,
      status: "running",
      stateReason: "Waiting for screenshots to complete",
    });

    console.log("[preview-jobs] Waiting for screenshots to complete...", {
      previewRunId,
      waitTimeSeconds: 120,
    });

    // Wait 2 minutes for Claude to collect screenshots
    await new Promise((resolve) => setTimeout(resolve, 120_000));

    // Step 6: Fetch screenshot file list
    const fileServiceUrl = workerService.url.replace(':39377', ':39376');
    const screenshotDirPath = "/root/.cmux/screenshot-collector/screenshots";

    console.log("[preview-jobs] Fetching screenshot list", {
      previewRunId,
      fileServiceUrl,
      screenshotDirPath,
    });

    // List files via Morph exec
    const listResponse = await execInstanceInstanceIdExecPost({
      client: morphClient,
      path: { instance_id: instance.id },
      body: {
        command: ["find", screenshotDirPath, "-type", "f", "-name", "*.png"],
      },
    });

    if (listResponse.error) {
      console.warn("[preview-jobs] Failed to list screenshots", {
        previewRunId,
        error: listResponse.error,
      });
    }

    const listResult = listResponse.data;
    const screenshotPaths = listResult?.stdout
      ? listResult.stdout.split('\n').map((p: string) => p.trim()).filter((p: string) => p.length > 0)
      : [];

    console.log("[preview-jobs] Found screenshots", {
      previewRunId,
      count: screenshotPaths.length,
      paths: screenshotPaths,
    });

    if (screenshotPaths.length === 0) {
      await ctx.runMutation(internal.previewRuns.updateStatus, {
        previewRunId,
        status: "completed",
        stateReason: "No screenshots generated",
      });
      return;
    }

    // Step 7: Download and upload screenshots
    await ctx.runMutation(internal.previewRuns.updateStatus, {
      previewRunId,
      status: "running",
      stateReason: "Uploading screenshots",
    });

    const uploadedImages: Array<{
      storageId: string;
      mimeType: string;
      fileName: string;
      commitSha: string;
    }> = [];

    for (const screenshotPath of screenshotPaths) {
      try {
        // Download screenshot from file service
        const fileUrl = `${fileServiceUrl}/file?path=${encodeURIComponent(screenshotPath)}`;
        const downloadResponse = await fetch(fileUrl, {
          signal: AbortSignal.timeout(30_000),
        });

        if (!downloadResponse.ok) {
          console.warn("[preview-jobs] Failed to download screenshot", {
            previewRunId,
            screenshotPath,
            status: downloadResponse.status,
          });
          continue;
        }

        const imageBytes = await downloadResponse.arrayBuffer();

        // Upload to Convex storage
        const uploadUrl = await ctx.storage.generateUploadUrl();
        const uploadResponse = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": "image/png" },
          body: imageBytes,
        });

        const { storageId } = (await uploadResponse.json()) as { storageId: string };

        uploadedImages.push({
          storageId,
          mimeType: "image/png",
          fileName: screenshotPath.split('/').pop() ?? "screenshot.png",
          commitSha: run.headSha,
        });

        console.log("[preview-jobs] Uploaded screenshot", {
          previewRunId,
          screenshotPath,
          storageId,
        });
      } catch (error) {
        console.warn("[preview-jobs] Failed to process screenshot", {
          previewRunId,
          screenshotPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Step 8: Create screenshot set and trigger GitHub comment
    const screenshotSetId = await ctx.runMutation(
      internal.previewScreenshots.createScreenshotSet,
      {
        previewRunId,
        status: "completed",
        commitSha: run.headSha,
        images: uploadedImages.map(img => ({
          ...img,
          storageId: img.storageId as Id<"_storage">,
        })),
      },
    );

    await ctx.runMutation(internal.previewRuns.updateStatus, {
      previewRunId,
      status: "completed",
      stateReason: "Screenshots uploaded",
      screenshotSetId,
    });

    // Trigger GitHub comment
    await ctx.scheduler.runAfter(
      0,
      internal.previewScreenshots.triggerGithubComment,
      { previewRunId },
    );

    console.log("[preview-jobs] Preview job completed", { previewRunId });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "Unknown error");
    console.error("[preview-jobs] Preview job failed", {
      previewRunId,
      error: message,
    });

    let screenshotSetId: Id<"previewScreenshotSets"> | undefined;
    try {
      screenshotSetId = await ctx.runMutation(
        internal.previewScreenshots.createScreenshotSet,
        {
          previewRunId,
          status: "failed",
          commitSha: run.headSha ?? "unknown",
          error: message,
          images: [],
        },
      );
    } catch (screenshotError) {
      console.error("[preview-jobs] Failed to record failure screenshot set", {
        previewRunId,
        error: screenshotError,
      });
    }

    try {
      await ctx.runMutation(internal.previewRuns.updateStatus, {
        previewRunId,
        status: "failed",
        stateReason: message,
        screenshotSetId,
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
