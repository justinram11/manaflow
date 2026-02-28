import { getUserFromRequest } from "@/lib/utils/auth";
import { getDb, schema } from "@cmux/db";
import { resolveTeamId } from "@cmux/db/queries/teams";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and, sql } from "drizzle-orm";

export const dbAnalyticsRouter = new OpenAPIHono();

const ErrorResponse = z
  .object({
    code: z.number(),
    message: z.string(),
  })
  .openapi("DbAnalyticsErrorResponse");

const DashboardQuery = z
  .object({
    teamSlugOrId: z.string(),
  })
  .openapi("DbDashboardQuery");

const DashboardStatsSchema = z
  .object({
    totalTasks: z.number(),
    completedTasks: z.number(),
    archivedTasks: z.number(),
    totalRuns: z.number(),
    runsByStatus: z.record(z.string(), z.number()),
  })
  .openapi("DbDashboardStats");

// GET /analytics/dashboard - Get dashboard stats
dbAnalyticsRouter.openapi(
  createRoute({
    method: "get",
    path: "/analytics/dashboard",
    tags: ["DbAnalytics"],
    summary: "Get dashboard statistics",
    request: {
      query: DashboardQuery,
    },
    responses: {
      200: {
        description: "Dashboard statistics",
        content: {
          "application/json": {
            schema: DashboardStatsSchema,
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
    const teamId = resolveTeamId(db, query.teamSlugOrId);

    // Count total tasks
    const totalTasksResult = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.teamId, teamId), eq(schema.tasks.userId, user.id)))
      .get();
    const totalTasks = totalTasksResult?.count ?? 0;

    // Count completed tasks
    const completedTasksResult = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.teamId, teamId),
          eq(schema.tasks.userId, user.id),
          eq(schema.tasks.isCompleted, true),
        ),
      )
      .get();
    const completedTasks = completedTasksResult?.count ?? 0;

    // Count archived tasks
    const archivedTasksResult = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.teamId, teamId),
          eq(schema.tasks.userId, user.id),
          eq(schema.tasks.isArchived, true),
        ),
      )
      .get();
    const archivedTasks = archivedTasksResult?.count ?? 0;

    // Count total runs
    const totalRunsResult = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.taskRuns)
      .where(and(eq(schema.taskRuns.teamId, teamId), eq(schema.taskRuns.userId, user.id)))
      .get();
    const totalRuns = totalRunsResult?.count ?? 0;

    // Count runs by status
    const runsByStatusResults = db
      .select({
        status: schema.taskRuns.status,
        count: sql<number>`count(*)`,
      })
      .from(schema.taskRuns)
      .where(and(eq(schema.taskRuns.teamId, teamId), eq(schema.taskRuns.userId, user.id)))
      .groupBy(schema.taskRuns.status)
      .all();

    const runsByStatus: Record<string, number> = {};
    for (const row of runsByStatusResults) {
      runsByStatus[row.status] = row.count;
    }

    return c.json(
      {
        totalTasks,
        completedTasks,
        archivedTasks,
        totalRuns,
        runsByStatus,
      },
      200,
    );
  },
);
