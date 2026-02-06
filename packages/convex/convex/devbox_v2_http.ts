/**
 * v2/devbox HTTP API - E2B devbox management.
 *
 * This API uses E2B as the backend provider.
 * All endpoints require Stack Auth authentication.
 * Instance data is tracked in devboxInstances table, with provider info in devboxInfo.
 */
import { httpAction, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { FunctionReference } from "convex/server";
import {
  DEFAULT_E2B_TEMPLATE_ID,
  E2B_TEMPLATE_PRESETS,
} from "@cmux/shared/e2b-templates";

const JSON_HEADERS = {
  "Content-Type": "application/json",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Verify content type is JSON for non-GET requests
 */
function verifyContentType(req: Request): Response | null {
  const contentType = req.headers.get("content-type") ?? "";
  if (
    req.method !== "GET" &&
    req.method !== "DELETE" &&
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
  getById: FunctionReference<"query", "public">;
  updateStatus: FunctionReference<"mutation", "public">;
  recordAccess: FunctionReference<"mutation", "public">;
  remove: FunctionReference<"mutation", "public">;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const devboxInternalApi = (internal as any).devboxInstances as {
  getInfo: FunctionReference<"query", "internal">;
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

/**
 * Record activity for an E2B instance
 */
async function recordE2BActivity(
  ctx: ActionCtx,
  providerInstanceId: string,
  action: "resume" | "pause" | "stop"
): Promise<void> {
  try {
    if (action === "resume") {
      await ctx.runMutation(e2bInstancesApi.recordResumeInternal, {
        instanceId: providerInstanceId,
      });
    } else if (action === "pause") {
      await ctx.runMutation(e2bInstancesApi.recordPauseInternal, {
        instanceId: providerInstanceId,
      });
    } else if (action === "stop") {
      await ctx.runMutation(e2bInstancesApi.recordStopInternal, {
        instanceId: providerInstanceId,
      });
    }
  } catch (error) {
    console.error("[devbox_v2] Failed to record activity:", error);
  }
}

/**
 * Get the provider instance ID for a devbox ID
 */
async function getProviderInstanceId(
  ctx: ActionCtx,
  devboxId: string
): Promise<string | null> {
  const info = (await ctx.runQuery(devboxInternalApi.getInfo, {
    devboxId,
  })) as { provider: string; providerInstanceId: string } | null;
  return info?.providerInstanceId ?? null;
}

// ============================================================================
// POST /api/v2/devbox/instances - Start a new E2B instance
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
    const templateId = body.templateId ?? DEFAULT_E2B_TEMPLATE_ID;

    // Start E2B instance via internal action
    const result = (await ctx.runAction(e2bActionsApi.startInstance, {
      templateId,
      ttlSeconds: body.ttlSeconds ?? 60 * 60,
      metadata: {
        app: "cmux-devbox-v2",
        userId: identity!.subject,
        ...(body.metadata || {}),
      },
      envs: body.envs,
    })) as {
      instanceId: string;
      status: string;
      vscodeUrl?: string;
      workerUrl?: string;
      vncUrl?: string;
    };

    // Store in Convex
    const instanceResult = (await ctx.runMutation(devboxApi.create, {
      teamSlugOrId: body.teamSlugOrId,
      providerInstanceId: result.instanceId,
      provider: "e2b",
      name: body.name,
      templateId,
      vscodeUrl: result.vscodeUrl,
      workerUrl: result.workerUrl,
      metadata: body.metadata,
      source: "cli",
    })) as { id: string; isExisting: boolean };

    return jsonResponse({
      id: instanceResult.id,
      provider: "e2b",
      status: result.status,
      templateId,
      vscodeUrl: result.vscodeUrl,
      workerUrl: result.workerUrl,
      vncUrl: result.vncUrl,
    });
  } catch (error) {
    console.error("[devbox_v2.create] Error:", error);
    return jsonResponse(
      { code: 500, message: "Failed to create instance" },
      500
    );
  }
});

// ============================================================================
// GET /api/v2/devbox/instances - List instances
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
    const rawInstances = (await ctx.runQuery(devboxApi.list, {
      teamSlugOrId,
      provider: "e2b",
    })) as Array<{
      devboxId: string;
      status: string;
      name?: string;
      createdAt: number;
      updatedAt: number;
    }>;

    const instances = rawInstances.map((inst) => ({
      id: inst.devboxId,
      status: inst.status,
      name: inst.name,
      createdAt: inst.createdAt,
      updatedAt: inst.updatedAt,
    }));

    return jsonResponse({ instances });
  } catch (error) {
    console.error("[devbox_v2.list] Error:", error);
    return jsonResponse(
      { code: 500, message: "Failed to list instances" },
      500
    );
  }
});

