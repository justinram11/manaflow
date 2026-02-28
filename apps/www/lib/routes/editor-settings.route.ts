import { getUserFromRequest } from "@/lib/utils/auth";
import { verifyTeamAccess } from "@/lib/utils/team-verification";
import { getDb } from "@cmux/db";
import { getUserEditorSettings } from "@cmux/db/queries/settings";
import {
  upsertUserEditorSettings,
  clearUserEditorSettings,
} from "@cmux/db/mutations/settings";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

export const editorSettingsRouter = new OpenAPIHono();

const SnippetSchema = z.object({
  name: z.string(),
  content: z.string(),
});

const EditorSettingsResponse = z
  .object({
    settingsJson: z.string().optional(),
    keybindingsJson: z.string().optional(),
    snippets: z.array(SnippetSchema).optional(),
    extensions: z.string().optional(),
    updatedAt: z.number().optional(),
  })
  .openapi("EditorSettingsResponse");

const EditorSettingsQuery = z
  .object({
    teamSlugOrId: z.string(),
  })
  .openapi("EditorSettingsQuery");

const EditorSettingsBody = z
  .object({
    teamSlugOrId: z.string(),
    settingsJson: z.string().optional(),
    keybindingsJson: z.string().optional(),
    snippets: z.array(SnippetSchema).optional(),
    extensions: z.string().optional(),
  })
  .openapi("EditorSettingsBody");

// GET /editor-settings - Get user's editor settings
editorSettingsRouter.openapi(
  createRoute({
    method: "get",
    path: "/editor-settings",
    summary: "Get user's editor settings",
    tags: ["EditorSettings"],
    request: {
      query: EditorSettingsQuery,
    },
    responses: {
      200: {
        description: "Editor settings retrieved",
        content: {
          "application/json": {
            schema: EditorSettingsResponse.nullable(),
          },
        },
      },
      401: { description: "Unauthorized" },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.text("Unauthorized", 401);

    const query = c.req.valid("query");

    await verifyTeamAccess({
      req: c.req.raw,
      teamSlugOrId: query.teamSlugOrId,
    });

    const db = getDb();
    const settings = getUserEditorSettings(db, query.teamSlugOrId, user.id);

    if (!settings) {
      return c.json(null);
    }

    return c.json({
      settingsJson: settings.settingsJson ?? undefined,
      keybindingsJson: settings.keybindingsJson ?? undefined,
      snippets: (settings.snippets as Array<{ name: string; content: string }>) ?? undefined,
      extensions: settings.extensions ?? undefined,
      updatedAt: settings.updatedAt,
    });
  }
);

// POST /editor-settings - Create or update editor settings
editorSettingsRouter.openapi(
  createRoute({
    method: "post",
    path: "/editor-settings",
    summary: "Create or update user's editor settings",
    tags: ["EditorSettings"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: EditorSettingsBody,
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Editor settings saved",
        content: {
          "application/json": {
            schema: EditorSettingsResponse,
          },
        },
      },
      401: { description: "Unauthorized" },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.text("Unauthorized", 401);

    const body = c.req.valid("json");

    await verifyTeamAccess({
      req: c.req.raw,
      teamSlugOrId: body.teamSlugOrId,
    });

    const db = getDb();
    upsertUserEditorSettings(db, {
      teamSlugOrId: body.teamSlugOrId,
      userId: user.id,
      patch: {
        settingsJson: body.settingsJson,
        keybindingsJson: body.keybindingsJson,
        snippets: body.snippets,
        extensions: body.extensions,
      },
    });

    return c.json({
      settingsJson: body.settingsJson,
      keybindingsJson: body.keybindingsJson,
      snippets: body.snippets,
      extensions: body.extensions,
      updatedAt: Date.now(),
    });
  }
);

// DELETE /editor-settings - Clear editor settings
editorSettingsRouter.openapi(
  createRoute({
    method: "delete",
    path: "/editor-settings",
    summary: "Clear user's editor settings",
    tags: ["EditorSettings"],
    request: {
      query: EditorSettingsQuery,
    },
    responses: {
      204: { description: "Editor settings cleared" },
      401: { description: "Unauthorized" },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.text("Unauthorized", 401);

    const query = c.req.valid("query");

    await verifyTeamAccess({
      req: c.req.raw,
      teamSlugOrId: query.teamSlugOrId,
    });

    const db = getDb();
    clearUserEditorSettings(db, {
      teamSlugOrId: query.teamSlugOrId,
      userId: user.id,
    });

    return c.body(null, 204);
  }
);
