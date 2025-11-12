import { env } from "../_shared/convex-env";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";

const MORPH_API_BASE_URL = "https://cloud.morph.so/api";

type InstanceHttpService = {
  name: string;
  port: number;
  url: string;
};

type MorphInstance = {
  id: string;
  status: string;
  networking: {
    http_services: InstanceHttpService[];
  };
};

type MorphRequestOptions = {
  apiKey: string;
  path: string;
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
  timeoutMs?: number;
};

type StartInstanceOptions = {
  apiKey: string;
  snapshotId: string;
  metadata?: Record<string, string>;
  ttlSeconds?: number;
  ttlAction?: "stop" | "pause";
  readinessTimeoutMs?: number;
};

async function morphRequest<T>({
  apiKey,
  path,
  method = "GET",
  query,
  body,
  timeoutMs = 600_000,
}: MorphRequestOptions): Promise<T> {
  const url = new URL(`${MORPH_API_BASE_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `[preview-jobs] Morph request failed (${response.status} ${response.statusText}) for ${path}: ${text.slice(0, 512)}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const raw = await response.text();
  if (!raw) {
    return undefined as T;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(
      `[preview-jobs] Failed to parse Morph response for ${path}: ${String(
        error,
      )}`,
    );
  }
}

async function waitForInstanceReady(
  apiKey: string,
  instanceId: string,
  readinessTimeoutMs = 5 * 60 * 1000,
): Promise<MorphInstance> {
  const start = Date.now();
  while (true) {
    const instance = await morphRequest<MorphInstance>({
      apiKey,
      path: `/instance/${instanceId}`,
      method: "GET",
      timeoutMs: 60_000,
    });

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

async function startMorphInstance({
  apiKey,
  snapshotId,
  metadata,
  ttlSeconds,
  ttlAction,
  readinessTimeoutMs,
}: StartInstanceOptions): Promise<MorphInstance> {
  const instance = await morphRequest<MorphInstance>({
    apiKey,
    path: "/instance",
    method: "POST",
    query: {
      snapshot_id: snapshotId,
    },
    body: {
      metadata,
      ttl_seconds: ttlSeconds,
      ttl_action: ttlAction,
    },
    timeoutMs: 120_000,
  });
  return await waitForInstanceReady(apiKey, instance.id, readinessTimeoutMs);
}

async function stopMorphInstance(apiKey: string, instanceId: string) {
  await morphRequest<void>({
    apiKey,
    path: `/instance/${instanceId}`,
    method: "DELETE",
    timeoutMs: 60_000,
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
  let instance: MorphInstance | null = null;

  console.log("[preview-jobs] Launching Morph instance", {
    previewRunId,
    snapshotId,
    repoFullName: run.repoFullName,
    prNumber: run.prNumber,
  });

  await ctx.runMutation(internal.previewRuns.updateStatus, {
    previewRunId,
    status: "running",
    stateReason: "Provisioning Morph workspace",
  });

  try {
    instance = await startMorphInstance({
      apiKey: morphApiKey,
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
      (service) => service.port === 39377,
    );
    if (!workerService) {
      throw new Error("Worker service not found on instance");
    }

    console.log("[preview-jobs] Worker service ready", {
      previewRunId,
      workerUrl: workerService.url,
    });

    const screenshotSetId = await ctx.runMutation(
      internal.previewScreenshots.createScreenshotSet,
      {
        previewRunId,
        status: "completed",
        commitSha: run.headSha,
        images: [],
      },
    );

    await ctx.runMutation(internal.previewRuns.updateStatus, {
      previewRunId,
      status: "completed",
      stateReason: "Preview capture completed (placeholder)",
      screenshotSetId,
    });

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
        await stopMorphInstance(morphApiKey, instance.id);
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
