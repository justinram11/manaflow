import { env } from "../_shared/convex-env";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { runPreviewJob } from "./preview_jobs_worker";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function verifyAuth(req: Request): boolean {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return false;

  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer") return false;

  return token === env.CMUX_TASK_RUN_JWT_SECRET;
}

export const dispatchPreviewJob = httpAction(async (ctx, req) => {
  if (!verifyAuth(req)) {
    console.error("[preview-jobs-http] Unauthorized dispatch request");
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: { previewRunId?: string };
  try {
    body = (await req.json()) as { previewRunId?: string };
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (!body.previewRunId) {
    return jsonResponse({ error: "previewRunId is required" }, 400);
  }

  const previewRunId = body.previewRunId as Id<"previewRuns">;
  console.log("[preview-jobs-http] Dispatching preview job", {
    previewRunId,
  });

  try {
    await ctx.runMutation(internal.previewRuns.markDispatched, {
      previewRunId,
    });
  } catch (error) {
    console.error("[preview-jobs-http] Failed to mark run dispatched", {
      previewRunId,
      error,
    });
    return jsonResponse({ error: "Failed to mark run dispatched" }, 500);
  }

  try {
    await runPreviewJob(ctx, previewRunId);
    return jsonResponse({ success: true }, 200);
  } catch (error) {
    console.error("[preview-jobs-http] Preview job execution failed", {
      previewRunId,
      error,
    });
    return jsonResponse(
      {
        error: "Failed to execute preview job",
        message:
          error instanceof Error ? error.message : String(error ?? "Unknown error"),
      },
      500,
    );
  }
});

/**
 * HTTP action for www API to update preview run status
 */
export const updatePreviewStatus = httpAction(async (ctx, req) => {
  if (!verifyAuth(req)) {
    console.error("[preview-jobs-http] Unauthorized request");
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (
    !body ||
    typeof body !== "object" ||
    !("previewRunId" in body) ||
    !("status" in body)
  ) {
    return jsonResponse({ error: "Missing required fields" }, 400);
  }

  const { previewRunId, status, stateReason, screenshotSetId } = body as {
    previewRunId: string;
    status: string;
    stateReason?: string;
    screenshotSetId?: string;
  };

  console.log("[preview-jobs-http] Updating preview run status", {
    previewRunId,
    status,
  });

  // Validate status
  if (!["running", "completed", "failed", "skipped"].includes(status)) {
    return jsonResponse({ error: "Invalid status value" }, 400);
  }

  try {
    await ctx.runMutation(internal.previewRuns.updateStatus, {
      previewRunId: previewRunId as Id<"previewRuns">,
      status: status as "running" | "completed" | "failed" | "skipped",
      stateReason,
      screenshotSetId: screenshotSetId as Id<"previewScreenshotSets"> | undefined,
    });

    return jsonResponse({ success: true });
  } catch (error) {
    console.error("[preview-jobs-http] Failed to update status", {
      previewRunId,
      error,
    });
    return jsonResponse({ error: "Failed to update status" }, 500);
  }
});

/**
 * HTTP action for www API to create screenshot set
 */
export const createScreenshotSet = httpAction(async (ctx, req) => {
  if (!verifyAuth(req)) {
    console.error("[preview-jobs-http] Unauthorized request");
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  if (
    !body ||
    typeof body !== "object" ||
    !("previewRunId" in body) ||
    !("status" in body) ||
    !("commitSha" in body)
  ) {
    return jsonResponse({ error: "Missing required fields" }, 400);
  }

  const { previewRunId, status, commitSha, error, images } = body as {
    previewRunId: string;
    status: string;
    commitSha: string;
    error?: string;
    images: Array<{
      storageId: string;
      mimeType: string;
      fileName?: string;
      commitSha?: string;
      width?: number;
      height?: number;
    }>;
  };

  console.log("[preview-jobs-http] Creating screenshot set", {
    previewRunId,
    status,
    imageCount: images?.length ?? 0,
  });

  // Validate status
  if (!["completed", "failed", "skipped"].includes(status)) {
    return jsonResponse({ error: "Invalid status value" }, 400);
  }

  try {
    const screenshotSetId = await ctx.runMutation(
      internal.previewScreenshots.createScreenshotSet,
      {
        previewRunId: previewRunId as Id<"previewRuns">,
        status: status as "completed" | "failed" | "skipped",
        commitSha,
        error,
        images: (images ?? []).map((img) => ({
          storageId: img.storageId as Id<"_storage">,
          mimeType: img.mimeType,
          fileName: img.fileName,
          commitSha: img.commitSha,
          width: img.width,
          height: img.height,
        })),
      }
    );

    return jsonResponse({ success: true, screenshotSetId });
  } catch (err) {
    console.error("[preview-jobs-http] Failed to create screenshot set", {
      previewRunId,
      error: err,
    });
    return jsonResponse({ error: "Failed to create screenshot set" }, 500);
  }
});
