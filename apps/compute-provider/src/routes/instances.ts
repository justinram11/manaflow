import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { ComputeProvider } from "../provider.ts";

const portsSchema = z.object({
  exec: z.number(),
  worker: z.number(),
  vscode: z.number(),
  proxy: z.number(),
  vnc: z.number(),
  devtools: z.number(),
  pty: z.number(),
  androidVnc: z.number().optional(),
});

export function createInstanceRoutes(provider: ComputeProvider) {
  const router = new OpenAPIHono();

  // POST /instances — Launch a new instance
  router.openapi(
    createRoute({
      method: "post" as const,
      path: "/instances",
      tags: ["Instances"],
      summary: "Launch a new compute instance",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                image: z.string().optional(),
                snapshotId: z.string().optional(),
                displays: z.array(z.literal("android")).optional(),
                wantsIos: z.boolean().optional(),
                metadata: z.record(z.string(), z.string()).optional(),
                region: z.string().optional(),
                ttlSeconds: z.number().int().positive().optional(),
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
                id: z.string(),
                status: z.string(),
                ports: portsSchema,
                host: z.string(),
              }),
            },
          },
          description: "Instance launched",
        },
        500: { description: "Failed to launch instance" },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      try {
        const result = await provider.launch(body);
        return c.json(result);
      } catch (error) {
        console.error("[compute-provider] Failed to launch instance:", error);
        return c.text(
          error instanceof Error ? error.message : "Failed to launch instance",
          500,
        );
      }
    },
  );

  // GET /instances — List all instances
  router.openapi(
    createRoute({
      method: "get" as const,
      path: "/instances",
      tags: ["Instances"],
      summary: "List all compute instances",
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                instances: z.array(
                  z.object({
                    id: z.string(),
                    status: z.string(),
                    paused: z.boolean(),
                    ports: portsSchema.optional(),
                    metadata: z.record(z.string(), z.string()).optional(),
                    createdAt: z.number(),
                  }),
                ),
              }),
            },
          },
          description: "List of instances",
        },
      },
    }),
    async (c) => {
      const instances = await provider.listInstances();
      return c.json({ instances });
    },
  );

  // GET /instances/:id — Get instance details
  router.openapi(
    createRoute({
      method: "get" as const,
      path: "/instances/{id}",
      tags: ["Instances"],
      summary: "Get instance details",
      request: {
        params: z.object({ id: z.string() }),
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                id: z.string(),
                status: z.string(),
                paused: z.boolean(),
                ports: portsSchema.optional(),
                metadata: z.record(z.string(), z.string()).optional(),
                createdAt: z.number(),
              }),
            },
          },
          description: "Instance details",
        },
        404: { description: "Instance not found" },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const status = await provider.getStatus(id);
      if (!status) {
        return c.text("Instance not found", 404);
      }
      return c.json(status);
    },
  );

  // POST /instances/:id/exec — Execute a command
  router.openapi(
    createRoute({
      method: "post" as const,
      path: "/instances/{id}/exec",
      tags: ["Instances"],
      summary: "Execute a command in an instance",
      request: {
        params: z.object({ id: z.string() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({
                command: z.string(),
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
                exitCode: z.number(),
                stdout: z.string(),
                stderr: z.string(),
              }),
            },
          },
          description: "Command executed",
        },
        500: { description: "Failed to execute command" },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { command } = c.req.valid("json");
      try {
        const result = await provider.exec(id, command);
        return c.json(result);
      } catch (error) {
        console.error("[compute-provider] Failed to exec:", error);
        return c.text(
          error instanceof Error ? error.message : "Failed to execute command",
          500,
        );
      }
    },
  );

  // POST /instances/:id/stop — Stop an instance
  router.openapi(
    createRoute({
      method: "post" as const,
      path: "/instances/{id}/stop",
      tags: ["Instances"],
      summary: "Stop a running instance",
      request: {
        params: z.object({ id: z.string() }),
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({ stopped: z.literal(true) }),
            },
          },
          description: "Instance stopped",
        },
        500: { description: "Failed to stop instance" },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        await provider.stop(id);
        return c.json({ stopped: true as const });
      } catch (error) {
        console.error("[compute-provider] Failed to stop:", error);
        return c.text(
          error instanceof Error ? error.message : "Failed to stop instance",
          500,
        );
      }
    },
  );

  // POST /instances/:id/pause — Pause an instance
  router.openapi(
    createRoute({
      method: "post" as const,
      path: "/instances/{id}/pause",
      tags: ["Instances"],
      summary: "Pause a running instance",
      request: {
        params: z.object({ id: z.string() }),
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({ paused: z.literal(true) }),
            },
          },
          description: "Instance paused",
        },
        500: { description: "Failed to pause instance" },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        await provider.pause(id);
        return c.json({ paused: true as const });
      } catch (error) {
        console.error("[compute-provider] Failed to pause:", error);
        return c.text(
          error instanceof Error ? error.message : "Failed to pause instance",
          500,
        );
      }
    },
  );

  // POST /instances/:id/resume — Resume an instance
  router.openapi(
    createRoute({
      method: "post" as const,
      path: "/instances/{id}/resume",
      tags: ["Instances"],
      summary: "Resume a paused instance",
      request: {
        params: z.object({ id: z.string() }),
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({ resumed: z.literal(true) }),
            },
          },
          description: "Instance resumed",
        },
        500: { description: "Failed to resume instance" },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        await provider.resume(id);
        return c.json({ resumed: true as const });
      } catch (error) {
        console.error("[compute-provider] Failed to resume:", error);
        return c.text(
          error instanceof Error ? error.message : "Failed to resume instance",
          500,
        );
      }
    },
  );

  // DELETE /instances/:id — Destroy an instance
  router.openapi(
    createRoute({
      method: "delete" as const,
      path: "/instances/{id}",
      tags: ["Instances"],
      summary: "Destroy an instance",
      request: {
        params: z.object({ id: z.string() }),
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({ destroyed: z.literal(true) }),
            },
          },
          description: "Instance destroyed",
        },
        500: { description: "Failed to destroy instance" },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        await provider.destroy(id);
        return c.json({ destroyed: true as const });
      } catch (error) {
        console.error("[compute-provider] Failed to destroy:", error);
        return c.text(
          error instanceof Error ? error.message : "Failed to destroy instance",
          500,
        );
      }
    },
  );

  return router;
}
