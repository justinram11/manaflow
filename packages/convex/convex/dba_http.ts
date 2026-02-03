/**
 * DBA CLI HTTP API - Convex httpActions that proxy Morph Cloud operations.
 *
 * All endpoints require Stack Auth authentication and inject the MORPH_API_KEY server-side.
 * Instance data is tracked in devboxInstances table, with provider info in devboxInfo.
 */
import { httpAction, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { env } from "../_shared/convex-env";
import type { FunctionReference } from "convex/server";

const MORPH_API_BASE_URL = "https://cloud.morph.so/api";

// Default snapshot ID for dba CLI instances
const DEFAULT_DBA_SNAPSHOT_ID = "snapshot_z84t8vej";

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

/**
 * Make an authenticated request to the Morph API.
 */
async function morphFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const apiKey = env.MORPH_API_KEY;
  if (!apiKey) {
    throw new Error("MORPH_API_KEY not configured");
  }

  const url = `${MORPH_API_BASE_URL}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...options.headers,
    },
  });
}

/**
 * Extract networking URLs from Morph instance data.
 */
function extractNetworkingUrls(
  httpServices: Array<{ port: number; url: string; name?: string }> | Record<string, string>
) {
  // Handle both array format (new) and object format (legacy)
  if (Array.isArray(httpServices)) {
    const vscodeService = httpServices.find((s) => s.port === 39378 || s.name === "vscode");
    const workerService = httpServices.find((s) => s.port === 39377 || s.name === "worker");
    const vncService = httpServices.find((s) => s.port === 39380 || s.name === "vnc");

    return {
      vscodeUrl: vscodeService?.url,
      workerUrl: workerService?.url,
      vncUrl: vncService?.url,
    };
  } else {
    // Legacy object format: { "39378": "url", "vscode": "url" }
    return {
      vscodeUrl: httpServices["39378"] ?? httpServices["vscode"],
      workerUrl: httpServices["39377"] ?? httpServices["worker"],
      vncUrl: httpServices["39380"] ?? httpServices["vnc"],
    };
  }
}

function buildDbaProxyUrls(workerUrl?: string) {
  if (!workerUrl) {
    return { vscodeUrl: undefined, vncUrl: undefined };
  }

  const base = workerUrl.replace(/\/+$/, "");
  return {
    vscodeUrl: `${base}/code/`,
    vncUrl: `${base}/vnc/vnc.html?path=vnc/websockify`,
  };
}

// Type-safe references to devboxInstances functions (used by dba CLI)
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
const morphInstancesApi = (internal as any).morphInstances as {
  recordResumeInternal: FunctionReference<"mutation", "internal">;
  recordPauseInternal: FunctionReference<"mutation", "internal">;
  recordStopInternal: FunctionReference<"mutation", "internal">;
};

/**
 * Record activity for a Morph instance (creates entry in morphInstanceActivity table)
 */
async function recordMorphActivity(
  ctx: ActionCtx,
  providerInstanceId: string,
  action: "resume" | "pause" | "stop"
): Promise<void> {
  try {
    if (action === "resume") {
      await ctx.runMutation(morphInstancesApi.recordResumeInternal, {
        instanceId: providerInstanceId,
      });
    } else if (action === "pause") {
      await ctx.runMutation(morphInstancesApi.recordPauseInternal, {
        instanceId: providerInstanceId,
      });
    } else if (action === "stop") {
      await ctx.runMutation(morphInstancesApi.recordStopInternal, {
        instanceId: providerInstanceId,
      });
    }
  } catch (error) {
    // Log but don't fail the main operation if activity recording fails
    console.error("[dba] Failed to record morph activity:", error);
  }
}

/**
 * Get the provider instance ID for a devbox ID
 */
async function getProviderInstanceId(
  ctx: ActionCtx,
  devboxId: string
): Promise<string | null> {
  const info = await ctx.runQuery(devboxInternalApi.getInfo, {
    devboxId,
  }) as { providerInstanceId: string } | null;
  return info?.providerInstanceId ?? null;
}

// ============================================================================
// POST /api/v1/dba/instances - Start a new instance from snapshot
// ============================================================================
export const createInstance = httpAction(async (ctx, req) => {
  const contentTypeError = verifyContentType(req);
  if (contentTypeError) return contentTypeError;

  const { identity, error } = await getAuthenticatedUser(ctx);
  if (error) return error;

  let body: {
    teamSlugOrId: string;
    snapshotId?: string;
    name?: string;
    ttlSeconds?: number;
    vcpus?: number;
    memory?: number;
    diskSize?: number;
    metadata?: Record<string, string>;
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

  const apiKey = env.MORPH_API_KEY;
  if (!apiKey) {
    return jsonResponse(
      { code: 503, message: "Morph API not configured" },
      503
    );
  }

  try {
    const snapshotId = body.snapshotId ?? DEFAULT_DBA_SNAPSHOT_ID;

    // Start a new Morph instance via boot endpoint
    const morphResponse = await morphFetch(`/snapshot/${snapshotId}/boot`, {
      method: "POST",
      body: JSON.stringify({
        ttl_seconds: body.ttlSeconds ?? 60 * 60, // 1 hour default
        ttl_action: "pause",
        vcpus: body.vcpus ?? 2,
        memory: body.memory ?? 4096, // 4GB default
        metadata: {
          app: "cmux-dba",
          userId: identity!.subject,
          ...(body.metadata || {}),
        },
      }),
    });

    if (!morphResponse.ok) {
      const errorText = await morphResponse.text();
      console.error("[dba.create] Morph API error:", {
        status: morphResponse.status,
        body: errorText.slice(0, 500),
      });
      return jsonResponse(
        { code: 502, message: "Failed to create instance" },
        502
      );
    }

    const morphData = (await morphResponse.json()) as {
      id: string;
      status: string;
      networking?: {
        http_services?: Array<{ port: number; url: string; name?: string }> | Record<string, string>;
      };
      spec?: {
        vcpus?: number;
        memory?: number;
        disk_size?: number;
      };
    };

    // Expose HTTP services (worker only) for the new instance
    const exposedServices: { workerUrl?: string } = {};

    const servicesToExpose = [{ name: "worker", port: 39377 }];

    for (const service of servicesToExpose) {
      try {
        const exposeResponse = await morphFetch(
          `/instance/${morphData.id}/http`,
          {
            method: "POST",
            body: JSON.stringify({ name: service.name, port: service.port }),
          }
        );
        if (exposeResponse.ok) {
          const exposeData = (await exposeResponse.json()) as { url?: string };
          if (service.name === "worker") exposedServices.workerUrl = exposeData.url;
        }
      } catch (e) {
        console.error(`[dba.create] Failed to expose ${service.name}:`, e);
      }
    }

    // Fall back to any services that were already in the boot response
    const httpServices = morphData.networking?.http_services ?? [];
    const bootUrls = extractNetworkingUrls(httpServices);
    const workerUrl = exposedServices.workerUrl ?? bootUrls.workerUrl;
    const proxyUrls = buildDbaProxyUrls(workerUrl);

    // Inject auth config for worker daemon (JWT validation)
    // This writes the owner ID and Stack Auth project ID to the VM
    const stackProjectId = env.NEXT_PUBLIC_STACK_PROJECT_ID;
    if (stackProjectId) {
      try {
        // Create directory
        await morphFetch(`/instance/${morphData.id}/exec`, {
          method: "POST",
          body: JSON.stringify({
            command: ["mkdir", "-p", "/var/run/dba"],
            timeout: 10,
          }),
        });

        // Write owner ID using echo with shell redirection
        // Note: Morph API requires command as array of tokens, NOT bash -c
        // User IDs are UUIDs with only safe characters (a-f, 0-9, -)
        const ownerId = identity!.subject;
        console.log("[dba.create] Injecting owner-id:", ownerId);
        await morphFetch(`/instance/${morphData.id}/exec`, {
          method: "POST",
          body: JSON.stringify({
            command: ["echo", ownerId, ">", "/var/run/dba/owner-id"],
            timeout: 10,
          }),
        });

        // Write Stack Auth project ID - also UUID format
        console.log("[dba.create] Injecting stack-project-id:", stackProjectId);
        await morphFetch(`/instance/${morphData.id}/exec`, {
          method: "POST",
          body: JSON.stringify({
            command: ["echo", stackProjectId, ">", "/var/run/dba/stack-project-id"],
            timeout: 10,
          }),
        });

        // Restart dba-worker to pick up the new config
        await morphFetch(`/instance/${morphData.id}/exec`, {
          method: "POST",
          body: JSON.stringify({
            command: ["systemctl", "restart", "dba-worker"],
            timeout: 10,
          }),
        });
      } catch (e) {
        console.error("[dba.create] Failed to inject auth config:", e);
        // Don't fail instance creation if auth config injection fails
      }
    } else {
      console.warn("[dba.create] NEXT_PUBLIC_STACK_PROJECT_ID not set, worker auth will be disabled");
    }

    // Store the instance in Convex with provider mapping (no URL caching)
    const result = await ctx.runMutation(devboxApi.create, {
      teamSlugOrId: body.teamSlugOrId,
      providerInstanceId: morphData.id,
      provider: "morph",
      name: body.name,
      snapshotId,
      metadata: body.metadata,
      source: "cli",
    }) as { id: string; isExisting: boolean };

    // Return URLs from Morph response (not cached in DB)
    return jsonResponse({
      id: result.id,
      status: morphData.status,
      snapshotId,
      vscodeUrl: proxyUrls.vscodeUrl,
      workerUrl,
      vncUrl: proxyUrls.vncUrl,
      spec: morphData.spec,
    });
  } catch (error) {
    console.error("[dba.create] Error:", error);
    return jsonResponse(
      { code: 500, message: "Failed to create instance" },
      500
    );
  }
});

// ============================================================================
// GET /api/v1/dba/instances - List instances
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
    const rawInstances = await ctx.runQuery(devboxApi.list, {
      teamSlugOrId,
    }) as Array<{
      devboxId: string;
      status: string;
      name?: string;
      createdAt: number;
      updatedAt: number;
    }>;

    // Return basic instance info with id field (URLs are fetched via GET /instances/{id})
    const instances = rawInstances.map((inst) => ({
      id: inst.devboxId,
      status: inst.status,
      name: inst.name,
      createdAt: inst.createdAt,
      updatedAt: inst.updatedAt,
    }));

    return jsonResponse({ instances });
  } catch (error) {
    console.error("[dba.list] Error:", error);
    return jsonResponse(
      { code: 500, message: "Failed to list instances" },
      500
    );
  }
});

// ============================================================================
// GET /api/v1/dba/instances/{id} - Get instance details
// ============================================================================
async function handleGetInstance(
  ctx: ActionCtx,
  id: string,
  teamSlugOrId: string
): Promise<Response> {
  try {
    // Get instance from Convex by ID
    const instance = await ctx.runQuery(devboxApi.getById, {
      teamSlugOrId,
      id,
    }) as { id: string; status: string; name?: string } | null;

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    // Get provider instance ID from mapping
    const providerInstanceId = await getProviderInstanceId(ctx, id);
    if (!providerInstanceId) {
      return jsonResponse({ id, status: instance.status, name: instance.name });
    }

    // Get fresh status and URLs from Morph
    const morphResponse = await morphFetch(`/instance/${providerInstanceId}`);

    if (!morphResponse.ok) {
      // Instance may have been deleted
      if (morphResponse.status === 404) {
        await ctx.runMutation(devboxApi.updateStatus, {
          teamSlugOrId,
          id,
          status: "stopped",
        });
        return jsonResponse({
          id,
          status: "stopped",
          name: instance.name,
        });
      }
      // Return basic data on other errors
      return jsonResponse({ id, status: instance.status, name: instance.name });
    }

    const morphData = (await morphResponse.json()) as {
      id: string;
      status: string;
      networking?: {
        http_services?: Array<{ port: number; url: string; name?: string }> | Record<string, string>;
      };
      spec?: {
        vcpus?: number;
        memory?: number;
        disk_size?: number;
      };
    };

    // Map Morph status to our status
    // Note: Morph uses "ready" for a running instance, not "running"
    const status =
      morphData.status === "running" || morphData.status === "ready"
        ? "running"
        : morphData.status === "paused"
          ? "paused"
          : morphData.status === "stopped"
            ? "stopped"
            : "unknown";

    // Update status in Convex if changed
    if (status !== instance.status) {
      await ctx.runMutation(devboxApi.updateStatus, {
        teamSlugOrId,
        id,
        status,
      });
    }

    // Get URLs directly from Morph (not cached)
    const httpServices = morphData.networking?.http_services ?? [];
    const { workerUrl } = extractNetworkingUrls(httpServices);
    const proxyUrls = buildDbaProxyUrls(workerUrl);

    return jsonResponse({
      id,
      status,
      name: instance.name,
      vscodeUrl: proxyUrls.vscodeUrl,
      workerUrl,
      vncUrl: proxyUrls.vncUrl,
      spec: morphData.spec,
    });
  } catch (error) {
    console.error("[dba.get] Error:", error);
    return jsonResponse({ code: 500, message: "Failed to get instance" }, 500);
  }
}

// ============================================================================
// POST /api/v1/dba/instances/{id}/exec - Execute command
// ============================================================================
async function handleExecCommand(
  ctx: ActionCtx,
  id: string,
  teamSlugOrId: string,
  command: string | string[],
  timeout?: number
): Promise<Response> {
  try {
    // Verify the user owns this instance
    const instance = await ctx.runQuery(devboxApi.getById, {
      teamSlugOrId,
      id,
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    // Get provider instance ID
    const providerInstanceId = await getProviderInstanceId(ctx, id);
    if (!providerInstanceId) {
      return jsonResponse({ code: 404, message: "Provider mapping not found" }, 404);
    }

    // Morph API expects command as an array
    // Split string commands into array; don't wrap in bash -c as Morph handles execution
    const commandArray = Array.isArray(command) ? command : command.split(" ");

    // Execute command via Morph API
    const morphResponse = await morphFetch(
      `/instance/${providerInstanceId}/exec`,
      {
        method: "POST",
        body: JSON.stringify({
          command: commandArray,
          timeout: timeout ?? 30,
        }),
      }
    );

    if (!morphResponse.ok) {
      const errorText = await morphResponse.text();
      console.error("[dba.exec] Morph API error:", {
        status: morphResponse.status,
        body: errorText.slice(0, 500),
      });
      return jsonResponse(
        { code: 502, message: "Failed to execute command" },
        502
      );
    }

    const result = await morphResponse.json();

    // Record access
    await ctx.runMutation(devboxApi.recordAccess, {
      teamSlugOrId,
      id,
    });

    return jsonResponse(result);
  } catch (error) {
    console.error("[dba.exec] Error:", error);
    return jsonResponse(
      { code: 500, message: "Failed to execute command" },
      500
    );
  }
}

// ============================================================================
// POST /api/v1/dba/instances/{id}/pause - Pause instance
// ============================================================================
async function handlePauseInstance(
  ctx: ActionCtx,
  id: string,
  teamSlugOrId: string
): Promise<Response> {
  try {
    // Verify the user owns this instance
    const instance = await ctx.runQuery(devboxApi.getById, {
      teamSlugOrId,
      id,
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    // Get provider instance ID
    const providerInstanceId = await getProviderInstanceId(ctx, id);
    if (!providerInstanceId) {
      return jsonResponse({ code: 404, message: "Provider mapping not found" }, 404);
    }

    // Pause via Morph API
    const morphResponse = await morphFetch(
      `/instance/${providerInstanceId}/pause`,
      {
        method: "POST",
      }
    );

    if (!morphResponse.ok) {
      const errorText = await morphResponse.text();
      console.error("[dba.pause] Morph API error:", {
        status: morphResponse.status,
        body: errorText.slice(0, 500),
      });
      return jsonResponse(
        { code: 502, message: "Failed to pause instance" },
        502
      );
    }

    // Update status in Convex
    await ctx.runMutation(devboxApi.updateStatus, {
      teamSlugOrId,
      id,
      status: "paused",
    });

    // Record activity in morphInstanceActivity table
    await recordMorphActivity(ctx, providerInstanceId, "pause");

    return jsonResponse({ paused: true });
  } catch (error) {
    console.error("[dba.pause] Error:", error);
    return jsonResponse(
      { code: 500, message: "Failed to pause instance" },
      500
    );
  }
}

// ============================================================================
// POST /api/v1/dba/instances/{id}/resume - Resume instance
// ============================================================================
async function handleResumeInstance(
  ctx: ActionCtx,
  id: string,
  teamSlugOrId: string
): Promise<Response> {
  try {
    // Verify the user owns this instance
    const instance = await ctx.runQuery(devboxApi.getById, {
      teamSlugOrId,
      id,
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    // Get provider instance ID
    const providerInstanceId = await getProviderInstanceId(ctx, id);
    if (!providerInstanceId) {
      return jsonResponse({ code: 404, message: "Provider mapping not found" }, 404);
    }

    // Resume via Morph API
    const morphResponse = await morphFetch(
      `/instance/${providerInstanceId}/resume`,
      {
        method: "POST",
      }
    );

    if (!morphResponse.ok) {
      const errorText = await morphResponse.text();
      console.error("[dba.resume] Morph API error:", {
        status: morphResponse.status,
        body: errorText.slice(0, 500),
      });
      return jsonResponse(
        { code: 502, message: "Failed to resume instance" },
        502
      );
    }

    // Update status in Convex
    await ctx.runMutation(devboxApi.updateStatus, {
      teamSlugOrId,
      id,
      status: "running",
    });

    // Record activity in morphInstanceActivity table
    await recordMorphActivity(ctx, providerInstanceId, "resume");

    return jsonResponse({ resumed: true });
  } catch (error) {
    console.error("[dba.resume] Error:", error);
    return jsonResponse(
      { code: 500, message: "Failed to resume instance" },
      500
    );
  }
}

// ============================================================================
// POST /api/v1/dba/instances/{id}/stop - Stop instance
// ============================================================================
async function handleStopInstance(
  ctx: ActionCtx,
  id: string,
  teamSlugOrId: string
): Promise<Response> {
  try {
    // Verify the user owns this instance
    const instance = await ctx.runQuery(devboxApi.getById, {
      teamSlugOrId,
      id,
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    // Get provider instance ID
    const providerInstanceId = await getProviderInstanceId(ctx, id);
    if (!providerInstanceId) {
      return jsonResponse({ code: 404, message: "Provider mapping not found" }, 404);
    }

    // Stop via Morph API (DELETE)
    const morphResponse = await morphFetch(
      `/instance/${providerInstanceId}`,
      {
        method: "DELETE",
      }
    );

    if (!morphResponse.ok && morphResponse.status !== 404) {
      const errorText = await morphResponse.text();
      console.error("[dba.stop] Morph API error:", {
        status: morphResponse.status,
        body: errorText.slice(0, 500),
      });
      return jsonResponse(
        { code: 502, message: "Failed to stop instance" },
        502
      );
    }

    // Update status in Convex
    await ctx.runMutation(devboxApi.updateStatus, {
      teamSlugOrId,
      id,
      status: "stopped",
    });

    // Record activity in morphInstanceActivity table
    await recordMorphActivity(ctx, providerInstanceId, "stop");

    return jsonResponse({ stopped: true });
  } catch (error) {
    console.error("[dba.stop] Error:", error);
    return jsonResponse({ code: 500, message: "Failed to stop instance" }, 500);
  }
}

// ============================================================================
// GET /api/v1/dba/instances/{id}/ssh - Get SSH credentials
// ============================================================================
async function handleGetInstanceSsh(
  ctx: ActionCtx,
  id: string,
  teamSlugOrId: string
): Promise<Response> {
  try {
    // Verify the user owns this instance
    const instance = await ctx.runQuery(devboxApi.getById, {
      teamSlugOrId,
      id,
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    // Get provider instance ID
    const providerInstanceId = await getProviderInstanceId(ctx, id);
    if (!providerInstanceId) {
      return jsonResponse({ code: 404, message: "Provider mapping not found" }, 404);
    }

    // Get SSH credentials from Morph API
    const primaryResponse = await morphFetch(
      `/instance/${providerInstanceId}/ssh/key`
    );
    let morphResponse = primaryResponse;

    if (!primaryResponse.ok) {
      const fallbackResponse = await morphFetch(
        `/instance/${providerInstanceId}/ssh_key`
      );
      if (fallbackResponse.ok) {
        morphResponse = fallbackResponse;
      } else {
        const primaryText = await primaryResponse.text();
        const fallbackText = await fallbackResponse.text();
        console.error("[dba.ssh] Morph API error:", {
          primaryStatus: primaryResponse.status,
          primaryBody: primaryText.slice(0, 500),
          fallbackStatus: fallbackResponse.status,
          fallbackBody: fallbackText.slice(0, 500),
        });
        return jsonResponse(
          { code: 502, message: "Failed to get SSH credentials" },
          502
        );
      }
    }

    const sshData = (await morphResponse.json()) as {
      private_key?: string;
      key?: string;
      public_key?: string;
      password?: string;
      access_token?: string;
    };

    // Record access
    await ctx.runMutation(devboxApi.recordAccess, {
      teamSlugOrId,
      id,
    });

    return jsonResponse({
      id,
      privateKey: sshData.private_key ?? sshData.key,
      publicKey: sshData.public_key,
      accessToken: sshData.access_token,
      sshCommand: sshData.access_token
        ? `ssh ${sshData.access_token}@ssh.cloud.morph.so`
        : undefined,
    });
  } catch (error) {
    console.error("[dba.ssh] Error:", error);
    return jsonResponse(
      { code: 500, message: "Failed to get SSH credentials" },
      500
    );
  }
}

// ============================================================================
// POST /api/v1/dba/instances/{id}/ttl - Update TTL
// ============================================================================
async function handleUpdateTtl(
  ctx: ActionCtx,
  id: string,
  teamSlugOrId: string,
  ttlSeconds: number
): Promise<Response> {
  try {
    // Verify the user owns this instance
    const instance = await ctx.runQuery(devboxApi.getById, {
      teamSlugOrId,
      id,
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    // Get provider instance ID
    const providerInstanceId = await getProviderInstanceId(ctx, id);
    if (!providerInstanceId) {
      return jsonResponse({ code: 404, message: "Provider mapping not found" }, 404);
    }

    // Update TTL via Morph API
    const morphResponse = await morphFetch(
      `/instance/${providerInstanceId}/ttl`,
      {
        method: "POST",
        body: JSON.stringify({ ttl_seconds: ttlSeconds }),
      }
    );

    if (!morphResponse.ok) {
      const errorText = await morphResponse.text();
      console.error("[dba.ttl] Morph API error:", {
        status: morphResponse.status,
        body: errorText.slice(0, 500),
      });
      return jsonResponse(
        { code: 502, message: "Failed to update TTL" },
        502
      );
    }

    return jsonResponse({ updated: true, ttlSeconds });
  } catch (error) {
    console.error("[dba.ttl] Error:", error);
    return jsonResponse({ code: 500, message: "Failed to update TTL" }, 500);
  }
}

// ============================================================================
// POST /api/v1/dba/instances/{id}/reboot - Reboot instance
// ============================================================================
async function handleRebootInstance(
  ctx: ActionCtx,
  id: string,
  teamSlugOrId: string
): Promise<Response> {
  try {
    // Verify the user owns this instance
    const instance = await ctx.runQuery(devboxApi.getById, {
      teamSlugOrId,
      id,
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    // Get provider instance ID
    const providerInstanceId = await getProviderInstanceId(ctx, id);
    if (!providerInstanceId) {
      return jsonResponse({ code: 404, message: "Provider mapping not found" }, 404);
    }

    // Reboot via Morph API
    const morphResponse = await morphFetch(
      `/instance/${providerInstanceId}/reboot`,
      {
        method: "POST",
      }
    );

    if (!morphResponse.ok) {
      const errorText = await morphResponse.text();
      console.error("[dba.reboot] Morph API error:", {
        status: morphResponse.status,
        body: errorText.slice(0, 500),
      });
      return jsonResponse(
        { code: 502, message: "Failed to reboot instance" },
        502
      );
    }

    return jsonResponse({ rebooted: true });
  } catch (error) {
    console.error("[dba.reboot] Error:", error);
    return jsonResponse({ code: 500, message: "Failed to reboot instance" }, 500);
  }
}

// ============================================================================
// POST /api/v1/dba/instances/{id}/snapshot - Create snapshot
// ============================================================================
async function handleSnapshotInstance(
  ctx: ActionCtx,
  id: string,
  teamSlugOrId: string,
  digest?: string
): Promise<Response> {
  try {
    // Verify the user owns this instance
    const instance = await ctx.runQuery(devboxApi.getById, {
      teamSlugOrId,
      id,
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    // Get provider instance ID
    const providerInstanceId = await getProviderInstanceId(ctx, id);
    if (!providerInstanceId) {
      return jsonResponse({ code: 404, message: "Provider mapping not found" }, 404);
    }

    // Create snapshot via Morph API
    const body: Record<string, string> = {};
    if (digest) {
      body.digest = digest;
    }

    const morphResponse = await morphFetch(
      `/instance/${providerInstanceId}/snapshot`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );

    if (!morphResponse.ok) {
      const errorText = await morphResponse.text();
      console.error("[dba.snapshot] Morph API error:", {
        status: morphResponse.status,
        body: errorText.slice(0, 500),
      });
      return jsonResponse(
        { code: 502, message: "Failed to create snapshot" },
        502
      );
    }

    const result = await morphResponse.json();
    return jsonResponse(result);
  } catch (error) {
    console.error("[dba.snapshot] Error:", error);
    return jsonResponse({ code: 500, message: "Failed to create snapshot" }, 500);
  }
}

// ============================================================================
// POST /api/v1/dba/instances/{id}/http - Expose HTTP service
// ============================================================================
async function handleExposeHttpService(
  ctx: ActionCtx,
  id: string,
  teamSlugOrId: string,
  serviceName: string,
  port: number
): Promise<Response> {
  try {
    // Verify the user owns this instance
    const instance = await ctx.runQuery(devboxApi.getById, {
      teamSlugOrId,
      id,
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    // Get provider instance ID
    const providerInstanceId = await getProviderInstanceId(ctx, id);
    if (!providerInstanceId) {
      return jsonResponse({ code: 404, message: "Provider mapping not found" }, 404);
    }

    // Expose HTTP service via Morph API
    const morphResponse = await morphFetch(
      `/instance/${providerInstanceId}/http`,
      {
        method: "POST",
        body: JSON.stringify({ name: serviceName, port }),
      }
    );

    if (!morphResponse.ok) {
      const errorText = await morphResponse.text();
      console.error("[dba.http.expose] Morph API error:", {
        status: morphResponse.status,
        body: errorText.slice(0, 500),
      });
      return jsonResponse(
        { code: 502, message: "Failed to expose HTTP service" },
        502
      );
    }

    const result = await morphResponse.json();
    return jsonResponse(result);
  } catch (error) {
    console.error("[dba.http.expose] Error:", error);
    return jsonResponse({ code: 500, message: "Failed to expose HTTP service" }, 500);
  }
}

// ============================================================================
// DELETE /api/v1/dba/instances/{id}/http/{serviceName} - Hide HTTP service
// ============================================================================
async function handleHideHttpService(
  ctx: ActionCtx,
  id: string,
  teamSlugOrId: string,
  serviceName: string
): Promise<Response> {
  try {
    // Verify the user owns this instance
    const instance = await ctx.runQuery(devboxApi.getById, {
      teamSlugOrId,
      id,
    });

    if (!instance) {
      return jsonResponse({ code: 404, message: "Instance not found" }, 404);
    }

    // Get provider instance ID
    const providerInstanceId = await getProviderInstanceId(ctx, id);
    if (!providerInstanceId) {
      return jsonResponse({ code: 404, message: "Provider mapping not found" }, 404);
    }

    // Hide HTTP service via Morph API
    const morphResponse = await morphFetch(
      `/instance/${providerInstanceId}/http/${serviceName}`,
      {
        method: "DELETE",
      }
    );

    if (!morphResponse.ok) {
      const errorText = await morphResponse.text();
      console.error("[dba.http.hide] Morph API error:", {
        status: morphResponse.status,
        body: errorText.slice(0, 500),
      });
      return jsonResponse(
        { code: 502, message: "Failed to hide HTTP service" },
        502
      );
    }

    return jsonResponse({ hidden: true });
  } catch (error) {
    console.error("[dba.http.hide] Error:", error);
    return jsonResponse({ code: 500, message: "Failed to hide HTTP service" }, 500);
  }
}

// ============================================================================
// GET /api/v1/dba/snapshots - List snapshots
// ============================================================================
export const listSnapshots = httpAction(async (ctx) => {
  const { error } = await getAuthenticatedUser(ctx);
  if (error) return error;

  try {
    const morphResponse = await morphFetch("/snapshot");

    if (!morphResponse.ok) {
      const errorText = await morphResponse.text();
      console.error("[dba.snapshots.list] Morph API error:", {
        status: morphResponse.status,
        body: errorText.slice(0, 500),
      });
      return jsonResponse(
        { code: 502, message: "Failed to list snapshots" },
        502
      );
    }

    const result = await morphResponse.json();
    return jsonResponse({ snapshots: result });
  } catch (error) {
    console.error("[dba.snapshots.list] Error:", error);
    return jsonResponse({ code: 500, message: "Failed to list snapshots" }, 500);
  }
});

// ============================================================================
// GET /api/v1/dba/snapshots/{id} - Get snapshot details
// ============================================================================
export const getSnapshot = httpAction(async (ctx, req) => {
  const { error } = await getAuthenticatedUser(ctx);
  if (error) return error;

  const url = new URL(req.url);
  const pathParts = url.pathname.split("/");
  const snapshotId = pathParts[pathParts.length - 1];

  if (!snapshotId) {
    return jsonResponse({ code: 400, message: "Snapshot ID is required" }, 400);
  }

  try {
    const morphResponse = await morphFetch(`/snapshot/${snapshotId}`);

    if (!morphResponse.ok) {
      if (morphResponse.status === 404) {
        return jsonResponse({ code: 404, message: "Snapshot not found" }, 404);
      }
      const errorText = await morphResponse.text();
      console.error("[dba.snapshots.get] Morph API error:", {
        status: morphResponse.status,
        body: errorText.slice(0, 500),
      });
      return jsonResponse(
        { code: 502, message: "Failed to get snapshot" },
        502
      );
    }

    const result = await morphResponse.json();
    return jsonResponse(result);
  } catch (error) {
    console.error("[dba.snapshots.get] Error:", error);
    return jsonResponse({ code: 500, message: "Failed to get snapshot" }, 500);
  }
});

// ============================================================================
// GET /api/v1/dba/config - Get CLI configuration (snapshot ID, etc.)
// ============================================================================
export const getConfig = httpAction(async (ctx) => {
  const { error } = await getAuthenticatedUser(ctx);
  if (error) return error;

  return jsonResponse({
    defaultSnapshotId: DEFAULT_DBA_SNAPSHOT_ID,
  });
});

// ============================================================================
// GET /api/v1/dba/me - Get current user profile including team
// ============================================================================
export const getMe = httpAction(async (ctx) => {
  const { identity, error } = await getAuthenticatedUser(ctx);
  if (error) return error;

  try {
    const userId = identity!.subject;

    // Look up user in users table by their Stack Auth subject (userId)
    const user = await ctx.runQuery(internal.users.getByUserIdInternal, {
      userId,
    });

    // Get user's team memberships to find a valid team
    const memberships = await ctx.runQuery(internal.teams.getMembershipsByUserIdInternal, {
      userId,
    });

    let teamId: string | null = null;
    let teamSlug: string | null = null;
    let teamDisplayName: string | null = null;

    // First, check if user's selectedTeamId is valid (they have membership)
    if (user?.selectedTeamId) {
      const hasMembership = memberships.some(m => m.teamId === user.selectedTeamId);
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

    // Fall back to first team membership if selectedTeamId is invalid
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
        // Team doesn't exist in teams table, use raw teamId as slug
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
    console.error("[dba.me] Error:", err);
    return jsonResponse(
      { code: 500, message: "Failed to get user profile" },
      500
    );
  }
});

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

  // Parse path to get id and action
  // Path formats:
  // /api/v1/dba/instances/{id}/{action}
  // /api/v1/dba/instances/{id}/http/{serviceName}
  const pathParts = path.split("/").filter(Boolean);
  // pathParts: ["api", "v1", "dba", "instances", "{id}", "{action}", ...]

  const id = pathParts[4]; // instances/{id}
  const action = pathParts[5]; // {action}

  let body: {
    teamSlugOrId: string;
    command?: string | string[];
    timeout?: number;
    ttlSeconds?: number;
    digest?: string;
    serviceName?: string;
    port?: number;
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

  // Route based on the action
  switch (action) {
    case "exec":
      if (!body.command) {
        return jsonResponse({ code: 400, message: "command is required" }, 400);
      }
      return handleExecCommand(
        ctx,
        id,
        body.teamSlugOrId,
        body.command,
        body.timeout
      );

    case "pause":
      return handlePauseInstance(ctx, id, body.teamSlugOrId);

    case "resume":
      return handleResumeInstance(ctx, id, body.teamSlugOrId);

    case "stop":
      return handleStopInstance(ctx, id, body.teamSlugOrId);

    case "ttl":
      if (!body.ttlSeconds) {
        return jsonResponse({ code: 400, message: "ttlSeconds is required" }, 400);
      }
      return handleUpdateTtl(
        ctx,
        id,
        body.teamSlugOrId,
        body.ttlSeconds
      );

    case "reboot":
      return handleRebootInstance(ctx, id, body.teamSlugOrId);

    case "snapshot":
      return handleSnapshotInstance(
        ctx,
        id,
        body.teamSlugOrId,
        body.digest
      );

    case "http":
      if (!body.serviceName || !body.port) {
        return jsonResponse(
          { code: 400, message: "serviceName and port are required" },
          400
        );
      }
      return handleExposeHttpService(
        ctx,
        id,
        body.teamSlugOrId,
        body.serviceName,
        body.port
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

  // Parse path to get id and action
  const pathParts = path.split("/").filter(Boolean);
  // pathParts: ["api", "v1", "dba", "instances", "{id}", "{action}?"]

  const id = pathParts[4];
  const action = pathParts[5]; // May be undefined for GET /instances/{id}

  // Route based on the action suffix
  if (action === "ssh") {
    return handleGetInstanceSsh(ctx, id, teamSlugOrId);
  }

  // Default: get instance details
  return handleGetInstance(ctx, id, teamSlugOrId);
});

// ============================================================================
// Route handler for instance-specific DELETE actions
// ============================================================================
export const instanceDeleteRouter = httpAction(async (ctx, req) => {
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

  // Parse path: /api/v1/dba/instances/{id}/http/{serviceName}
  const pathParts = path.split("/").filter(Boolean);
  const id = pathParts[4];
  const action = pathParts[5];

  if (action === "http") {
    const serviceName = pathParts[6];
    if (!serviceName) {
      return jsonResponse(
        { code: 400, message: "serviceName is required" },
        400
      );
    }
    return handleHideHttpService(ctx, id, teamSlugOrId, serviceName);
  }

  return jsonResponse({ code: 404, message: "Not found" }, 404);
});
