import { getUserFromRequest } from "@/lib/utils/auth";
import { getDb } from "@cmux/db";
import {
  listByTeam,
  getById,
  listActiveAllocationsByProvider,
  getAllocationById,
} from "@cmux/db/queries/resource-providers";
import {
  createResourceProvider,
  updateResourceProvider,
  deleteResourceProvider,
  createAllocation,
  releaseAllocation,
} from "@cmux/db/mutations/resource-providers";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createHash, randomBytes } from "node:crypto";

// Import the WS hub send function (will be provided by the server app)
// For MCP proxying, we need a way to reach the WebSocket hub running in apps/server
// We do this by forwarding MCP requests to the server via an internal HTTP call
const CMUX_SERVER_URL = process.env.CMUX_SERVER_INTERNAL_URL ?? "http://localhost:3001";

export const resourceProvidersRouter = new OpenAPIHono();

const ErrorResponse = z
  .object({
    code: z.number(),
    message: z.string(),
  })
  .openapi("ResourceProviderErrorResponse");

const TeamQuery = z
  .object({
    teamSlugOrId: z.string(),
  })
  .openapi("ResourceProviderTeamQuery");

const ResourceProviderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    teamId: z.string(),
    userId: z.string(),
    platform: z.string(),
    arch: z.string(),
    osVersion: z.string().nullable().optional(),
    hostname: z.string().nullable().optional(),
    capabilities: z.array(z.string()).nullable().optional(),
    maxConcurrentBuilds: z.number().nullable().optional(),
    status: z.string(),
    lastHeartbeatAt: z.number().nullable().optional(),
    xcodeVersion: z.string().nullable().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .openapi("ResourceProvider");

const ResourceAllocationSchema = z
  .object({
    id: z.string(),
    resourceProviderId: z.string(),
    taskRunId: z.string().nullable().optional(),
    teamId: z.string(),
    userId: z.string(),
    status: z.string(),
    buildDir: z.string().nullable().optional(),
    simulatorUdid: z.string().nullable().optional(),
    simulatorDeviceType: z.string().nullable().optional(),
    simulatorRuntime: z.string().nullable().optional(),
    platform: z.string(),
    createdAt: z.number(),
    releasedAt: z.number().nullable().optional(),
  })
  .openapi("ResourceAllocation");

const CreateResourceProviderBody = z
  .object({
    teamSlugOrId: z.string(),
    name: z.string().min(1).max(200),
    platform: z.string().default("macos"),
    arch: z.string().default("arm64"),
  })
  .openapi("CreateResourceProviderBody");

const UpdateResourceProviderBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    maxConcurrentBuilds: z.number().int().min(1).max(20).optional(),
  })
  .openapi("UpdateResourceProviderBody");

