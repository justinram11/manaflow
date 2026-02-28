import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { ComputeProvider } from "../provider.ts";

export function createSnapshotRoutes(provider: ComputeProvider) {
  const router = new OpenAPIHono();

  // POST /instances/:id/snapshots — Create a snapshot
  router.openapi(
    createRoute({
      method: "post" as const,
      path: "/instances/{id}/snapshots",
      tags: ["Snapshots"],
      summary: "Create a snapshot of an instance",
      request: {
        params: z.object({ id: z.string() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({
                name: z.string(),
              }),
            },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                snapshotId: z.string(),
                created: z.literal(true),
              }),
            },
          },
          description: "Snapshot created",
        },
        500: { description: "Failed to create snapshot" },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { name } = c.req.valid("json");
      try {
        const snapshotId = await provider.createSnapshot(id, name);
        return c.json({ snapshotId, created: true as const });
      } catch (error) {
        console.error("[compute-provider] Failed to create snapshot:", error);
        return c.text(
          error instanceof Error ? error.message : "Failed to create snapshot",
          500,
        );
      }
    },
  );

  // GET /snapshots — List all snapshots
  router.openapi(
    createRoute({
      method: "get" as const,
      path: "/snapshots",
      tags: ["Snapshots"],
      summary: "List all snapshots",
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                snapshots: z.array(
                  z.object({
                    id: z.string(),
                    containerName: z.string(),
                    snapshotName: z.string(),
                    createdAt: z.string(),
                    stateful: z.boolean(),
                  }),
                ),
              }),
            },
          },
          description: "List of snapshots",
        },
      },
    }),
    async (c) => {
      const snapshots = await provider.listSnapshots();
      return c.json({ snapshots });
    },
  );

  // DELETE /snapshots/:id — Delete a snapshot
  router.openapi(
    createRoute({
      method: "delete" as const,
      path: "/snapshots/{id}",
      tags: ["Snapshots"],
      summary: "Delete a snapshot",
      request: {
        params: z.object({ id: z.string() }),
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({ deleted: z.literal(true) }),
            },
          },
          description: "Snapshot deleted",
        },
        500: { description: "Failed to delete snapshot" },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        await provider.deleteSnapshot(id);
        return c.json({ deleted: true as const });
      } catch (error) {
        console.error("[compute-provider] Failed to delete snapshot:", error);
        return c.text(
          error instanceof Error ? error.message : "Failed to delete snapshot",
          500,
        );
      }
    },
  );

  return router;
}
