import { getUserFromRequest } from "@/lib/utils/auth";
import { stackServerApp } from "@/lib/utils/stack";
import { getDb } from "@cmux/db";
import {
  getTeamByTeamId,
  getTeamBySlug,
  getTeamBySlugOrId,
  listTeamMemberships,
} from "@cmux/db/queries/teams";
import {
  setTeamSlug,
  setTeamName,
  upsertTeam,
  ensureTeamMembership,
} from "@cmux/db/mutations/teams";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

const teamsRouter = new OpenAPIHono();

const CreateTeamRequestSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .openapi({
        description: "Human-friendly team name",
        example: "Frontend Wizards",
      }),
    slug: z
      .string()
      .trim()
      .min(3)
      .max(48)
      .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
      .openapi({
        description:
          "Slug used in URLs. Lowercase letters, numbers, and hyphens. Must start and end with a letter or number.",
        example: "frontend-wizards",
      }),
    inviteEmails: z
      .array(z.string().trim().email())
      .max(20)
      .optional()
      .openapi({
        description: "Optional list of teammate emails to invite",
        example: ["teammate@example.com"],
      }),
  })
  .openapi("CreateTeamRequest");

const CreateTeamResponseSchema = z
  .object({
    teamId: z.string().openapi({ description: "Stack team ID" }),
    displayName: z
      .string()
      .openapi({ description: "Display name saved in Stack", example: "Frontend Wizards" }),
    slug: z
      .string()
      .openapi({ description: "Slug stored in the database", example: "frontend-wizards" }),
    invitesSent: z
      .number()
      .openapi({ description: "Number of invite emails sent", example: 1 }),
  })
  .openapi("CreateTeamResponse");

const ErrorResponseSchema = z
  .object({
    code: z.number(),
    message: z.string(),
  })
  .openapi("CreateTeamErrorResponse");

const TeamSchema = z
  .object({
    id: z.string().openapi({ description: "Team ID" }),
    displayName: z.string().openapi({ description: "Display name", example: "Frontend Wizards" }),
    slug: z.string().nullable().openapi({ description: "URL slug", example: "frontend-wizards" }),
  })
  .openapi("Team");

const ListTeamsResponseSchema = z
  .object({
    teams: z.array(TeamSchema),
  })
  .openapi("ListTeamsResponse");

const SLUG_POLL_INTERVAL_MS = 400;
const SLUG_POLL_TIMEOUT_MS = 15_000;

function normalizeSlug(input: string): string {
  return input.trim().toLowerCase();
}