const AllocateBody = z
  .object({
    taskRunId: z.string().optional(),
    teamSlugOrId: z.string(),
    simulatorDeviceType: z.string().optional(),
    simulatorRuntime: z.string().optional(),
    platform: z.string().optional(),
  })
  .openapi("AllocateResourceBody");

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// POST /resource-providers - Register new provider
resourceProvidersRouter.openapi(
  createRoute({
    method: "post",
    path: "/resource-providers",
    tags: ["ResourceProviders"],
    summary: "Register a new resource provider",
    request: {
      body: {
        content: { "application/json": { schema: CreateResourceProviderBody } },
        required: true,
      },
    },
    responses: {
      201: {
        description: "Resource provider created",
        content: {
          "application/json": {
            schema: z.object({
              id: z.string(),
              token: z.string().openapi({ description: "Raw token - shown once" }),
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

    const body = c.req.valid("json");
    const rawToken = randomBytes(32).toString("hex");
    const hashedToken = hashToken(rawToken);
    const db = getDb();

    const { id } = createResourceProvider(db, {
      teamSlugOrId: body.teamSlugOrId,
      userId: user.id,
      name: body.name,
      registrationToken: hashedToken,
      platform: body.platform,
      arch: body.arch,
    });

    return c.json({ id, token: rawToken }, 201);
  },
);

// GET /resource-providers - List providers for team
resourceProvidersRouter.openapi(
  createRoute({
    method: "get",
    path: "/resource-providers",
    tags: ["ResourceProviders"],
    summary: "List resource providers for team",
    request: { query: TeamQuery },
    responses: {
      200: {
        description: "List of resource providers",
        content: {
          "application/json": {
            schema: z.object({
              providers: z.array(
                ResourceProviderSchema.extend({
                  activeAllocations: z.number(),
                }),
              ),
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
    const providers = listByTeam(db, query.teamSlugOrId);

    const providersWithCounts = providers.map((p: { id: string; [key: string]: unknown }) => {
      const active = listActiveAllocationsByProvider(db, p.id);
      return { ...p, activeAllocations: active.length };
    });

    return c.json({ providers: providersWithCounts }, 200);
  },
);

// GET /resource-providers/:id - Provider details
resourceProvidersRouter.openapi(
  createRoute({
    method: "get",
    path: "/resource-providers/{id}",
    tags: ["ResourceProviders"],
    summary: "Get resource provider details",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        description: "Resource provider details",
        content: {
          "application/json": {
            schema: z.object({
              provider: ResourceProviderSchema,
              allocations: z.array(ResourceAllocationSchema),
            }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: {
        description: "Not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const { id } = c.req.valid("param");
    const db = getDb();
    const provider = getById(db, id);
    if (!provider) return c.json({ code: 404, message: "Provider not found" }, 404);

    const allocations = listActiveAllocationsByProvider(db, id);
    return c.json({ provider, allocations }, 200);
  },
);

// PATCH /resource-providers/:id - Update provider
resourceProvidersRouter.openapi(
  createRoute({
    method: "patch",
    path: "/resource-providers/{id}",
    tags: ["ResourceProviders"],
    summary: "Update resource provider",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: { "application/json": { schema: UpdateResourceProviderBody } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "Provider updated",
        content: {
          "application/json": { schema: z.object({ success: z.boolean() }) },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: {
        description: "Not found",
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

    const provider = getById(db, id);
    if (!provider) return c.json({ code: 404, message: "Provider not found" }, 404);

    updateResourceProvider(db, id, body);
    return c.json({ success: true }, 200);
  },
);

// DELETE /resource-providers/:id - Deregister provider
resourceProvidersRouter.openapi(
  createRoute({
    method: "delete",
    path: "/resource-providers/{id}",
    tags: ["ResourceProviders"],
    summary: "Deregister resource provider",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      204: { description: "Provider deleted" },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: {
        description: "Not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const { id } = c.req.valid("param");
    const db = getDb();

    const provider = getById(db, id);
    if (!provider) return c.json({ code: 404, message: "Provider not found" }, 404);

    deleteResourceProvider(db, id);
    return c.body(null, 204);
  },
);

// POST /resource-providers/:id/allocate - Allocate for workspace
resourceProvidersRouter.openapi(
  createRoute({
    method: "post",
    path: "/resource-providers/{id}/allocate",
    tags: ["ResourceProviders"],
    summary: "Allocate resource provider for a workspace",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: { "application/json": { schema: AllocateBody } },
        required: true,
      },
    },
    responses: {
      201: {
        description: "Allocation created",
        content: {
          "application/json": {
            schema: z.object({
              allocationId: z.string(),
              buildDir: z.string(),
            }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: {
        description: "Provider not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
      409: {
        description: "Provider at capacity",
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

    const provider = getById(db, id);
    if (!provider) return c.json({ code: 404, message: "Provider not found" }, 404);

    if (provider.status !== "online") {
      return c.json({ code: 409, message: "Provider is offline" }, 409);
    }

    const activeAllocations = listActiveAllocationsByProvider(db, id);
    if (activeAllocations.length >= (provider.maxConcurrentBuilds ?? 2)) {
      return c.json({ code: 409, message: "Provider at maximum capacity" }, 409);
    }

    const { id: allocationId, buildDir } = createAllocation(db, {
      resourceProviderId: id,
      taskRunId: body.taskRunId,
      teamSlugOrId: body.teamSlugOrId,
      userId: user.id,
      platform: body.platform,
      simulatorDeviceType: body.simulatorDeviceType,
      simulatorRuntime: body.simulatorRuntime,
    });

    // Notify the Mac daemon to set up the workspace (build dir + simulator)
    try {
      const setupRes = await fetch(
        `${CMUX_SERVER_URL}/internal/resource-provider/${id}/setup-allocation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            allocationId,
            buildDir,
            simulatorDeviceType: body.simulatorDeviceType ?? "iPhone 16 Pro",
            simulatorRuntime: body.simulatorRuntime ?? "iOS-18-6",
          }),
        },
      );
      if (!setupRes.ok) {
        console.error("Failed to setup allocation on Mac daemon:", await setupRes.text());
      }
    } catch (error) {
      console.error("Failed to reach server for allocation setup:", error);
    }

    return c.json({ allocationId, buildDir }, 201);
  },
);

// POST /resource-providers/allocations/:allocationId/release - Release allocation
resourceProvidersRouter.openapi(
  createRoute({
    method: "post",
    path: "/resource-providers/allocations/{allocationId}/release",
    tags: ["ResourceProviders"],
    summary: "Release a resource allocation",
    request: {
      params: z.object({ allocationId: z.string() }),
    },
    responses: {
      200: {
        description: "Allocation released",
        content: {
          "application/json": { schema: z.object({ success: z.boolean() }) },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: {
        description: "Allocation not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const user = await getUserFromRequest(c.req.raw);
    if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);

    const { allocationId } = c.req.valid("param");
    const db = getDb();

    const allocation = getAllocationById(db, allocationId);
    if (!allocation) return c.json({ code: 404, message: "Allocation not found" }, 404);

    releaseAllocation(db, allocationId);

    // Notify Mac daemon to clean up
    try {
      await fetch(
        `${CMUX_SERVER_URL}/internal/resource-provider/${allocation.resourceProviderId}/cleanup-allocation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            allocationId,
            buildDir: allocation.buildDir,
            simulatorUdid: allocation.simulatorUdid,
          }),
        },
      );
    } catch (error) {
      console.error("Failed to notify cleanup:", error);
    }

    return c.json({ success: true }, 200);
  },
);

// POST /resource-providers/allocations/:allocationId/mcp - Proxy MCP JSON-RPC
resourceProvidersRouter.openapi(
  createRoute({
    method: "post",
    path: "/resource-providers/allocations/{allocationId}/mcp",
    tags: ["ResourceProviders"],
    summary: "Proxy MCP JSON-RPC request to Mac daemon",
    request: {
      params: z.object({ allocationId: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object({
              jsonrpc: z.string(),
              method: z.string(),
              params: z.unknown().optional(),
              id: z.union([z.string(), z.number()]),
            }),
          },
        },
        required: true,
      },
    },
    responses: {
      200: {
        description: "MCP JSON-RPC response",
        content: {
          "application/json": {
            schema: z.object({
              jsonrpc: z.string(),
              result: z.unknown().optional(),
              error: z
                .object({
                  code: z.number(),
                  message: z.string(),
                  data: z.unknown().optional(),
                })
                .optional(),
              id: z.union([z.string(), z.number()]),
            }),
          },
        },
      },
      401: {
        description: "Unauthorized",
        content: { "application/json": { schema: ErrorResponse } },
      },
      404: {
        description: "Allocation not found",
        content: { "application/json": { schema: ErrorResponse } },
      },
      502: {
        description: "Provider unavailable",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    // Auth: either user auth or task run JWT
    const authHeader = c.req.header("Authorization");
    if (!authHeader) {
      const user = await getUserFromRequest(c.req.raw);
      if (!user) return c.json({ code: 401, message: "Unauthorized" }, 401);
    }

    const { allocationId } = c.req.valid("param");
    const jsonRpcRequest = c.req.valid("json");
    const db = getDb();

    const allocation = getAllocationById(db, allocationId);
    if (!allocation) return c.json({ code: 404, message: "Allocation not found" }, 404);
    if (allocation.status !== "active") {
      return c.json({ code: 404, message: "Allocation is not active" }, 404);
    }

    const provider = getById(db, allocation.resourceProviderId);
    if (!provider || provider.status !== "online") {
      return c.json({ code: 502, message: "Resource provider is offline" }, 502);
    }

    // Forward to the WebSocket hub in apps/server
    try {
      const res = await fetch(
        `${CMUX_SERVER_URL}/internal/resource-provider/${provider.id}/mcp`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            allocationId,
            request: jsonRpcRequest,
          }),
        },
      );

      if (!res.ok) {
        const errorText = await res.text();
        console.error("MCP proxy error:", errorText);
        return c.json({ code: 502, message: "Failed to reach resource provider" }, 502);
      }

      const response = await res.json();
      return c.json(response, 200);
    } catch (error) {
      console.error("MCP proxy error:", error);
      return c.json({ code: 502, message: "Failed to reach resource provider" }, 502);
    }
  },
);
