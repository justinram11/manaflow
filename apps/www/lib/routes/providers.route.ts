import { getUserFromRequest } from "@/lib/utils/auth";
import { getDb } from "@cmux/db";
import {
  listByTeam,
  getById,
  listActiveAllocationsByProvider,
  getAllocationById,
} from "@cmux/db/queries/providers";
import {
  createProvider,
  updateProvider,
  deleteProvider,
  createAllocation,
  releaseAllocation,
} from "@cmux/db/mutations/providers";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createHash, randomBytes } from "node:crypto";

// For proxying JSON-RPC requests to the WebSocket hub in apps/server
const CMUX_SERVER_URL = process.env.CMUX_SERVER_INTERNAL_URL ?? "http://localhost:3001";

export const providersRouter = new OpenAPIHono();

const ErrorResponse = z
  .object({
    code: z.number(),
    message: z.string(),
  })
  .openapi("ProviderErrorResponse");

const TeamQuery = z
  .object({
    teamSlugOrId: z.string(),
  })
  .openapi("ProviderTeamQuery");

const ProviderSchema = z
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
    maxConcurrentSlots: z.number().nullable().optional(),
    status: z.string(),
    lastHeartbeatAt: z.number().nullable().optional(),
    metadata: z.record(z.string(), z.string()).nullable().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .openapi("Provider");

const ProviderAllocationSchema = z
  .object({
    id: z.string(),
    providerId: z.string(),
    taskRunId: z.string().nullable().optional(),
    teamId: z.string(),
    userId: z.string(),
    type: z.string(),
    status: z.string(),
    data: z.record(z.string(), z.unknown()).nullable().optional(),
    createdAt: z.number(),
    releasedAt: z.number().nullable().optional(),
  })
  .openapi("ProviderAllocation");

const CreateProviderBody = z
  .object({
    teamSlugOrId: z.string(),
    name: z.string().min(1).max(200),
    platform: z.string().default("linux"),
    arch: z.string().default("arm64"),
  })
  .openapi("CreateProviderBody");

const UpdateProviderBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    maxConcurrentSlots: z.number().int().min(1).max(20).optional(),
  })
  .openapi("UpdateProviderBody");

