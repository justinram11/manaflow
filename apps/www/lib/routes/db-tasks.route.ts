import { getUserFromRequest } from "@/lib/utils/auth";
import { getDb } from "@cmux/db";
import {
  getTaskById,
  getTasksByTeamUser,
  getTasksWithNotificationOrder,
  getPinnedTasks,
  getLinkedLocalWorkspace,
  getTaskVersions,
} from "@cmux/db/queries/tasks";
import {
  createTask,
  updateTask,
  deleteTask,
  archiveTask,
  unarchiveTask,
  pinTask,
  unpinTask,
  setTaskCompleted,
  updateTaskMergeStatus,
  updateTaskWorktreePath,
  setPullRequestTitle,
  setPullRequestDescription,
} from "@cmux/db/mutations/tasks";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

export const dbTasksRouter = new OpenAPIHono();

const ErrorResponse = z
  .object({
    code: z.number(),
    message: z.string(),
  })
  .openapi("DbTasksErrorResponse");

const SuccessResponse = z
  .object({
    success: z.boolean(),
  })
  .openapi("DbTasksSuccessResponse");

const TaskSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    isCompleted: z.boolean().nullable().optional(),
    isArchived: z.boolean().nullable().optional(),
    pinned: z.boolean().nullable().optional(),
    isPreview: z.boolean().nullable().optional(),
    isLocalWorkspace: z.boolean().nullable().optional(),
    isCloudWorkspace: z.boolean().nullable().optional(),
    linkedFromCloudTaskRunId: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    pullRequestTitle: z.string().nullable().optional(),
    pullRequestDescription: z.string().nullable().optional(),
    projectFullName: z.string().nullable().optional(),
    baseBranch: z.string().nullable().optional(),
    worktreePath: z.string().nullable().optional(),
    generatedBranchName: z.string().nullable().optional(),
    createdAt: z.number().nullable().optional(),
    updatedAt: z.number().nullable().optional(),
    lastActivityAt: z.number().nullable().optional(),
    userId: z.string(),
    teamId: z.string(),
    environmentId: z.string().nullable().optional(),
    mergeStatus: z.string().nullable().optional(),
    hasUnread: z.boolean().optional(),
  })
  .openapi("DbTask");

const TaskListResponse = z
  .object({
    tasks: z.array(TaskSchema),
  })
  .openapi("DbTaskListResponse");

const TaskListQuery = z
  .object({
    teamSlugOrId: z.string(),
    archived: z.enum(["true", "false"]).optional(),
    excludeLocalWorkspaces: z.enum(["true", "false"]).optional(),
    projectFullName: z.string().optional(),
  })
  .openapi("DbTaskListQuery");

const PinnedTasksQuery = z
  .object({
    teamSlugOrId: z.string(),
    excludeLocalWorkspaces: z.enum(["true", "false"]).optional(),
  })
  .openapi("DbPinnedTasksQuery");

const TaskByIdQuery = z
  .object({
    teamSlugOrId: z.string(),
  })
  .openapi("DbTaskByIdQuery");

const CreateTaskBody = z
  .object({
    teamSlugOrId: z.string(),
    text: z.string(),
    description: z.string().optional(),
    projectFullName: z.string().optional(),
    baseBranch: z.string().optional(),
    worktreePath: z.string().optional(),
    environmentId: z.string().optional(),
    isCloudWorkspace: z.boolean().optional(),
    selectedAgents: z.array(z.string()).optional(),
  })
  .openapi("DbCreateTaskBody");

const CreateTaskResponse = z
  .object({
    taskId: z.string(),
    taskRunIds: z.array(z.string()).optional(),
  })
  .openapi("DbCreateTaskResponse");

const UpdateTaskBody = z
  .object({
    teamSlugOrId: z.string(),
    text: z.string(),
  })
  .openapi("DbUpdateTaskBody");

const LinkedLocalWorkspaceQuery = z
  .object({
    teamSlugOrId: z.string(),
    cloudTaskRunId: z.string(),
  })
  .openapi("DbLinkedLocalWorkspaceQuery");

const TeamSlugOrIdBody = z
  .object({
    teamSlugOrId: z.string(),
  })
  .openapi("DbTeamSlugOrIdBody");

