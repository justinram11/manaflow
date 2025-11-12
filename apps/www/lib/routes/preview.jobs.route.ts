import { waitUntil } from "@vercel/functions";
import { z } from "zod";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { env } from "@/lib/utils/www-env";
import { MorphCloudClient } from "morphcloud";

export const previewJobsRouter = new OpenAPIHono();

const DispatchBody = z
  .object({
    previewRunId: z.string(),
    run: z.record(z.string(), z.unknown()),
    config: z.record(z.string(), z.unknown()),
  })
  .openapi("PreviewJobDispatch");

function isAuthorized(headerValue: string | null): boolean {
  if (!headerValue) {
    return false;
  }
  const [scheme, token] = headerValue.split(" ");
  if (scheme !== "Bearer") {
    return false;
  }
  return token === env.CMUX_TASK_RUN_JWT_SECRET;
}

async function executePreviewJob(
  previewRunId: string,
  run: Record<string, unknown>,
  _config: Record<string, unknown>,
) {
  try {
    console.log("[preview-jobs] Starting preview job", { previewRunId });

    // Extract run details
    const repoFullName = run.repoFullName as string;
    const prNumber = run.prNumber as number;
    const headSha = run.headSha as string;

    // TODO: Get environment from config
    // const environmentId = config.environmentId as string | undefined;

    const snapshotId = "snapshot_kco1jqb6"; // Default snapshot
    // TODO: Look up environment's snapshot ID if environmentId is provided

    // Start Morph instance
    const morphClient = new MorphCloudClient();
    const instance = await morphClient.instances.start({
      snapshotId,
      ttlSeconds: 600, // 10 minutes should be enough for preview
      ttlAction: "stop",
      metadata: {
        app: "cmux-preview",
        previewRunId,
        repo: repoFullName,
        prNumber: String(prNumber),
        headSha,
      },
    });

    console.log("[preview-jobs] Started Morph instance", {
      previewRunId,
      instanceId: instance.id,
    });

    // Note: Can't call internal mutations from Hono route
    // We'll need to call via action or use a webhook
    // For now, just log

    // Get worker service URL
    const workerService = instance.networking.httpServices.find(
      (s) => s.port === 39377,
    );

    if (!workerService) {
      throw new Error("Worker service not found on instance");
    }

    // Suppress unused variable warning
    void headSha;

    // TODO: Execute preview capture script on the instance
    // This will:
    // 1. Clone the repo and checkout the PR
    // 2. Install dependencies
    // 3. Start dev server
    // 4. Capture screenshots via worker service
    // 5. Upload screenshots

    // For now, we'll mark it as completed with a note that full implementation is pending
    // In production, you'd execute the screenshot capture on the instance via the worker service

    // TODO: Update run status via action instead of mutation
    // For now just log
    console.log("[preview-jobs] Would update status to completed");

    // Cleanup instance
    await instance.stop();

    console.log("[preview-jobs] Preview job completed", { previewRunId });
  } catch (error) {
    console.error("[preview-jobs] Preview job failed", {
      previewRunId,
      error,
      message: error instanceof Error ? error.message : String(error),
    });

    // TODO: Update run status via action instead of mutation
    console.error("[preview-jobs] Would mark run as failed");
  }
}

previewJobsRouter.openapi(
  createRoute({
    method: "post" as const,
    path: "/preview/jobs/dispatch",
    tags: ["Preview"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: DispatchBody,
          },
        },
        required: true,
      },
    },
    responses: {
      202: { description: "Job accepted" },
      401: { description: "Unauthorized" },
    },
  }),
  async (c) => {
    if (!isAuthorized(c.req.header("authorization") ?? null)) {
      return c.text("Unauthorized", 401);
    }

    const body = c.req.valid("json");

    // Execute preview job asynchronously
    waitUntil(executePreviewJob(body.previewRunId, body.run, body.config));

    return c.text("accepted", 202);
  },
);