// ============================================================================
// GET /api/v2/devbox/instances/{id} - Get instance details
// ============================================================================
async function handleGetInstance(
  ctx: ActionCtx,
  id: string,
  teamSlugOrId: string
): Promise<Response> {
  try {
    const instance = (await ctx.runQuery(devboxApi.getById, {
      teamSlugOrId,
      id,
    })) as { id: string; status: string; name?: string } | null;

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    const providerInstanceId = await getProviderInstanceId(ctx, id);
    if (!providerInstanceId) {
      return jsonResponse({
        id,
        provider: "e2b",
        status: instance.status,
        name: instance.name,
      });
    }

    const e2bResult = (await ctx.runAction(e2bActionsApi.getInstance, {
      instanceId: providerInstanceId,
    })) as {
      instanceId: string;
      status: string;
      vscodeUrl?: string | null;
      workerUrl?: string | null;
      vncUrl?: string | null;
    };

    const status = e2bResult.status as "running" | "stopped";

    if (status !== instance.status) {
      await ctx.runMutation(devboxApi.updateStatus, {
        teamSlugOrId,
        id,
        status,
      });
    }

    return jsonResponse({
      id,
      provider: "e2b",
      status,
      name: instance.name,
      vscodeUrl: e2bResult.vscodeUrl ?? undefined,
      workerUrl: e2bResult.workerUrl ?? undefined,
      vncUrl: e2bResult.vncUrl ?? undefined,
    });
  } catch (error) {
    console.error("[devbox_v2.get] Error:", error);
    return jsonResponse({ code: 500, message: "Failed to get instance" }, 500);
  }
}

