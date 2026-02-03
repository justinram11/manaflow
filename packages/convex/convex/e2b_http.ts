import { httpAction, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { FunctionReference } from "convex/server";

const JSON_HEADERS = {
  "Content-Type": "application/json",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Verify content type is JSON
 */
function verifyContentType(req: Request): Response | null {
  const contentType = req.headers.get("content-type") ?? "";
  if (
    req.method !== "GET" &&
    !contentType.toLowerCase().includes("application/json")
  ) {
    return jsonResponse(
      { code: 415, message: "Content-Type must be application/json" },
      415
    );
  }
  return null;
}

/**
 * Get authenticated user identity from Convex auth.
 */
async function getAuthenticatedUser(
  ctx: ActionCtx
): Promise<{
  identity: { subject: string; name?: string; email?: string } | null;
  error: Response | null;
}> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return {
      identity: null,
      error: jsonResponse({ code: 401, message: "Unauthorized" }, 401),
    };
  }
  return { identity, error: null };
}

// Type-safe references to devboxInstances functions
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const devboxApi = (api as any).devboxInstances as {
  create: FunctionReference<"mutation", "public">;
  list: FunctionReference<"query", "public">;
  getByProviderInstanceId: FunctionReference<"query", "public">;
  updateStatus: FunctionReference<"mutation", "public">;
  recordAccess: FunctionReference<"mutation", "public">;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const e2bActionsApi = (internal as any).e2b_actions as {
  startInstance: FunctionReference<"action", "internal">;
  getInstance: FunctionReference<"action", "internal">;
  execCommand: FunctionReference<"action", "internal">;
  extendTimeout: FunctionReference<"action", "internal">;
  stopInstance: FunctionReference<"action", "internal">;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const e2bInstancesApi = (internal as any).e2bInstances as {
  recordResumeInternal: FunctionReference<"mutation", "internal">;
  recordPauseInternal: FunctionReference<"mutation", "internal">;
  recordStopInternal: FunctionReference<"mutation", "internal">;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const devboxInternalApi = (internal as any).devboxInstances as {
  getByIdInternal: FunctionReference<"query", "internal">;
  getInfo: FunctionReference<"query", "internal">;
};

/**
 * Resolve an instance ID to E2B provider instance ID.
 * Accepts either cmux_xxx (devboxId) or raw E2B instance ID.
 */
async function resolveToE2BInstanceId(
  ctx: ActionCtx,
  id: string
): Promise<{ e2bInstanceId: string; devboxId: string } | null> {
  // If it's a cmux_ ID, look up the provider instance ID
  if (id.startsWith("cmux_") || id.startsWith("dba_")) {
    const instance = await ctx.runQuery(devboxInternalApi.getByIdInternal, { id });
    if (!instance) return null;

    const info = await ctx.runQuery(devboxInternalApi.getInfo, { devboxId: id });
    if (!info || info.provider !== "e2b") return null;

    return { e2bInstanceId: info.providerInstanceId, devboxId: id };
  }

  // Otherwise, assume it's already an E2B instance ID
  return { e2bInstanceId: id, devboxId: "" };
}

// ============================================================================
// POST /api/v1/e2b/instances - Create a new E2B instance
// ============================================================================
export const createInstance = httpAction(async (ctx, req) => {
  const contentTypeError = verifyContentType(req);
  if (contentTypeError) return contentTypeError;

  const { identity, error } = await getAuthenticatedUser(ctx);
  if (error) return error;

  let body: {
    teamSlugOrId: string;
    templateId?: string;
    name?: string;
    ttlSeconds?: number;
    metadata?: Record<string, string>;
    envs?: Record<string, string>;
  };

  try {
    body = await req.json();
  } catch {
    return jsonResponse({ code: 400, message: "Invalid JSON body" }, 400);
  }

  if (!body.teamSlugOrId) {
    return jsonResponse(
      { code: 400, message: "teamSlugOrId is required" },
      400
    );
  }

  try {
    // Start a new E2B sandbox via internal action
    const result = await ctx.runAction(e2bActionsApi.startInstance, {
      templateId: body.templateId,
      ttlSeconds: body.ttlSeconds ?? 60 * 60,
      metadata: {
        app: "cmux-e2b",
        userId: identity!.subject,
        ...(body.metadata || {}),
      },
      envs: body.envs,
    });

    // Store the instance in Convex
    const instanceId = await ctx.runMutation(devboxApi.create, {
      teamSlugOrId: body.teamSlugOrId,
      providerInstanceId: result.instanceId,
      provider: "e2b",
      name: body.name,
      templateId: body.templateId,
      vscodeUrl: result.vscodeUrl,
      workerUrl: result.workerUrl,
      metadata: body.metadata,
    });

    return jsonResponse({
      id: instanceId,
      e2bInstanceId: result.instanceId,
      status: result.status,
      vscodeUrl: result.vscodeUrl,
      workerUrl: result.workerUrl,
      vncUrl: result.vncUrl,
    });
  } catch (error) {
    console.error("[e2b.create] Error:", error);
    return jsonResponse(
      { code: 500, message: "Failed to create E2B instance" },
      500
    );
  }
});

// ============================================================================
// GET /api/v1/e2b/instances - List E2B instances
// ============================================================================
export const listInstances = httpAction(async (ctx, req) => {
  const { error } = await getAuthenticatedUser(ctx);
  if (error) return error;

  const url = new URL(req.url);
  const teamSlugOrId = url.searchParams.get("teamSlugOrId");

  if (!teamSlugOrId) {
    return jsonResponse(
      { code: 400, message: "teamSlugOrId query parameter is required" },
      400
    );
  }

  try {
    const instances = await ctx.runQuery(devboxApi.list, {
      teamSlugOrId,
      provider: "e2b",
    });

    return jsonResponse({ instances });
  } catch (error) {
    console.error("[e2b.list] Error:", error);
    return jsonResponse(
      { code: 500, message: "Failed to list instances" },
      500
    );
  }
});

// ============================================================================
// Handler logic for instance-specific routes
// ============================================================================

async function handleGetInstance(
  ctx: ActionCtx,
  instanceId: string,
  teamSlugOrId: string
): Promise<Response> {
  try {
    // Resolve to E2B instance ID
    const resolved = await resolveToE2BInstanceId(ctx, instanceId);
    if (!resolved) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }
    const { e2bInstanceId } = resolved;

    // Get instance from Convex
    const instance = await ctx.runQuery(devboxApi.getByProviderInstanceId, {
      teamSlugOrId,
      providerInstanceId: e2bInstanceId,
      provider: "e2b",
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    // Get fresh status from E2B via internal action
    const e2bResult = await ctx.runAction(e2bActionsApi.getInstance, {
      instanceId: e2bInstanceId,
    });

    const status = e2bResult.status as "running" | "stopped";

    // Update status in Convex if changed
    if (status !== instance.status) {
      await ctx.runMutation(devboxApi.updateStatus, {
        teamSlugOrId,
        providerInstanceId: e2bInstanceId,
        provider: "e2b",
        status,
      });
    }

    return jsonResponse({
      ...instance,
      status,
      vscodeUrl: e2bResult.vscodeUrl ?? instance.vscodeUrl,
      workerUrl: e2bResult.workerUrl ?? instance.workerUrl,
      vncUrl: e2bResult.vncUrl,
    });
  } catch (error) {
    console.error("[e2b.get] Error:", error);
    return jsonResponse({ code: 500, message: "Failed to get instance" }, 500);
  }
}

async function handleExecCommand(
  ctx: ActionCtx,
  instanceId: string,
  teamSlugOrId: string,
  command: string
): Promise<Response> {
  try {
    // Resolve to E2B instance ID
    const resolved = await resolveToE2BInstanceId(ctx, instanceId);
    if (!resolved) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }
    const { e2bInstanceId } = resolved;

    // Verify the user owns this instance
    const instance = await ctx.runQuery(devboxApi.getByProviderInstanceId, {
      teamSlugOrId,
      providerInstanceId: e2bInstanceId,
      provider: "e2b",
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    // Execute command via internal action
    const result = await ctx.runAction(e2bActionsApi.execCommand, {
      instanceId: e2bInstanceId,
      command,
    });

    // Record access
    await ctx.runMutation(devboxApi.recordAccess, {
      teamSlugOrId,
      providerInstanceId: e2bInstanceId,
      provider: "e2b",
    });

    return jsonResponse(result);
  } catch (error) {
    console.error("[e2b.exec] Error:", error);
    return jsonResponse(
      { code: 500, message: "Failed to execute command" },
      500
    );
  }
}

async function handleExtendTimeout(
  ctx: ActionCtx,
  instanceId: string,
  teamSlugOrId: string,
  timeoutMs?: number
): Promise<Response> {
  try {
    // Resolve to E2B instance ID
    const resolved = await resolveToE2BInstanceId(ctx, instanceId);
    if (!resolved) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }
    const { e2bInstanceId } = resolved;

    // Verify the user owns this instance
    const instance = await ctx.runQuery(devboxApi.getByProviderInstanceId, {
      teamSlugOrId,
      providerInstanceId: e2bInstanceId,
      provider: "e2b",
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    // Extend timeout via internal action
    const result = await ctx.runAction(e2bActionsApi.extendTimeout, {
      instanceId: e2bInstanceId,
      timeoutMs,
    });

    // Record as "pause" activity (timeout extension)
    await ctx.runMutation(e2bInstancesApi.recordPauseInternal, {
      instanceId: e2bInstanceId,
    });

    return jsonResponse(result);
  } catch (error) {
    console.error("[e2b.extend] Error:", error);
    return jsonResponse(
      { code: 500, message: "Failed to extend timeout" },
      500
    );
  }
}

async function handleStopInstance(
  ctx: ActionCtx,
  instanceId: string,
  teamSlugOrId: string
): Promise<Response> {
  try {
    // Resolve to E2B instance ID
    const resolved = await resolveToE2BInstanceId(ctx, instanceId);
    if (!resolved) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }
    const { e2bInstanceId } = resolved;

    // Verify the user owns this instance
    const instance = await ctx.runQuery(devboxApi.getByProviderInstanceId, {
      teamSlugOrId,
      providerInstanceId: e2bInstanceId,
      provider: "e2b",
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    // Stop (kill) via internal action
    await ctx.runAction(e2bActionsApi.stopInstance, {
      instanceId: e2bInstanceId,
    });

    // Update status in Convex
    await ctx.runMutation(devboxApi.updateStatus, {
      teamSlugOrId,
      providerInstanceId: e2bInstanceId,
      provider: "e2b",
      status: "stopped",
    });

    // Record stop activity
    await ctx.runMutation(e2bInstancesApi.recordStopInternal, {
      instanceId: e2bInstanceId,
    });

    return jsonResponse({ stopped: true });
  } catch (error) {
    console.error("[e2b.stop] Error:", error);
    return jsonResponse({ code: 500, message: "Failed to stop instance" }, 500);
  }
}

// ============================================================================
// Route handler for instance-specific POST actions
// ============================================================================
export const instanceActionRouter = httpAction(async (ctx, req) => {
  const contentTypeError = verifyContentType(req);
  if (contentTypeError) return contentTypeError;

  const { error } = await getAuthenticatedUser(ctx);
  if (error) return error;

  const url = new URL(req.url);
  const path = url.pathname;
  const pathParts = path.split("/");
  // Path: /api/v1/e2b/instances/{id}/{action}
  const e2bInstanceId = pathParts[pathParts.length - 2];

  let body: {
    teamSlugOrId: string;
    command?: string;
    timeoutMs?: number;
  };

  try {
    body = await req.json();
  } catch {
    return jsonResponse({ code: 400, message: "Invalid JSON body" }, 400);
  }

  if (!body.teamSlugOrId) {
    return jsonResponse(
      { code: 400, message: "teamSlugOrId is required" },
      400
    );
  }

  // Route based on the action suffix
  if (path.endsWith("/exec")) {
    if (!body.command) {
      return jsonResponse({ code: 400, message: "command is required" }, 400);
    }
    return handleExecCommand(
      ctx,
      e2bInstanceId,
      body.teamSlugOrId,
      body.command
    );
  } else if (path.endsWith("/extend")) {
    // E2B doesn't have pause, use extend timeout instead
    return handleExtendTimeout(ctx, e2bInstanceId, body.teamSlugOrId, body.timeoutMs);
  } else if (path.endsWith("/stop")) {
    return handleStopInstance(ctx, e2bInstanceId, body.teamSlugOrId);
  }

  return jsonResponse({ code: 404, message: "Not found" }, 404);
});

// ============================================================================
// Route handler for instance-specific GET actions
// ============================================================================
export const instanceGetRouter = httpAction(async (ctx, req) => {
  const { error } = await getAuthenticatedUser(ctx);
  if (error) return error;

  const url = new URL(req.url);
  const path = url.pathname;
  const teamSlugOrId = url.searchParams.get("teamSlugOrId");

  if (!teamSlugOrId) {
    return jsonResponse(
      { code: 400, message: "teamSlugOrId query parameter is required" },
      400
    );
  }

  // Default: get instance details
  const pathParts = path.split("/");
  const e2bInstanceId = pathParts[pathParts.length - 1];
  return handleGetInstance(ctx, e2bInstanceId, teamSlugOrId);
});

// ============================================================================
// GET /api/v1/e2b/templates - List available E2B templates
// ============================================================================
export const listTemplates = httpAction(async (ctx) => {
  const { error } = await getAuthenticatedUser(ctx);
  if (error) return error;

  // Return static list of available templates
  // In the future, this could be fetched from E2B API or a database
  const templates = [
    {
      id: "base",
      name: "Base Template",
      description: "Default E2B base template",
    },
    {
      id: "cmux-devbox",
      name: "CMUX Devbox",
      description: "Pre-configured template for cmux workspaces with VSCode and tools",
    },
  ];

  return jsonResponse({ templates });
});