function validateSlug(slug: string): void {
  const normalized = normalizeSlug(slug);
  if (normalized.length < 3 || normalized.length > 48) {
    throw new Error("Slug must be 3\u201348 characters long");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(normalized)) {
    throw new Error(
      "Slug can contain lowercase letters, numbers, and hyphens, and must start/end with a letter or number"
    );
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// GET /teams - List user's teams
teamsRouter.openapi(
  createRoute({
    method: "get" as const,
    path: "/teams",
    tags: ["Teams"],
    summary: "List user's teams",
    responses: {
      200: {
        description: "List of teams",
        content: {
          "application/json": {
            schema: ListTeamsResponseSchema,
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: {
          "application/json": {
            schema: ErrorResponseSchema,
          },
        },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) {
      return c.json({ code: 401, message: "Unauthorized" }, 401);
    }

    const stackTeams = await user.listTeams();
    const db = getDb();

    // Fetch slugs from DB for each team
    const teams = stackTeams.map((team) => {
      let slug: string | null = null;
      try {
        const dbTeam = getTeamByTeamId(db, team.id);
        slug = dbTeam?.slug ?? null;
      } catch {
        // Team might not exist in DB yet
      }
      return {
        id: team.id,
        displayName: team.displayName,
        slug,
      };
    });

    return c.json({ teams }, 200);
  }
);

teamsRouter.openapi(
  createRoute({
    method: "post" as const,
    path: "/teams",
    tags: ["Teams"],
    summary: "Create a new team",
    request: {
      body: {
        content: {
          "application/json": {
            schema: CreateTeamRequestSchema,
          },
        },
        required: true,
      },
    },
    responses: {
      201: {
        description: "Team created",
        content: {
          "application/json": {
            schema: CreateTeamResponseSchema,
          },
        },
      },
      400: {
        description: "Invalid input",
        content: {
          "application/json": {
            schema: ErrorResponseSchema,
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: {
          "application/json": {
            schema: ErrorResponseSchema,
          },
        },
      },
      409: {
        description: "Slug conflict",
        content: {
          "application/json": {
            schema: ErrorResponseSchema,
          },
        },
      },
      504: {
        description: "Timed out while syncing",
        content: {
          "application/json": {
            schema: ErrorResponseSchema,
          },
        },
      },
      500: {
        description: "Failed to create team",
        content: {
          "application/json": {
            schema: ErrorResponseSchema,
          },
        },
      },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const trimmedName = body.displayName.trim();
    const normalizedSlug = normalizeSlug(body.slug);
    const inviteEmails = Array.from(
      new Set((body.inviteEmails ?? []).map((email) => email.trim()).filter((email) => email.length > 0))
    );

    if (trimmedName.length === 0) {
      return c.json({ code: 400, message: "Display name is required" }, 400);
    }

    try {
      validateSlug(normalizedSlug);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid slug";
      return c.json({ code: 400, message }, 400);
    }

    const user = await stackServerApp.getUser({ tokenStore: c.req.raw, or: "return-null" });
    if (!user) {
      return c.json({ code: 401, message: "Unauthorized" }, 401);
    }

    const db = getDb();

    try {
      // Check slug uniqueness
      const existingBySlug = getTeamBySlug(db, normalizedSlug);
      if (existingBySlug) {
        return c.json({ code: 409, message: "Slug is already taken" }, 409);
      }

      const createdTeam = await user.createTeam({ displayName: trimmedName });

      try {
        const metadata =
          createdTeam.clientMetadata &&
          typeof createdTeam.clientMetadata === "object" &&
          createdTeam.clientMetadata !== null
            ? (createdTeam.clientMetadata as Record<string, unknown>)
            : {};
        await createdTeam.update({
          clientMetadata: {
            ...metadata,
            slug: normalizedSlug,
          },
        });
      } catch (metadataError) {
        console.error("Failed to persist slug in Stack metadata", metadataError);
      }

      let invitesSent = 0;
      for (const email of inviteEmails) {
        try {
          await createdTeam.inviteUser({ email });
          invitesSent += 1;
        } catch (inviteError) {
          console.error("Failed to invite teammate", { email, inviteError });
        }
      }

      // Poll for team to sync from Stack Auth into our DB, then set the slug
      const start = Date.now();
      let slugSet = false;
      let lastError: unknown;
      while (Date.now() - start < SLUG_POLL_TIMEOUT_MS) {
        try {
          const teamRow = getTeamByTeamId(db, createdTeam.id);
          if (teamRow) {
            // Check slug uniqueness again before setting
            const slugConflict = getTeamBySlug(db, normalizedSlug);
            if (slugConflict && slugConflict.teamId !== createdTeam.id) {
              return c.json({ code: 409, message: "Slug is already taken" }, 409);
            }
            setTeamSlug(db, createdTeam.id, normalizedSlug);
            slugSet = true;
            break;
          }
        } catch (error) {
          lastError = error;
        }
        await wait(SLUG_POLL_INTERVAL_MS);
      }

      if (!slugSet) {
        console.error("Timed out waiting for team to sync in DB", {
          teamId: createdTeam.id,
          lastError,
        });
        return c.json(
          { code: 504, message: "Timed out while syncing the new team" },
          504
        );
      }

      return c.json(
        {
          teamId: createdTeam.id,
          displayName: createdTeam.displayName,
          slug: normalizedSlug,
          invitesSent,
        },
        201
      );
    } catch (error) {
      console.error("Failed to create team via Stack", error);
      return c.json({ code: 500, message: "Failed to create team" }, 500);
    }
  }
);

// GET /teams/memberships - List current user's team memberships
teamsRouter.openapi(
  createRoute({
    method: "get" as const,
    path: "/teams/memberships",
    tags: ["Teams"],
    summary: "List current user's team memberships",
    responses: {
      200: {
        description: "List of team memberships",
        content: {
          "application/json": {
            schema: z.object({
              memberships: z.array(
                z.object({
                  id: z.string(),
                  teamId: z.string(),
                  userId: z.string(),
                  role: z.string().nullable().optional(),
                  createdAt: z.number().nullable().optional(),
                  updatedAt: z.number().nullable().optional(),
                  team: TeamSchema,
                }),
              ),
            }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) {
      return c.json({ code: 401, message: "Unauthorized" }, 401);
    }

    const db = getDb();
    const rows = listTeamMemberships(db, user.id);
    const memberships = rows.map((row) => ({
      id: row.teamMemberships.id,
      teamId: row.teamMemberships.teamId,
      userId: row.teamMemberships.userId,
      role: row.teamMemberships.role ?? null,
      createdAt: row.teamMemberships.createdAt ?? null,
      updatedAt: row.teamMemberships.updatedAt ?? null,
      team: {
        id: row.teams.id,
        displayName: row.teams.displayName ?? row.teams.teamId,
        slug: row.teams.slug ?? null,
      },
    }));

    return c.json({ memberships }, 200);
  },
);

// GET /teams/:teamSlugOrId - Get a single team by slug or ID
teamsRouter.openapi(
  createRoute({
    method: "get" as const,
    path: "/teams/{teamSlugOrId}",
    tags: ["Teams"],
    summary: "Get team by slug or ID",
    request: {
      params: z.object({ teamSlugOrId: z.string() }),
    },
    responses: {
      200: {
        description: "Team details",
        content: {
          "application/json": {
            schema: z.object({
              team: TeamSchema.extend({
                teamId: z.string(),
                name: z.string().nullable().optional(),
              }),
            }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
      404: {
        description: "Team not found",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) {
      return c.json({ code: 401, message: "Unauthorized" }, 401);
    }

    const { teamSlugOrId } = c.req.valid("param");
    const db = getDb();
    const team = getTeamBySlugOrId(db, teamSlugOrId);
    if (!team) {
      return c.json({ code: 404, message: "Team not found" }, 404);
    }

    return c.json(
      {
        team: {
          id: team.id,
          teamId: team.teamId,
          displayName: team.displayName ?? team.teamId,
          slug: team.slug ?? null,
          name: team.name ?? null,
        },
      },
      200,
    );
  },
);

// PATCH /teams/:teamSlugOrId/slug - Set team slug
teamsRouter.openapi(
  createRoute({
    method: "patch" as const,
    path: "/teams/{teamSlugOrId}/slug",
    tags: ["Teams"],
    summary: "Set team slug",
    request: {
      params: z.object({ teamSlugOrId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ slug: z.string() }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Slug updated",
        content: {
          "application/json": {
            schema: z.object({ slug: z.string() }),
          },
        },
      },
      400: {
        description: "Invalid slug",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
      404: {
        description: "Team not found",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
      409: {
        description: "Slug conflict",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) {
      return c.json({ code: 401, message: "Unauthorized" }, 401);
    }

    const { teamSlugOrId } = c.req.valid("param");
    const { slug } = c.req.valid("json");
    const normalized = normalizeSlug(slug);

    try {
      validateSlug(normalized);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid slug";
      return c.json({ code: 400, message }, 400);
    }

    const db = getDb();
    const team = getTeamBySlugOrId(db, teamSlugOrId);
    if (!team) {
      return c.json({ code: 404, message: "Team not found" }, 404);
    }

    const existing = getTeamBySlug(db, normalized);
    if (existing && existing.teamId !== team.teamId) {
      return c.json({ code: 409, message: "Slug is already taken" }, 409);
    }

    setTeamSlug(db, team.teamId, normalized);
    return c.json({ slug: normalized }, 200);
  },
);

// PATCH /teams/:teamSlugOrId/name - Set team name
teamsRouter.openapi(
  createRoute({
    method: "patch" as const,
    path: "/teams/{teamSlugOrId}/name",
    tags: ["Teams"],
    summary: "Set team display name",
    request: {
      params: z.object({ teamSlugOrId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({ name: z.string() }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Name updated",
        content: {
          "application/json": {
            schema: z.object({ name: z.string() }),
          },
        },
      },
      400: {
        description: "Invalid name",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
      404: {
        description: "Team not found",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) {
      return c.json({ code: 401, message: "Unauthorized" }, 401);
    }

    const { teamSlugOrId } = c.req.valid("param");
    const { name } = c.req.valid("json");
    const trimmed = name.trim();

    if (trimmed.length < 1 || trimmed.length > 32) {
      return c.json(
        { code: 400, message: "Name must be 1-32 characters long" },
        400,
      );
    }

    const db = getDb();
    const team = getTeamBySlugOrId(db, teamSlugOrId);
    if (!team) {
      return c.json({ code: 404, message: "Team not found" }, 404);
    }

    setTeamName(db, team.teamId, trimmed);
    return c.json({ name: trimmed }, 200);
  },
);

// POST /teams/upsert - Upsert team (for Stack Auth sync)
teamsRouter.openapi(
  createRoute({
    method: "post" as const,
    path: "/teams/upsert",
    tags: ["Teams"],
    summary: "Upsert a team (used for Stack Auth sync)",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              id: z.string(),
              displayName: z.string().optional(),
              profileImageUrl: z.string().optional(),
              clientMetadata: z.unknown().optional(),
              clientReadOnlyMetadata: z.unknown().optional(),
              serverMetadata: z.unknown().optional(),
              createdAtMillis: z.number(),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Team upserted",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean() }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) {
      return c.json({ code: 401, message: "Unauthorized" }, 401);
    }

    const body = c.req.valid("json");
    const db = getDb();
    upsertTeam(db, {
      teamId: body.id,
      displayName: body.displayName,
      profileImageUrl: body.profileImageUrl,
      clientMetadata: body.clientMetadata,
      clientReadOnlyMetadata: body.clientReadOnlyMetadata,
      serverMetadata: body.serverMetadata,
      createdAtMillis: body.createdAtMillis,
    });

    return c.json({ success: true }, 200);
  },
);

// POST /teams/ensure-membership - Ensure team membership exists
teamsRouter.openapi(
  createRoute({
    method: "post" as const,
    path: "/teams/ensure-membership",
    tags: ["Teams"],
    summary: "Ensure a team membership exists",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              teamId: z.string(),
              userId: z.string(),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Membership ensured",
        content: {
          "application/json": {
            schema: z.object({ success: z.boolean() }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponseSchema } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) {
      return c.json({ code: 401, message: "Unauthorized" }, 401);
    }

    const { teamId, userId } = c.req.valid("json");
    const db = getDb();
    ensureTeamMembership(db, teamId, userId);

    return c.json({ success: true }, 200);
  },
);

export { teamsRouter };