// ============================================================================
// POST /api/v2/devbox/instances/{id}/exec - Execute command
// ============================================================================
async function handleExecCommand(
  ctx: ActionCtx,
  id: string,
  teamSlugOrId: string,
  command: string | string[]
): Promise<Response> {
  try {
    const instance = await ctx.runQuery(devboxApi.getById, {
      teamSlugOrId,
      id,
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    const providerInstanceId = await getProviderInstanceId(ctx, id);
    if (!providerInstanceId) {
      return jsonResponse(
        { code: 404, message: "Provider mapping not found" },
        404
      );
    }

    const commandStr = Array.isArray(command) ? command.join(" ") : command;
    const result = await ctx.runAction(e2bActionsApi.execCommand, {
      instanceId: providerInstanceId,
      command: commandStr,
    });

    await ctx.runMutation(devboxApi.recordAccess, { teamSlugOrId, id });
    return jsonResponse(result);
  } catch (error) {
    console.error("[devbox_v2.exec] Error:", error);
    return jsonResponse(
      { code: 500, message: "Failed to execute command" },
      500
    );
  }
}

// ============================================================================
// POST /api/v2/devbox/instances/{id}/pause - Pause instance
// ============================================================================
async function handlePauseInstance(
  ctx: ActionCtx,
  id: string,
  teamSlugOrId: string
): Promise<Response> {
  try {
    const instance = await ctx.runQuery(devboxApi.getById, {
      teamSlugOrId,
      id,
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    const providerInstanceId = await getProviderInstanceId(ctx, id);
    if (!providerInstanceId) {
      return jsonResponse(
        { code: 404, message: "Provider mapping not found" },
        404
      );
    }

    // E2B doesn't have pause, extend timeout instead
    await ctx.runAction(e2bActionsApi.extendTimeout, {
      instanceId: providerInstanceId,
      timeoutMs: 60 * 60 * 1000, // 1 hour
    });

    await ctx.runMutation(devboxApi.updateStatus, {
      teamSlugOrId,
      id,
      status: "paused",
    });

    await recordE2BActivity(ctx, providerInstanceId, "pause");

    return jsonResponse({
      paused: true,
      provider: "e2b",
      note: "E2B timeout extended (no true pause)",
    });
  } catch (error) {
    console.error("[devbox_v2.pause] Error:", error);
    return jsonResponse(
      { code: 500, message: "Failed to pause instance" },
      500
    );
  }
}

// ============================================================================
// POST /api/v2/devbox/instances/{id}/resume - Resume instance
// ============================================================================
async function handleResumeInstance(
  ctx: ActionCtx,
  id: string,
  teamSlugOrId: string
): Promise<Response> {
  try {
    const instance = await ctx.runQuery(devboxApi.getById, {
      teamSlugOrId,
      id,
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    const providerInstanceId = await getProviderInstanceId(ctx, id);
    if (!providerInstanceId) {
      return jsonResponse(
        { code: 404, message: "Provider mapping not found" },
        404
      );
    }

    // E2B doesn't have pause/resume, just update status
    await ctx.runMutation(devboxApi.updateStatus, {
      teamSlugOrId,
      id,
      status: "running",
    });

    await recordE2BActivity(ctx, providerInstanceId, "resume");

    return jsonResponse({
      resumed: true,
      provider: "e2b",
      note: "E2B status updated (already running)",
    });
  } catch (error) {
    console.error("[devbox_v2.resume] Error:", error);
    return jsonResponse(
      { code: 500, message: "Failed to resume instance" },
      500
    );
  }
}

// ============================================================================
// POST /api/v2/devbox/instances/{id}/stop - Stop instance
// ============================================================================
async function handleStopInstance(
  ctx: ActionCtx,
  id: string,
  teamSlugOrId: string
): Promise<Response> {
  try {
    const instance = await ctx.runQuery(devboxApi.getById, {
      teamSlugOrId,
      id,
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    const providerInstanceId = await getProviderInstanceId(ctx, id);
    if (!providerInstanceId) {
      return jsonResponse(
        { code: 404, message: "Provider mapping not found" },
        404
      );
    }

    await ctx.runAction(e2bActionsApi.stopInstance, {
      instanceId: providerInstanceId,
    });

    await ctx.runMutation(devboxApi.updateStatus, {
      teamSlugOrId,
      id,
      status: "stopped",
    });

    await recordE2BActivity(ctx, providerInstanceId, "stop");

    return jsonResponse({ stopped: true, provider: "e2b" });
  } catch (error) {
    console.error("[devbox_v2.stop] Error:", error);
    return jsonResponse({ code: 500, message: "Failed to stop instance" }, 500);
  }
}

// ============================================================================
// POST /api/v2/devbox/instances/{id}/ttl - Update TTL
// ============================================================================
async function handleUpdateTtl(
  ctx: ActionCtx,
  id: string,
  teamSlugOrId: string,
  ttlSeconds: number
): Promise<Response> {
  try {
    const instance = await ctx.runQuery(devboxApi.getById, {
      teamSlugOrId,
      id,
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    const providerInstanceId = await getProviderInstanceId(ctx, id);
    if (!providerInstanceId) {
      return jsonResponse(
        { code: 404, message: "Provider mapping not found" },
        404
      );
    }

    await ctx.runAction(e2bActionsApi.extendTimeout, {
      instanceId: providerInstanceId,
      timeoutMs: ttlSeconds * 1000,
    });

    return jsonResponse({ updated: true, ttlSeconds, provider: "e2b" });
  } catch (error) {
    console.error("[devbox_v2.ttl] Error:", error);
    return jsonResponse({ code: 500, message: "Failed to update TTL" }, 500);
  }
}

// ============================================================================
// GET /api/v2/devbox/config - Get configuration
// ============================================================================
export const getConfig = httpAction(async (ctx) => {
  const { error } = await getAuthenticatedUser(ctx);
  if (error) return error;

  return jsonResponse({
    provider: "e2b",
    defaultTemplateId: DEFAULT_E2B_TEMPLATE_ID,
  });
});

// ============================================================================
// GET /api/v2/devbox/me - Get current user profile
// ============================================================================
export const getMe = httpAction(async (ctx) => {
  const { identity, error } = await getAuthenticatedUser(ctx);
  if (error) return error;

  try {
    const userId = identity!.subject;

    const user = await ctx.runQuery(internal.users.getByUserIdInternal, {
      userId,
    });

    const memberships = await ctx.runQuery(
      internal.teams.getMembershipsByUserIdInternal,
      {
        userId,
      }
    );

    let teamId: string | null = null;
    let teamSlug: string | null = null;
    let teamDisplayName: string | null = null;

    if (user?.selectedTeamId) {
      const hasMembership = memberships.some(
        (m) => m.teamId === user.selectedTeamId
      );
      if (hasMembership) {
        const team = await ctx.runQuery(internal.teams.getByTeamIdInternal, {
          teamId: user.selectedTeamId,
        });
        if (team) {
          teamId = user.selectedTeamId;
          teamSlug = team.slug ?? team.uuid;
          teamDisplayName = team.displayName ?? team.name ?? null;
        }
      }
    }

    if (!teamId && memberships.length > 0) {
      const firstMembership = memberships[0];
      const team = await ctx.runQuery(internal.teams.getByTeamIdInternal, {
        teamId: firstMembership.teamId,
      });
      if (team) {
        teamId = firstMembership.teamId;
        teamSlug = team.slug ?? team.uuid;
        teamDisplayName = team.displayName ?? team.name ?? null;
      } else {
        teamId = firstMembership.teamId;
        teamSlug = firstMembership.teamId;
      }
    }

    return jsonResponse({
      userId,
      email: user?.primaryEmail ?? identity!.email,
      name: user?.displayName ?? identity!.name,
      teamId,
      teamSlug,
      teamDisplayName,
    });
  } catch (err) {
    console.error("[devbox_v2.me] Error:", err);
    return jsonResponse(
      { code: 500, message: "Failed to get user profile" },
      500
    );
  }
});

// ============================================================================
// POST /api/v2/devbox/instances/{id}/token - Get auth token
// ============================================================================
async function handleGetAuthToken(
  ctx: ActionCtx,
  id: string,
  teamSlugOrId: string
): Promise<Response> {
  try {
    const instance = await ctx.runQuery(devboxApi.getById, {
      teamSlugOrId,
      id,
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    const providerInstanceId = await getProviderInstanceId(ctx, id);
    if (!providerInstanceId) {
      return jsonResponse(
        { code: 404, message: "Provider mapping not found" },
        404
      );
    }

    const result = (await ctx.runAction(e2bActionsApi.execCommand, {
      instanceId: providerInstanceId,
      command: "cat /home/user/.worker-auth-token 2>/dev/null || echo ''",
    })) as { stdout?: string; stderr?: string; exit_code?: number };

    const token = result.stdout?.trim() || "";
    if (!token) {
      return jsonResponse(
        { code: 503, message: "Auth token not yet available" },
        503
      );
    }

    return jsonResponse({ token });
  } catch (error) {
    console.error("[devbox_v2.token] Error:", error);
    return jsonResponse(
      { code: 500, message: "Failed to get auth token" },
      500
    );
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

  const pathParts = path.split("/").filter(Boolean);
  const id = pathParts[4]; // instances/{id}
  const action = pathParts[5]; // {action}

  let body: {
    teamSlugOrId: string;
    command?: string | string[];
    timeout?: number;
    ttlSeconds?: number;
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

  switch (action) {
    case "exec":
      if (!body.command) {
        return jsonResponse({ code: 400, message: "command is required" }, 400);
      }
      return handleExecCommand(ctx, id, body.teamSlugOrId, body.command);

    case "pause":
      return handlePauseInstance(ctx, id, body.teamSlugOrId);

    case "resume":
      return handleResumeInstance(ctx, id, body.teamSlugOrId);

    case "stop":
      return handleStopInstance(ctx, id, body.teamSlugOrId);

    case "ttl":
      if (!body.ttlSeconds) {
        return jsonResponse(
          { code: 400, message: "ttlSeconds is required" },
          400
        );
      }
      return handleUpdateTtl(ctx, id, body.teamSlugOrId, body.ttlSeconds);

    case "token":
      return handleGetAuthToken(ctx, id, body.teamSlugOrId);

    case "extend":
      return handleUpdateTtl(
        ctx,
        id,
        body.teamSlugOrId,
        body.ttlSeconds ?? 3600
      );

    default:
      return jsonResponse({ code: 404, message: "Not found" }, 404);
  }
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

  const pathParts = path.split("/").filter(Boolean);
  const id = pathParts[4];

  return handleGetInstance(ctx, id, teamSlugOrId);
});

// ============================================================================
// GET /api/v2/devbox/templates - List available templates
// ============================================================================
export const listTemplates = httpAction(async (ctx) => {
  const { error } = await getAuthenticatedUser(ctx);
  if (error) return error;

  const templates = E2B_TEMPLATE_PRESETS.map((preset) => ({
    presetId: preset.id,
    templateId: preset.templateId,
    name: preset.label,
    description: preset.description,
    supportsDocker: preset.templateId.includes("docker"),
  }));

  return jsonResponse({ templates });
});
