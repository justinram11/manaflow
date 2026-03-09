import { getUserFromRequest } from "@/lib/utils/auth";
import { getDb } from "@cmux/db";
import {
  getWorkspaceSettings,
  getContainerSettings,
  getUserEditorSettings,
  getTeamSettings,
} from "@cmux/db/queries/settings";
import {
  upsertWorkspaceSettings,
  upsertContainerSettings,
  upsertUserEditorSettings,
  upsertTeamSettings,
} from "@cmux/db/mutations/settings";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

export const dbSettingsRouter = new OpenAPIHono();

const ErrorResponse = z
  .object({
    code: z.number(),
    message: z.string(),
  })
  .openapi("DbSettingsErrorResponse");

const TeamQuery = z
  .object({
    teamSlugOrId: z.string(),
  })
  .openapi("DbSettingsTeamQuery");

const WorkspaceSettingsSchema = z
  .object({
    id: z.string(),
    worktreePath: z.string().nullable().optional(),
    autoPrEnabled: z.boolean().nullable().optional(),
    autoSyncEnabled: z.boolean().nullable().optional(),
    nextLocalWorkspaceSequence: z.number().nullable().optional(),
    heatmapModel: z.string().nullable().optional(),
    heatmapThreshold: z.number().nullable().optional(),
    heatmapTooltipLanguage: z.string().nullable().optional(),
    heatmapColors: z.unknown().nullable().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    userId: z.string(),
    teamId: z.string(),
  })
  .openapi("DbWorkspaceSettings");

const ContainerSettingsSchema = z
  .object({
    id: z.string(),
    maxRunningContainers: z.number().nullable().optional(),
    reviewPeriodMinutes: z.number().nullable().optional(),
    autoCleanupEnabled: z.boolean().nullable().optional(),
    stopImmediatelyOnCompletion: z.boolean().nullable().optional(),
    minContainersToKeep: z.number().nullable().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    userId: z.string(),
    teamId: z.string(),
  })
  .openapi("DbContainerSettings");

const EditorSettingsSchema = z
  .object({
    id: z.string(),
    teamId: z.string(),
    userId: z.string(),
    settingsJson: z.string().nullable().optional(),
    keybindingsJson: z.string().nullable().optional(),
    snippets: z.unknown().nullable().optional(),
    extensions: z.string().nullable().optional(),
    updatedAt: z.number(),
  })
  .openapi("DbEditorSettings");

const UpdateWorkspaceSettingsBody = z
  .object({
    teamSlugOrId: z.string(),
    worktreePath: z.string().optional(),
    autoPrEnabled: z.boolean().optional(),
    autoSyncEnabled: z.boolean().optional(),
    nextLocalWorkspaceSequence: z.number().optional(),
    heatmapModel: z.string().optional(),
    heatmapThreshold: z.number().optional(),
    heatmapTooltipLanguage: z.string().optional(),
    heatmapColors: z.unknown().optional(),
  })
  .openapi("DbUpdateWorkspaceSettingsBody");

const UpdateContainerSettingsBody = z
  .object({
    teamSlugOrId: z.string(),
    maxRunningContainers: z.number().optional(),
    reviewPeriodMinutes: z.number().optional(),
    autoCleanupEnabled: z.boolean().optional(),
    stopImmediatelyOnCompletion: z.boolean().optional(),
    minContainersToKeep: z.number().optional(),
  })
  .openapi("DbUpdateContainerSettingsBody");

const UpdateEditorSettingsBody = z
  .object({
    teamSlugOrId: z.string(),
    settingsJson: z.string().optional(),
    keybindingsJson: z.string().optional(),
    snippets: z.array(z.object({ name: z.string(), content: z.string() })).optional(),
    extensions: z.string().optional(),
  })
  .openapi("DbUpdateEditorSettingsBody");

