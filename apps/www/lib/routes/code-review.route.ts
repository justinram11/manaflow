import { api } from "@cmux/convex/api";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Id } from "@cmux/convex/dataModel";
import { randomBytes, createHash } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { getConvex } from "../utils/get-convex";
import { verifyTeamAccess } from "../utils/team-verification";
import { stackServerAppJs } from "../utils/stack";
import { env } from "../utils/www-env";
import {
  startAutomatedPrReview,
  type PrReviewJobContext,
} from "../../src/pr-review";

const CALLBACK_BEARER_PREFIX = "bearer ";
const CODE_REVIEW_STATES = ["pending", "running", "completed", "failed"] as const;

const CodeReviewJobSchema = z.object({
  jobId: z.string(),
  teamId: z.string(),
  repoFullName: z.string(),
  repoUrl: z.string(),
  prNumber: z.number(),
  commitRef: z.string(),
  requestedByUserId: z.string(),
  state: z.enum(CODE_REVIEW_STATES),
  createdAt: z.number(),
  updatedAt: z.number(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  sandboxInstanceId: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorDetail: z.string().nullable(),
  codeReviewOutput: z.record(z.string(), z.any()).nullable(),
});

const StartBodySchema = z
  .object({
    teamSlugOrId: z.string(),
    githubLink: z.string().url(),
    prNumber: z.number().int().positive(),
    commitRef: z.string().optional(),
  })
  .openapi("CodeReviewStartBody");

const StartResponseSchema = z
  .object({
    job: CodeReviewJobSchema,
    deduplicated: z.boolean(),
  })
  .openapi("CodeReviewStartResponse");

const SuccessCallbackSchema = z.object({
  status: z.literal("success"),
  jobId: z.string(),
  sandboxInstanceId: z.string(),
  codeReviewOutput: z.record(z.string(), z.any()),
});

const ErrorCallbackSchema = z.object({
  status: z.literal("error"),
  jobId: z.string(),
  sandboxInstanceId: z.string().optional(),
  errorCode: z.string().optional(),
  errorDetail: z.string().optional(),
});

const CallbackBodySchema = z
  .union([SuccessCallbackSchema, ErrorCallbackSchema])
  .openapi("CodeReviewCallbackBody");

export const codeReviewRouter = new OpenAPIHono();

function hashCallbackToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function getCallbackTokenFromHeaders(authorization?: string): string | null {
  if (!authorization) return null;
  const lower = authorization.toLowerCase();
  if (!lower.startsWith(CALLBACK_BEARER_PREFIX)) return null;
  return authorization.slice(CALLBACK_BEARER_PREFIX.length).trim();
}

function getDeployConvexClient(): ConvexHttpClient {
  const client = new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL);
  client.setAuth(env.CONVEX_DEPLOY_KEY);
  return client;
}

codeReviewRouter.openapi(
  createRoute({
    method: "post",
    path: "/code-review/start",
    tags: ["Code Review"],
    summary: "Start an automated code review for a pull request",
    request: {
      body: {
        content: {
          "application/json": {
            schema: StartBodySchema,
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: StartResponseSchema,
          },
        },
        description: "Job created or reused",
      },
      401: { description: "Unauthorized" },
      500: { description: "Failed to start code review" },
    },
  }),
  async (c) => {
    const user = await stackServerAppJs.getUser({ tokenStore: c.req.raw });
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const { accessToken } = await user.getAuthJson();
    if (!accessToken) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const body = c.req.valid("json");
    const _team = await verifyTeamAccess({
      req: c.req.raw,
      teamSlugOrId: body.teamSlugOrId,
    });

    const convex = getConvex({ accessToken });
    const callbackToken = randomBytes(32).toString("hex");
    const callbackTokenHash = hashCallbackToken(callbackToken);

    const reserveResult = await convex.mutation(api.codeReview.reserveJob, {
      teamSlugOrId: body.teamSlugOrId,
      githubLink: body.githubLink,
      prNumber: body.prNumber,
      commitRef: body.commitRef,
      callbackTokenHash,
    });

    if (!reserveResult.wasCreated) {
      return c.json(
        {
          job: reserveResult.job,
          deduplicated: true,
        },
        200,
      );
    }

    const job = reserveResult.job;
    const callbackUrl = new URL("/api/code-review/callback", c.req.url).toString();

    const runningJob = await convex.mutation(api.codeReview.markJobRunning, {
      jobId: job.jobId,
    });

    const reviewConfig: PrReviewJobContext = {
      jobId: job.jobId,
      teamId: job.teamId,
      repoFullName: job.repoFullName,
      repoUrl: job.repoUrl,
      prNumber: job.prNumber,
      prUrl: body.githubLink,
      commitRef: job.commitRef,
      callback: {
        url: callbackUrl,
        token: callbackToken,
      },
    };

    void startAutomatedPrReview(reviewConfig).catch(async (error) => {
      const message =
        error instanceof Error ? error.message : String(error ?? "Unknown error");
      console.error("[code-review] Background review failed", message);

      const deployConvex = getDeployConvexClient();
      try {
        await deployConvex.mutation(api.codeReview.failJob, {
          jobId: job.jobId as Id<"automatedCodeReviewJobs">,
          errorCode: "pr_review_setup_failed",
          errorDetail: message,
        });
      } catch (failError) {
        const failMessage =
          failError instanceof Error
            ? failError.message
            : String(failError ?? "Unknown failJob error");
        console.error(
          "[code-review] Failed to mark job as failed after background error",
          failMessage,
        );
      }
    });

    return c.json(
      {
        job: runningJob,
        deduplicated: false,
      },
      200,
    );
  },
);

codeReviewRouter.openapi(
  createRoute({
    method: "post",
    path: "/code-review/callback",
    tags: ["Code Review"],
    summary: "Callback endpoint for automated code review runner",
    request: {
      body: {
        content: {
          "application/json": {
            schema: CallbackBodySchema,
          },
        },
        required: true,
      },
    },
    responses: {
      200: { description: "Callback processed" },
      401: { description: "Unauthorized" },
      500: { description: "Failed to process callback" },
    },
  }),
  async (c) => {
    const rawToken = getCallbackTokenFromHeaders(
      c.req.header("authorization"),
    );
    if (!rawToken) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const body = c.req.valid("json");
    const convex = getDeployConvexClient();

    try {
      if (body.status === "success") {
        await convex.mutation(api.codeReview.completeJobFromCallback, {
          jobId: body.jobId as Id<"automatedCodeReviewJobs">,
          callbackToken: rawToken,
          sandboxInstanceId: body.sandboxInstanceId,
          codeReviewOutput: body.codeReviewOutput,
        });
      } else {
        await convex.mutation(api.codeReview.failJobFromCallback, {
          jobId: body.jobId as Id<"automatedCodeReviewJobs">,
          callbackToken: rawToken,
          sandboxInstanceId: body.sandboxInstanceId,
          errorCode: body.errorCode,
          errorDetail: body.errorDetail,
        });
      }
      return c.json({ ok: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? "Unknown error");
      console.error("[code-review.callback] Failed to process callback", message);
      return c.json({ error: message }, 500);
    }
  },
);
