import { getUserFromRequest } from "@/lib/utils/auth";
import { getDb } from "@cmux/db";
import {
  getTaskComments,
  getCommentsByUrl,
  getCommentById,
  getCommentReplies,
} from "@cmux/db/queries/comments";
import {
  createTaskComment,
  createComment,
  updateComment,
  createCommentReply,
} from "@cmux/db/mutations/comments";
import { resolveTeamId } from "@cmux/db/queries/teams";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

export const dbCommentsRouter = new OpenAPIHono();

const ErrorResponse = z
  .object({
    code: z.number(),
    message: z.string(),
  })
  .openapi("DbCommentsErrorResponse");

const TaskCommentSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    content: z.string(),
    userId: z.string(),
    teamId: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .openapi("DbTaskComment");

const CommentSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    page: z.string(),
    pageTitle: z.string(),
    nodeId: z.string(),
    x: z.number(),
    y: z.number(),
    content: z.string(),
    resolved: z.boolean().nullable().optional(),
    archived: z.boolean().nullable().optional(),
    userId: z.string(),
    teamId: z.string(),
    profileImageUrl: z.string().nullable().optional(),
    userAgent: z.string(),
    screenWidth: z.number(),
    screenHeight: z.number(),
    devicePixelRatio: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .openapi("DbComment");

const CommentReplySchema = z
  .object({
    id: z.string(),
    commentId: z.string(),
    userId: z.string(),
    teamId: z.string(),
    content: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .openapi("DbCommentReply");

const CreateTaskCommentBody = z
  .object({
    teamSlugOrId: z.string(),
    taskId: z.string(),
    content: z.string(),
  })
  .openapi("DbCreateTaskCommentBody");

const CreateCommentBody = z
  .object({
    teamSlugOrId: z.string(),
    url: z.string(),
    page: z.string(),
    pageTitle: z.string(),
    nodeId: z.string(),
    x: z.number(),
    y: z.number(),
    content: z.string(),
    profileImageUrl: z.string().optional(),
    userAgent: z.string(),
    screenWidth: z.number(),
    screenHeight: z.number(),
    devicePixelRatio: z.number(),
  })
  .openapi("DbCreateCommentBody");

const UpdateCommentBody = z
  .object({
    content: z.string().optional(),
    resolved: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .openapi("DbUpdateCommentBody");

const CreateReplyBody = z
  .object({
    teamSlugOrId: z.string(),
    content: z.string(),
  })
  .openapi("DbCreateReplyBody");

// GET /task-comments - List task comments
dbCommentsRouter.openapi(
  createRoute({
    method: "get",
    path: "/task-comments",
    tags: ["DbComments"],
    summary: "List task comments",
    request: {
      query: z.object({ taskId: z.string() }),
    },
    responses: {
      200: {
        description: "List of task comments",
        content: {
          "application/json": {
            schema: z.object({
              comments: z.array(TaskCommentSchema),
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
    const comments = getTaskComments(db, query.taskId);

    return c.json({ comments }, 200);
  },
);

// POST /task-comments - Create task comment
dbCommentsRouter.openapi(
  createRoute({
    method: "post",
    path: "/task-comments",
    tags: ["DbComments"],
    summary: "Create a task comment",
    request: {
      body: {
        content: {
          "application/json": {
            schema: CreateTaskCommentBody,
          },
        },
        required: true,
      },
    },
    responses: {
      201: {
        description: "Task comment created",
        content: {
          "application/json": {
            schema: z.object({ id: z.string() }),
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

    const id = createTaskComment(db, {
      taskId: body.taskId,
      content: body.content,
      userId: user.id,
      teamId,
    });

    return c.json({ id }, 201);
  },
);

// GET /comments - List comments by URL
dbCommentsRouter.openapi(
  createRoute({
    method: "get",
    path: "/comments",
    tags: ["DbComments"],
    summary: "List comments by URL",
    request: {
      query: z.object({ url: z.string() }),
    },
    responses: {
      200: {
        description: "List of comments",
        content: {
          "application/json": {
            schema: z.object({
              comments: z.array(CommentSchema),
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
    const comments = getCommentsByUrl(db, query.url);

    return c.json({ comments }, 200);
  },
);

// GET /comments/:id - Get comment by ID
dbCommentsRouter.openapi(
  createRoute({
    method: "get",
    path: "/comments/{id}",
    tags: ["DbComments"],
    summary: "Get comment by ID",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        description: "Comment details",
        content: {
          "application/json": {
            schema: CommentSchema.nullable(),
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
    const comment = getCommentById(db, id);

    return c.json(comment ?? null, 200);
  },
);

// POST /comments - Create comment
dbCommentsRouter.openapi(
  createRoute({
    method: "post",
    path: "/comments",
    tags: ["DbComments"],
    summary: "Create a comment",
    request: {
      body: {
        content: {
          "application/json": {
            schema: CreateCommentBody,
          },
        },
        required: true,
      },
    },
    responses: {
      201: {
        description: "Comment created",
        content: {
          "application/json": {
            schema: z.object({ id: z.string() }),
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

    const id = createComment(db, {
      url: body.url,
      page: body.page,
      pageTitle: body.pageTitle,
      nodeId: body.nodeId,
      x: body.x,
      y: body.y,
      content: body.content,
      userId: user.id,
      teamId,
      profileImageUrl: body.profileImageUrl,
      userAgent: body.userAgent,
      screenWidth: body.screenWidth,
      screenHeight: body.screenHeight,
      devicePixelRatio: body.devicePixelRatio,
    });

    return c.json({ id }, 201);
  },
);

// PATCH /comments/:id - Update comment
dbCommentsRouter.openapi(
  createRoute({
    method: "patch",
    path: "/comments/{id}",
    tags: ["DbComments"],
    summary: "Update a comment",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: UpdateCommentBody,
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Comment updated",
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
    const body = c.req.valid("json");
    const db = getDb();

    updateComment(db, id, body);

    return c.json({ success: true }, 200);
  },
);

// GET /comments/:id/replies - Get replies
dbCommentsRouter.openapi(
  createRoute({
    method: "get",
    path: "/comments/{id}/replies",
    tags: ["DbComments"],
    summary: "Get comment replies",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        description: "List of replies",
        content: {
          "application/json": {
            schema: z.object({
              replies: z.array(CommentReplySchema),
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
    const replies = getCommentReplies(db, id);

    return c.json({ replies }, 200);
  },
);

// POST /comments/:id/replies - Create reply
dbCommentsRouter.openapi(
  createRoute({
    method: "post",
    path: "/comments/{id}/replies",
    tags: ["DbComments"],
    summary: "Create a comment reply",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: CreateReplyBody,
          },
        },
        required: true,
      },
    },
    responses: {
      201: {
        description: "Reply created",
        content: {
          "application/json": {
            schema: z.object({ id: z.string() }),
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

    const { id: commentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = getDb();
    const teamId = resolveTeamId(db, body.teamSlugOrId);

    const id = createCommentReply(db, {
      commentId,
      content: body.content,
      userId: user.id,
      teamId,
    });

    return c.json({ id }, 201);
  },
);
