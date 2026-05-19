import { getUserFromRequest } from "@/lib/utils/auth";
import { getDb } from "@cmux/db";
import {
  listByTeam,
  getById,
  listActiveAllocationsByProvider,
  getAllocationById,
  isProviderAtCapacity,
} from "@cmux/db/queries/providers";
import {
  createProvider,
  updateProvider,
  deleteProvider,
  createAllocation,
  releaseAllocation,
  updateAllocationData,
} from "@cmux/db/mutations/providers";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { createHash, randomBytes } from "node:crypto";

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

function getIosProviderVmMcpUrl(provider: {
  metadata?: Record<string, unknown> | null;
}): string | undefined {
  const vmTailscaleHostname = provider.metadata?.vmTailscaleHostname;
  const vmMcpPort = provider.metadata?.vmMcpPort;
  if (typeof vmTailscaleHostname !== "string") {
    return undefined;
  }

  const hostname = vmTailscaleHostname.trim();
  if (!hostname) {
    return undefined;
  }

  const port =
    typeof vmMcpPort === "string" && vmMcpPort.trim().length > 0
      ? vmMcpPort.trim()
      : "4850";
  return `http://${hostname}:${port}`;
}

async function callIosVmJsonRpc(
  iosVmMcpUrl: string,
  method: string,
  params: Record<string, unknown>,
  id: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${iosVmMcpUrl}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id,
    }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const payload = await response.json() as {
    result?: Record<string, unknown>;
    error?: { message?: string };
  };
  if (payload.error) {
    throw new Error(payload.error.message ?? `VM MCP ${method} failed`);
  }
  return payload.result ?? {};
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
    if (isProviderAtCapacity(provider, activeAllocations.length)) {
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

    // For resource allocations, set up the workspace directly in the VM MCP server.
    if (body.type === "resource" && body.data) {
      try {
        const buildDir = body.data.buildDir ?? `/tmp/cmux-builds/${allocationId}`;
        const iosVmMcpUrl = getIosProviderVmMcpUrl(provider);
        if (!iosVmMcpUrl) {
          console.error(`Failed to derive VM MCP URL for provider ${provider.id}`);
        } else {
          const setupPayload = z.object({
            buildDir: z.string().optional(),
            simulatorUdid: z.string().optional(),
          }).parse(
            await callIosVmJsonRpc(
              iosVmMcpUrl,
              "setup_allocation",
              {
                allocationId,
                buildDir,
                simulatorDeviceType: body.data.simulatorDeviceType ?? "iPhone 16 Pro",
                simulatorRuntime:
                  body.data.simulatorRuntime ?? "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
                ...(typeof body.data.directToken === "string"
                  ? { accessToken: body.data.directToken }
                  : {}),
                ...(typeof body.data.rsyncEndpoint === "string" &&
                typeof body.data.rsyncSecret === "string"
                  ? {
                      rsyncEndpoint: body.data.rsyncEndpoint,
                      rsyncSecret: body.data.rsyncSecret,
                    }
                  : {}),
              },
              `vm-setup-${allocationId}`,
            ),
          );
          updateAllocationData(db, allocationId, {
            buildDir: setupPayload.buildDir ?? buildDir,
            ...(setupPayload.simulatorUdid
              ? { simulatorUdid: setupPayload.simulatorUdid }
              : {}),
          });
        }
      } catch (error) {
        console.error("Failed to set up allocation in VM:", error);
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

    // Notify the VM MCP server to clean up
    if (allocation.type === "resource" && allocation.data) {
      try {
        const data = allocation.data as Record<string, unknown>;
        const provider = getById(db, allocation.providerId);
        const iosVmMcpUrl = provider ? getIosProviderVmMcpUrl(provider) : undefined;
        if (iosVmMcpUrl) {
          await callIosVmJsonRpc(
            iosVmMcpUrl,
            "cleanup_allocation",
            {
              allocationId,
              buildDir: data.buildDir,
              simulatorUdid: data.simulatorUdid,
            },
            `vm-cleanup-${allocationId}`,
          );
        }
      } catch (error) {
        console.error("Failed to notify VM cleanup:", error);
      }
    }

    return c.json({ success: true }, 200);
  },
);
