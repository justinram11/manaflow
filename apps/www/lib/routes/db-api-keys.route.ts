import { getUserFromRequest } from "@/lib/utils/auth";
import { getDb } from "@cmux/db";
import { getApiKeysByTeamUser } from "@cmux/db/queries/settings";
import { upsertApiKey, deleteApiKey } from "@cmux/db/mutations/settings";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

export const dbApiKeysRouter = new OpenAPIHono();

const ErrorResponse = z
  .object({
    code: z.number(),
    message: z.string(),
  })
  .openapi("DbApiKeysErrorResponse");

const ApiKeySchema = z
  .object({
    id: z.string(),
    envVar: z.string(),
    value: z.string(),
    displayName: z.string(),
    description: z.string().nullable().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    userId: z.string(),
    teamId: z.string(),
  })
  .openapi("DbApiKey");

const ApiKeysQuery = z
  .object({
    teamSlugOrId: z.string(),
  })
  .openapi("DbApiKeysQuery");

const UpsertApiKeyBody = z
  .object({
    teamSlugOrId: z.string(),
    value: z.string(),
    displayName: z.string(),
    description: z.string().optional(),
  })
  .openapi("DbUpsertApiKeyBody");

const DeleteApiKeyQuery = z
  .object({
    teamSlugOrId: z.string(),
  })
  .openapi("DbDeleteApiKeyQuery");

// GET /api-keys - List API keys
dbApiKeysRouter.openapi(
  createRoute({
    method: "get",
    path: "/api-keys",
    tags: ["DbApiKeys"],
    summary: "List API keys",
    request: {
      query: ApiKeysQuery,
    },
    responses: {
      200: {
        description: "List of API keys",
        content: {
          "application/json": {
            schema: z.object({
              apiKeys: z.array(ApiKeySchema),
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
    const apiKeys = getApiKeysByTeamUser(db, query.teamSlugOrId, user.id);

    return c.json({ apiKeys }, 200);
  },
);

// PUT /api-keys/:envVar - Upsert API key
dbApiKeysRouter.openapi(
  createRoute({
    method: "put",
    path: "/api-keys/{envVar}",
    tags: ["DbApiKeys"],
    summary: "Create or update an API key",
    request: {
      params: z.object({ envVar: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: UpsertApiKeyBody,
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "API key upserted",
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

    const { envVar } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = getDb();

    const id = upsertApiKey(db, {
      teamSlugOrId: body.teamSlugOrId,
      userId: user.id,
      envVar,
      value: body.value,
      displayName: body.displayName,
      description: body.description,
    });

    return c.json({ id }, 200);
  },
);

// DELETE /api-keys/:envVar - Delete API key
dbApiKeysRouter.openapi(
  createRoute({
    method: "delete",
    path: "/api-keys/{envVar}",
    tags: ["DbApiKeys"],
    summary: "Delete an API key",
    request: {
      params: z.object({ envVar: z.string() }),
      query: DeleteApiKeyQuery,
    },
    responses: {
      200: {
        description: "API key deleted",
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
      404: {
        description: "API key not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const { envVar } = c.req.valid("param");
    const query = c.req.valid("query");
    const db = getDb();

    try {
      deleteApiKey(db, {
        teamSlugOrId: query.teamSlugOrId,
        userId: user.id,
        envVar,
      });
      return c.json({ success: true }, 200);
    } catch (error) {
      console.error("Failed to delete API key", error);
      return c.json({ code: 404, message: "API key not found" }, 404);
    }
  },
);