// GET /workspace-settings - Get workspace settings
dbSettingsRouter.openapi(
  createRoute({
    method: "get",
    path: "/workspace-settings",
    tags: ["DbSettings"],
    summary: "Get workspace settings",
    request: {
      query: TeamQuery,
    },
    responses: {
      200: {
        description: "Workspace settings",
        content: {
          "application/json": {
            schema: WorkspaceSettingsSchema.nullable(),
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
    const settings = getWorkspaceSettings(db, query.teamSlugOrId, user.id);

    return c.json(settings ?? null, 200);
  },
);

// PATCH /workspace-settings - Update workspace settings
dbSettingsRouter.openapi(
  createRoute({
    method: "patch",
    path: "/workspace-settings",
    tags: ["DbSettings"],
    summary: "Update workspace settings",
    request: {
      body: {
        content: {
          "application/json": {
            schema: UpdateWorkspaceSettingsBody,
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Workspace settings updated",
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
    const { teamSlugOrId, ...patch } = body;
    const db = getDb();

    const id = upsertWorkspaceSettings(db, {
      teamSlugOrId,
      userId: user.id,
      patch,
    });

    return c.json({ id }, 200);
  },
);

// GET /container-settings - Get container settings
dbSettingsRouter.openapi(
  createRoute({
    method: "get",
    path: "/container-settings",
    tags: ["DbSettings"],
    summary: "Get container settings",
    request: {
      query: TeamQuery,
    },
    responses: {
      200: {
        description: "Container settings",
        content: {
          "application/json": {
            schema: ContainerSettingsSchema.nullable(),
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
    const settings = getContainerSettings(db, query.teamSlugOrId, user.id);

    return c.json(settings ?? null, 200);
  },
);

// PATCH /container-settings - Update container settings
dbSettingsRouter.openapi(
  createRoute({
    method: "patch",
    path: "/container-settings",
    tags: ["DbSettings"],
    summary: "Update container settings",
    request: {
      body: {
        content: {
          "application/json": {
            schema: UpdateContainerSettingsBody,
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Container settings updated",
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
    const { teamSlugOrId, ...patch } = body;
    const db = getDb();

    const id = upsertContainerSettings(db, {
      teamSlugOrId,
      userId: user.id,
      patch,
    });

    return c.json({ id }, 200);
  },
);

// GET /user-editor-settings - Get editor settings
dbSettingsRouter.openapi(
  createRoute({
    method: "get",
    path: "/user-editor-settings",
    tags: ["DbSettings"],
    summary: "Get user editor settings",
    request: {
      query: TeamQuery,
    },
    responses: {
      200: {
        description: "Editor settings",
        content: {
          "application/json": {
            schema: EditorSettingsSchema.nullable(),
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
    const settings = getUserEditorSettings(db, query.teamSlugOrId, user.id);

    return c.json(settings ?? null, 200);
  },
);

// PUT /user-editor-settings - Update editor settings
dbSettingsRouter.openapi(
  createRoute({
    method: "put",
    path: "/user-editor-settings",
    tags: ["DbSettings"],
    summary: "Update user editor settings",
    request: {
      body: {
        content: {
          "application/json": {
            schema: UpdateEditorSettingsBody,
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Editor settings updated",
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
    const { teamSlugOrId, ...patch } = body;
    const db = getDb();

    const id = upsertUserEditorSettings(db, {
      teamSlugOrId,
      userId: user.id,
      patch,
    });

    return c.json({ id }, 200);
  },
);

// ── Team Settings (team-scoped, not user-scoped) ─────────────────────

const TeamSettingsSchema = z
  .object({
    id: z.string(),
    teamId: z.string(),
    tailscaleAuthKey: z.string().nullable().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .openapi("DbTeamSettings");

const UpdateTeamSettingsBody = z
  .object({
    teamSlugOrId: z.string(),
    tailscaleAuthKey: z.string().optional(),
  })
  .openapi("DbUpdateTeamSettingsBody");

// GET /team-settings - Get team settings
dbSettingsRouter.openapi(
  createRoute({
    method: "get",
    path: "/team-settings",
    tags: ["DbSettings"],
    summary: "Get team settings",
    request: {
      query: TeamQuery,
    },
    responses: {
      200: {
        description: "Team settings",
        content: {
          "application/json": {
            schema: TeamSettingsSchema.nullable(),
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
    const settings = getTeamSettings(db, query.teamSlugOrId);

    return c.json(settings ?? null, 200);
  },
);

// PATCH /team-settings - Update team settings
dbSettingsRouter.openapi(
  createRoute({
    method: "patch",
    path: "/team-settings",
    tags: ["DbSettings"],
    summary: "Update team settings",
    request: {
      body: {
        content: {
          "application/json": {
            schema: UpdateTeamSettingsBody,
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Team settings updated",
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
    const { teamSlugOrId, ...patch } = body;
    const db = getDb();

    const id = upsertTeamSettings(db, {
      teamSlugOrId,
      patch,
    });

    return c.json({ id }, 200);
  },
);