// GET /tasks - List tasks for team
dbTasksRouter.openapi(
  createRoute({
    method: "get",
    path: "/tasks",
    tags: ["DbTasks"],
    summary: "List tasks for team",
    request: {
      query: TaskListQuery,
    },
    responses: {
      200: {
        description: "List of tasks",
        content: {
          "application/json": {
            schema: TaskListResponse,
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
    const tasks = getTasksByTeamUser(db, {
      teamSlugOrId: query.teamSlugOrId,
      userId: user.id,
      archived: query.archived === "true",
      excludeLocalWorkspaces: query.excludeLocalWorkspaces === "true",
      projectFullName: query.projectFullName,
    });

    return c.json({ tasks }, 200);
  },
);

// GET /tasks/notification-order - Tasks sorted by lastActivityAt
dbTasksRouter.openapi(
  createRoute({
    method: "get",
    path: "/tasks/notification-order",
    tags: ["DbTasks"],
    summary: "List tasks sorted by last activity",
    request: {
      query: TaskListQuery,
    },
    responses: {
      200: {
        description: "List of tasks sorted by notification order",
        content: {
          "application/json": {
            schema: TaskListResponse,
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
    const tasks = getTasksWithNotificationOrder(db, {
      teamSlugOrId: query.teamSlugOrId,
      userId: user.id,
      archived: query.archived === "true",
      excludeLocalWorkspaces: query.excludeLocalWorkspaces === "true",
      projectFullName: query.projectFullName,
    });

    return c.json({ tasks }, 200);
  },
);

// GET /tasks/pinned - Pinned tasks
dbTasksRouter.openapi(
  createRoute({
    method: "get",
    path: "/tasks/pinned",
    tags: ["DbTasks"],
    summary: "List pinned tasks",
    request: {
      query: PinnedTasksQuery,
    },
    responses: {
      200: {
        description: "List of pinned tasks",
        content: {
          "application/json": {
            schema: TaskListResponse,
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
    const tasks = getPinnedTasks(db, {
      teamSlugOrId: query.teamSlugOrId,
      userId: user.id,
      excludeLocalWorkspaces: query.excludeLocalWorkspaces === "true",
    });

    return c.json({ tasks }, 200);
  },
);

// GET /tasks/linked-local-workspace - Get linked local workspace
dbTasksRouter.openapi(
  createRoute({
    method: "get",
    path: "/tasks/linked-local-workspace",
    tags: ["DbTasks"],
    summary: "Get linked local workspace",
    request: {
      query: LinkedLocalWorkspaceQuery,
    },
    responses: {
      200: {
        description: "Linked local workspace",
        content: {
          "application/json": {
            schema: z.object({
              task: TaskSchema,
              taskRun: z.record(z.string(), z.any()),
            }).nullable(),
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
    const result = getLinkedLocalWorkspace(db, {
      teamSlugOrId: query.teamSlugOrId,
      userId: user.id,
      cloudTaskRunId: query.cloudTaskRunId,
    });

    return c.json(result, 200);
  },
);

// GET /tasks/:id - Get task by ID
dbTasksRouter.openapi(
  createRoute({
    method: "get",
    path: "/tasks/{id}",
    tags: ["DbTasks"],
    summary: "Get task by ID",
    request: {
      params: z.object({ id: z.string() }),
      query: TaskByIdQuery,
    },
    responses: {
      200: {
        description: "Task details",
        content: {
          "application/json": {
            schema: TaskSchema.nullable(),
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
    const query = c.req.valid("query");
    const db = getDb();
    const task = getTaskById(db, query.teamSlugOrId, id);

    return c.json(task, 200);
  },
);

// GET /tasks/:id/versions - Get task versions
dbTasksRouter.openapi(
  createRoute({
    method: "get",
    path: "/tasks/{id}/versions",
    tags: ["DbTasks"],
    summary: "Get task versions",
    request: {
      params: z.object({ id: z.string() }),
      query: TaskByIdQuery,
    },
    responses: {
      200: {
        description: "Task versions",
        content: {
          "application/json": {
            schema: z.object({
              versions: z.array(z.record(z.string(), z.any())),
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
    const query = c.req.valid("query");
    const db = getDb();
    const versions = getTaskVersions(db, query.teamSlugOrId, id);

    return c.json({ versions }, 200);
  },
);

// POST /tasks - Create task
dbTasksRouter.openapi(
  createRoute({
    method: "post",
    path: "/tasks",
    tags: ["DbTasks"],
    summary: "Create a new task",
    request: {
      body: {
        content: {
          "application/json": {
            schema: CreateTaskBody,
          },
        },
        required: true,
      },
    },
    responses: {
      201: {
        description: "Task created",
        content: {
          "application/json": {
            schema: CreateTaskResponse,
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
    const result = createTask(db, {
      teamSlugOrId: body.teamSlugOrId,
      userId: user.id,
      text: body.text,
      description: body.description,
      projectFullName: body.projectFullName,
      baseBranch: body.baseBranch,
      worktreePath: body.worktreePath,
      environmentId: body.environmentId,
      isCloudWorkspace: body.isCloudWorkspace,
      selectedAgents: body.selectedAgents,
    });

    return c.json(result, 201);
  },
);

// PATCH /tasks/:id - Update task text
dbTasksRouter.openapi(
  createRoute({
    method: "patch",
    path: "/tasks/{id}",
    tags: ["DbTasks"],
    summary: "Update task text",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: UpdateTaskBody,
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Task updated",
        content: {
          "application/json": { schema: SuccessResponse },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: {
        description: "Task not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = getDb();

    try {
      updateTask(db, {
        teamSlugOrId: body.teamSlugOrId,
        userId: user.id,
        id,
        text: body.text,
      });
      return c.json({ success: true }, 200);
    } catch (error) {
      console.error("Failed to update task", error);
      return c.json({ code: 404, message: "Task not found or unauthorized" }, 404);
    }
  },
);

// DELETE /tasks/:id - Delete task
dbTasksRouter.openapi(
  createRoute({
    method: "delete",
    path: "/tasks/{id}",
    tags: ["DbTasks"],
    summary: "Delete task",
    request: {
      params: z.object({ id: z.string() }),
      query: TaskByIdQuery,
    },
    responses: {
      200: {
        description: "Task deleted",
        content: {
          "application/json": { schema: SuccessResponse },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: {
        description: "Task not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const { id } = c.req.valid("param");
    const query = c.req.valid("query");
    const db = getDb();

    try {
      deleteTask(db, {
        teamSlugOrId: query.teamSlugOrId,
        userId: user.id,
        id,
      });
      return c.json({ success: true }, 200);
    } catch (error) {
      console.error("Failed to delete task", error);
      return c.json({ code: 404, message: "Task not found or unauthorized" }, 404);
    }
  },
);

// POST /tasks/:id/archive - Archive task
dbTasksRouter.openapi(
  createRoute({
    method: "post",
    path: "/tasks/{id}/archive",
    tags: ["DbTasks"],
    summary: "Archive task",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": { schema: TeamSlugOrIdBody },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Task archived",
        content: {
          "application/json": { schema: SuccessResponse },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: {
        description: "Task not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = getDb();

    try {
      archiveTask(db, {
        teamSlugOrId: body.teamSlugOrId,
        userId: user.id,
        id,
      });
      return c.json({ success: true }, 200);
    } catch (error) {
      console.error("Failed to archive task", error);
      return c.json({ code: 404, message: "Task not found or unauthorized" }, 404);
    }
  },
);

// POST /tasks/:id/unarchive - Unarchive task
dbTasksRouter.openapi(
  createRoute({
    method: "post",
    path: "/tasks/{id}/unarchive",
    tags: ["DbTasks"],
    summary: "Unarchive task",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": { schema: TeamSlugOrIdBody },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Task unarchived",
        content: {
          "application/json": { schema: SuccessResponse },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: {
        description: "Task not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = getDb();

    try {
      unarchiveTask(db, {
        teamSlugOrId: body.teamSlugOrId,
        userId: user.id,
        id,
      });
      return c.json({ success: true }, 200);
    } catch (error) {
      console.error("Failed to unarchive task", error);
      return c.json({ code: 404, message: "Task not found or unauthorized" }, 404);
    }
  },
);

// POST /tasks/:id/pin - Pin task
dbTasksRouter.openapi(
  createRoute({
    method: "post",
    path: "/tasks/{id}/pin",
    tags: ["DbTasks"],
    summary: "Pin task",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": { schema: TeamSlugOrIdBody },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Task pinned",
        content: {
          "application/json": { schema: SuccessResponse },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: {
        description: "Task not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = getDb();

    try {
      pinTask(db, {
        teamSlugOrId: body.teamSlugOrId,
        userId: user.id,
        id,
      });
      return c.json({ success: true }, 200);
    } catch (error) {
      console.error("Failed to pin task", error);
      return c.json({ code: 404, message: "Task not found or unauthorized" }, 404);
    }
  },
);

// POST /tasks/:id/unpin - Unpin task
dbTasksRouter.openapi(
  createRoute({
    method: "post",
    path: "/tasks/{id}/unpin",
    tags: ["DbTasks"],
    summary: "Unpin task",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": { schema: TeamSlugOrIdBody },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Task unpinned",
        content: {
          "application/json": { schema: SuccessResponse },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: {
        description: "Task not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = getDb();

    try {
      unpinTask(db, {
        teamSlugOrId: body.teamSlugOrId,
        userId: user.id,
        id,
      });
      return c.json({ success: true }, 200);
    } catch (error) {
      console.error("Failed to unpin task", error);
      return c.json({ code: 404, message: "Task not found or unauthorized" }, 404);
    }
  },
);

// PATCH /tasks/:id/completed - Set completed status
dbTasksRouter.openapi(
  createRoute({
    method: "patch",
    path: "/tasks/{id}/completed",
    tags: ["DbTasks"],
    summary: "Set task completed status",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              teamSlugOrId: z.string(),
              isCompleted: z.boolean(),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Task completed status updated",
        content: {
          "application/json": { schema: SuccessResponse },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: {
        description: "Task not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = getDb();

    try {
      setTaskCompleted(db, {
        teamSlugOrId: body.teamSlugOrId,
        userId: user.id,
        id,
        isCompleted: body.isCompleted,
      });
      return c.json({ success: true }, 200);
    } catch (error) {
      console.error("Failed to update task completed status", error);
      return c.json({ code: 404, message: "Task not found" }, 404);
    }
  },
);

// PATCH /tasks/:id/merge-status - Update merge status
dbTasksRouter.openapi(
  createRoute({
    method: "patch",
    path: "/tasks/{id}/merge-status",
    tags: ["DbTasks"],
    summary: "Update task merge status",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              teamSlugOrId: z.string(),
              mergeStatus: z.string(),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Merge status updated",
        content: {
          "application/json": { schema: SuccessResponse },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: {
        description: "Task not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = getDb();

    try {
      updateTaskMergeStatus(db, {
        teamSlugOrId: body.teamSlugOrId,
        userId: user.id,
        id,
        mergeStatus: body.mergeStatus,
      });
      return c.json({ success: true }, 200);
    } catch (error) {
      console.error("Failed to update merge status", error);
      return c.json({ code: 404, message: "Task not found" }, 404);
    }
  },
);

// PATCH /tasks/:id/worktree-path - Update worktree path
dbTasksRouter.openapi(
  createRoute({
    method: "patch",
    path: "/tasks/{id}/worktree-path",
    tags: ["DbTasks"],
    summary: "Update task worktree path",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              teamSlugOrId: z.string(),
              worktreePath: z.string(),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Worktree path updated",
        content: {
          "application/json": { schema: SuccessResponse },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: {
        description: "Task not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = getDb();

    try {
      updateTaskWorktreePath(db, {
        teamSlugOrId: body.teamSlugOrId,
        userId: user.id,
        id,
        worktreePath: body.worktreePath,
      });
      return c.json({ success: true }, 200);
    } catch (error) {
      console.error("Failed to update worktree path", error);
      return c.json({ code: 404, message: "Task not found or unauthorized" }, 404);
    }
  },
);

// PATCH /tasks/:id/pull-request-title - Set PR title
dbTasksRouter.openapi(
  createRoute({
    method: "patch",
    path: "/tasks/{id}/pull-request-title",
    tags: ["DbTasks"],
    summary: "Set task pull request title",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              teamSlugOrId: z.string(),
              pullRequestTitle: z.string().optional(),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "PR title updated",
        content: {
          "application/json": { schema: SuccessResponse },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: {
        description: "Task not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = getDb();

    try {
      setPullRequestTitle(db, {
        teamSlugOrId: body.teamSlugOrId,
        userId: user.id,
        id,
        pullRequestTitle: body.pullRequestTitle,
      });
      return c.json({ success: true }, 200);
    } catch (error) {
      console.error("Failed to set PR title", error);
      return c.json({ code: 404, message: "Task not found or unauthorized" }, 404);
    }
  },
);

// PATCH /tasks/:id/pull-request-description - Set PR description
dbTasksRouter.openapi(
  createRoute({
    method: "patch",
    path: "/tasks/{id}/pull-request-description",
    tags: ["DbTasks"],
    summary: "Set task pull request description",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              teamSlugOrId: z.string(),
              pullRequestDescription: z.string().optional(),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "PR description updated",
        content: {
          "application/json": { schema: SuccessResponse },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: {
        description: "Task not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = getDb();

    try {
      setPullRequestDescription(db, {
        teamSlugOrId: body.teamSlugOrId,
        userId: user.id,
        id,
        pullRequestDescription: body.pullRequestDescription,
      });
      return c.json({ success: true }, 200);
    } catch (error) {
      console.error("Failed to set PR description", error);
      return c.json({ code: 404, message: "Task not found or unauthorized" }, 404);
    }
  },
);
