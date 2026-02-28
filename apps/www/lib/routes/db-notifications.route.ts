import { getUserFromRequest } from "@/lib/utils/auth";
import { getDb } from "@cmux/db";
import {
  getNotificationsByTeamUser,
  getUnreadTaskRuns,
} from "@cmux/db/queries/notifications";
import {
  markNotificationRead,
  markAllNotificationsRead,
  markTaskRunRead,
  markAllTaskRunsReadForTask,
} from "@cmux/db/mutations/notifications";
import { resolveTeamId } from "@cmux/db/queries/teams";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

export const dbNotificationsRouter = new OpenAPIHono();

const ErrorResponse = z
  .object({
    code: z.number(),
    message: z.string(),
  })
  .openapi("DbNotificationsErrorResponse");

const NotificationSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    taskRunId: z.string().nullable().optional(),
    teamId: z.string(),
    userId: z.string(),
    type: z.string(),
    message: z.string().nullable().optional(),
    readAt: z.number().nullable().optional(),
    createdAt: z.number(),
  })
  .openapi("DbNotification");

const UnreadTaskRunSchema = z
  .object({
    id: z.string(),
    taskRunId: z.string(),
    taskId: z.string().nullable().optional(),
    userId: z.string(),
    teamId: z.string(),
  })
  .openapi("DbUnreadTaskRun");

const NotificationsQuery = z
  .object({
    teamSlugOrId: z.string(),
    unreadOnly: z.enum(["true", "false"]).optional(),
  })
  .openapi("DbNotificationsQuery");

const TeamQuery = z
  .object({
    teamSlugOrId: z.string(),
  })
  .openapi("DbNotificationsTeamQuery");

// GET /notifications - List notifications
dbNotificationsRouter.openapi(
  createRoute({
    method: "get",
    path: "/notifications",
    tags: ["DbNotifications"],
    summary: "List notifications",
    request: {
      query: NotificationsQuery,
    },
    responses: {
      200: {
        description: "List of notifications",
        content: {
          "application/json": {
            schema: z.object({
              notifications: z.array(NotificationSchema),
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
    const notifications = getNotificationsByTeamUser(
      db,
      query.teamSlugOrId,
      user.id,
      { unreadOnly: query.unreadOnly === "true" },
    );

    return c.json({ notifications }, 200);
  },
);

// POST /notifications/:id/read - Mark notification read
dbNotificationsRouter.openapi(
  createRoute({
    method: "post",
    path: "/notifications/{id}/read",
    tags: ["DbNotifications"],
    summary: "Mark notification as read",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        description: "Notification marked as read",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean() }),
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
    markNotificationRead(db, id);

    return c.json({ success: true }, 200);
  },
);

// POST /notifications/read-all - Mark all notifications read
dbNotificationsRouter.openapi(
  createRoute({
    method: "post",
    path: "/notifications/read-all",
    tags: ["DbNotifications"],
    summary: "Mark all notifications as read",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ teamSlugOrId: z.string() }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "All notifications marked as read",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean() }),
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
    markAllNotificationsRead(db, teamId, user.id);

    return c.json({ success: true }, 200);
  },
);

// GET /unread-task-runs - Get unread task runs
dbNotificationsRouter.openapi(
  createRoute({
    method: "get",
    path: "/unread-task-runs",
    tags: ["DbNotifications"],
    summary: "Get unread task runs",
    request: {
      query: TeamQuery,
    },
    responses: {
      200: {
        description: "List of unread task runs",
        content: {
          "application/json": {
            schema: z.object({
              unreadTaskRuns: z.array(UnreadTaskRunSchema),
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
    const unreadTaskRuns = getUnreadTaskRuns(db, query.teamSlugOrId, user.id);

    return c.json({ unreadTaskRuns }, 200);
  },
);

// POST /task-runs/:id/mark-read - Mark task run read
dbNotificationsRouter.openapi(
  createRoute({
    method: "post",
    path: "/task-runs/{id}/mark-read",
    tags: ["DbNotifications"],
    summary: "Mark task run as read",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        description: "Task run marked as read",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean() }),
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
    markTaskRunRead(db, id, user.id);

    return c.json({ success: true }, 200);
  },
);

// POST /tasks/:taskId/mark-all-read - Mark all runs for task read
dbNotificationsRouter.openapi(
  createRoute({
    method: "post",
    path: "/tasks/{taskId}/mark-all-read",
    tags: ["DbNotifications"],
    summary: "Mark all task runs for a task as read",
    request: {
      params: z.object({ taskId: z.string() }),
    },
    responses: {
      200: {
        description: "All task runs marked as read",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean() }),
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

    const { taskId } = c.req.valid("param");
    const db = getDb();
    markAllTaskRunsReadForTask(db, taskId, user.id);

    return c.json({ success: true }, 200);
  },
);