const AllocateBody = z
  .object({
    taskRunId: z.string().optional(),
    teamSlugOrId: z.string(),
    type: z.enum(["compute", "resource"]),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("AllocateProviderBody");

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// POST /providers/register - Register new provider
providersRouter.openapi(
  createRoute({
    method: "post",
    path: "/providers/register",
    tags: ["Providers"],
    summary: "Register a new provider",
    request: {
      body: {
        content: { "application/json": { schema: CreateProviderBody } },
        required: true,
      },
    },
    responses: {
      201: {
        description: "Provider created",
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

    const { id } = createProvider(db, {
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

// GET /providers - List providers for team
providersRouter.openapi(
  createRoute({
    method: "get",
    path: "/providers",
    tags: ["Providers"],
    summary: "List providers for team",
    request: {
      query: TeamQuery.extend({
        capability: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: "List of providers",
        content: {
          "application/json": {
            schema: z.object({
              providers: z.array(
                ProviderSchema.extend({
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
    let providerList = listByTeam(db, query.teamSlugOrId);

    // Filter by capability if specified
    if (query.capability) {
      const cap = query.capability;
      providerList = providerList.filter((p: { capabilities: string[] | null }) =>
        p.capabilities?.includes(cap),
      );
    }

    const providersWithCounts = providerList.map((p: { id: string; [key: string]: unknown }) => {
      const active = listActiveAllocationsByProvider(db, p.id);
      return { ...p, activeAllocations: active.length };
    });

    return c.json({ providers: providersWithCounts }, 200);
  },
);

// GET /providers/:id - Provider details
providersRouter.openapi(
  createRoute({
    method: "get",
    path: "/providers/{id}",
    tags: ["Providers"],
    summary: "Get provider details",
    request: {
      params: z.object({ id: z.string() }),
    },
    responses: {
      200: {
        description: "Provider details",
        content: {
          "application/json": {
            schema: z.object({
              provider: ProviderSchema,
              allocations: z.array(ProviderAllocationSchema),
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

// PATCH /providers/:id - Update provider
providersRouter.openapi(
  createRoute({
    method: "patch",
    path: "/providers/{id}",
    tags: ["Providers"],
    summary: "Update provider",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: { "application/json": { schema: UpdateProviderBody } },
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

    updateProvider(db, id, body);
    return c.json({ success: true }, 200);
  },
);

// DELETE /providers/:id - Deregister provider
providersRouter.openapi(
  createRoute({
    method: "delete",
    path: "/providers/{id}",
    tags: ["Providers"],
    summary: "Deregister provider",
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

    deleteProvider(db, id);
    return c.body(null, 204);
  },
);

// POST /providers/:id/allocate - Create allocation slot
providersRouter.openapi(
  createRoute({
    method: "post",
    path: "/providers/{id}/allocate",
    tags: ["Providers"],
    summary: "Allocate a provider slot for a workspace",
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
    if (activeAllocations.length >= (provider.maxConcurrentSlots ?? 4)) {
      return c.json({ code: 409, message: "Provider at maximum capacity" }, 409);
    }

    const { id: allocationId } = createAllocation(db, {
      providerId: id,
      taskRunId: body.taskRunId,
      teamSlugOrId: body.teamSlugOrId,
      userId: user.id,
      type: body.type,
      data: body.data,
    });

    // For resource allocations, notify the daemon to set up the workspace
    if (body.type === "resource" && body.data) {
      try {
        const setupRes = await fetch(
          `${CMUX_SERVER_URL}/internal/provider/${id}/setup-allocation`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              allocationId,
              buildDir: body.data.buildDir ?? `/tmp/cmux-builds/${allocationId}`,
              simulatorDeviceType: body.data.simulatorDeviceType ?? "iPhone 16 Pro",
              simulatorRuntime: body.data.simulatorRuntime ?? "iOS-18-6",
            }),
          },
        );
        if (!setupRes.ok) {
          console.error("Failed to setup allocation on daemon:", await setupRes.text());
        }
      } catch (error) {
        console.error("Failed to reach server for allocation setup:", error);
      }
    }

    return c.json({ allocationId }, 201);
  },
);

// POST /providers/allocations/:id/release - Release allocation
providersRouter.openapi(
  createRoute({
    method: "post",
    path: "/providers/allocations/{allocationId}/release",
    tags: ["Providers"],
    summary: "Release a provider allocation",
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

    // Notify daemon to clean up
    if (allocation.type === "resource" && allocation.data) {
      try {
        const data = allocation.data as Record<string, unknown>;
        await fetch(
          `${CMUX_SERVER_URL}/internal/provider/${allocation.providerId}/cleanup-allocation`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              allocationId,
              buildDir: data.buildDir,
              simulatorUdid: data.simulatorUdid,
            }),
          },
        );
      } catch (error) {
        console.error("Failed to notify cleanup:", error);
      }
    }

    return c.json({ success: true }, 200);
  },
);

// POST /providers/allocations/:id/json-rpc - Proxy JSON-RPC to provider
providersRouter.openapi(
  createRoute({
    method: "post",
    path: "/providers/allocations/{allocationId}/json-rpc",
    tags: ["Providers"],
    summary: "Proxy JSON-RPC request to provider daemon",
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
        description: "JSON-RPC response",
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

    const provider = getById(db, allocation.providerId);
    if (!provider || provider.status !== "online") {
      return c.json({ code: 502, message: "Provider is offline" }, 502);
    }

    // Forward to the WebSocket hub in apps/server
    try {
      const res = await fetch(
        `${CMUX_SERVER_URL}/internal/provider/${provider.id}/json-rpc`,
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
        console.error("JSON-RPC proxy error:", errorText);
        return c.json({ code: 502, message: "Failed to reach provider" }, 502);
      }

      const response = await res.json();
      return c.json(response, 200);
    } catch (error) {
      console.error("JSON-RPC proxy error:", error);
      return c.json({ code: 502, message: "Failed to reach provider" }, 502);
    }
  },
);
