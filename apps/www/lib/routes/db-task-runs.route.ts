import { getUserFromRequest } from "@/lib/utils/auth";
import { getDb } from "@cmux/db";
import {
  getTaskRunById,
  getTaskRunsByTask,
  getTaskRunByContainerName,
  getTaskRunLogChunksByRun,
  getScreenshotSetsByRun,
} from "@cmux/db/queries/task-runs";
import { createTaskRun } from "@cmux/db/mutations/task-runs";
import { resolveTeamId } from "@cmux/db/queries/teams";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

export const dbTaskRunsRouter = new OpenAPIHono();

const ErrorResponse = z
  .object({
    code: z.number(),
    message: z.string(),
  })
  .openapi("DbTaskRunsErrorResponse");

const TaskRunListQuery = z
  .object({
    taskId: z.string(),
    includeArchived: z.enum(["true", "false"]).optional(),
  })
  .openapi("DbTaskRunListQuery");

const ContainerNameQuery = z
  .object({
    containerName: z.string(),
  })
  .openapi("DbContainerNameQuery");

const CreateTaskRunBody = z
  .object({
    teamSlugOrId: z.string(),
    taskId: z.string(),
    prompt: z.string(),
    agentName: z.string().optional(),
    status: z.string().optional(),
    environmentId: z.string().optional(),
    isCloudWorkspace: z.boolean().optional(),
    isLocalWorkspace: z.boolean().optional(),
    isPreviewJob: z.boolean().optional(),
    parentRunId: z.string().optional(),
  })
  .openapi("DbCreateTaskRunBody");

// GET /task-runs - List task runs by task
dbTaskRunsRouter.openapi(
  createRoute({
    method: "get",
    path: "/task-runs",
    tags: ["DbTaskRuns"],
    summary: "List task runs by task",
    request: {
      query: TaskRunListQuery,
    },
    responses: {
      200: {
        description: "List of task runs",
        content: {
          "application/json": {
            schema: z.object({
              taskRuns: z.array(z.record(z.string(), z.any())),
            }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const query = c.req.valid("query");
    const db = getDb();
    const taskRuns = getTaskRunsByTask(db, {
      taskId: query.taskId,
      includeArchived: query.includeArchived === "true",
    });

    return c.json({ taskRuns }, 200);
  },
);

// GET /task-runs/by-container-name - Get task run by container name
dbTaskRunsRouter.openapi(
  createRoute({
    method: "get",
    path: "/task-runs/by-container-name",
    tags: ["DbTaskRuns"],
    summary: "Get task run by container name",
    request: {
      query: ContainerNameQuery,
    },
    responses: {
      200: {
        description: "Task run",
        content: {
          "application/json": {
            schema: z.record(z.string(), z.any()).nullable(),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const query = c.req.valid("query");
    const db = getDb();
    const taskRun = getTaskRunByContainerName(db, query.containerName);

    return c.json(taskRun, 200);
  },
);

// GET /task-runs/:id - Get task run by ID
dbTaskRunsRouter.openapi(
  createRoute({
    method: "get",
    path: "/task-runs/{id}",
    tags: ["DbTaskRuns"],
    summary: "Get task run by ID",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        description: "Task run details",
        content: {
          "application/json": {
            schema: z.record(z.string(), z.any()).nullable(),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const { id } = c.req.valid("param");
    const db = getDb();
    const taskRun = getTaskRunById(db, id);

    return c.json(taskRun ?? null, 200);
  },
);

// GET /task-runs/:id/log-chunks - Get log chunks
dbTaskRunsRouter.openapi(
  createRoute({
    method: "get",
    path: "/task-runs/{id}/log-chunks",
    tags: ["DbTaskRuns"],
    summary: "Get task run log chunks",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        description: "Log chunks",
        content: {
          "application/json": {
            schema: z.object({
              logChunks: z.array(
                z.object({
                  id: z.string(),
                  taskRunId: z.string(),
                  content: z.string(),
                  userId: z.string(),
                  teamId: z.string(),
                }),
              ),
            }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const { id } = c.req.valid("param");
    const db = getDb();
    const logChunks = getTaskRunLogChunksByRun(db, id);

    return c.json({ logChunks }, 200);
  },
);

// GET /task-runs/:id/screenshot-sets - Get screenshot sets by run
dbTaskRunsRouter.openapi(
  createRoute({
    method: "get",
    path: "/task-runs/{id}/screenshot-sets",
    tags: ["DbTaskRuns"],
    summary: "Get screenshot sets by run",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        description: "Screenshot sets",
        content: {
          "application/json": {
            schema: z.object({
              screenshotSets: z.array(z.record(z.string(), z.any())),
            }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const { id } = c.req.valid("param");
    const db = getDb();
    const screenshotSets = getScreenshotSetsByRun(db, id);

    return c.json({ screenshotSets }, 200);
  },
);

// POST /task-runs - Create task run
dbTaskRunsRouter.openapi(
  createRoute({
    method: "post",
    path: "/task-runs",
    tags: ["DbTaskRuns"],
    summary: "Create a new task run",
    request: {
      body: {
        content: {
          "application/json": {
            schema: CreateTaskRunBody,
          },
        },
        required: true,
      },
    },
    responses: {
      201: {
        description: "Task run created",
        content: {
          "application/json": {
            schema: z.object({ taskRunId: z.string() }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const body = c.req.valid("json");
    const db = getDb();
    const teamId = resolveTeamId(db, body.teamSlugOrId);

    const taskRunId = createTaskRun(db, {
      taskId: body.taskId,
      prompt: body.prompt,
      agentName: body.agentName,
      status: body.status,
      userId: user.id,
      teamId,
      environmentId: body.environmentId,
      isCloudWorkspace: body.isCloudWorkspace,
      isLocalWorkspace: body.isLocalWorkspace,
      isPreviewJob: body.isPreviewJob,
      parentRunId: body.parentRunId,
    });

    return c.json({ taskRunId }, 201);
  },
);
