import { getToolDefinitions, getTool } from "./tools/index";
import {
  setupAllocation,
  cleanupAllocation,
  getAllocation,
  setRsyncInfo,
  setAllocationAccessToken,
} from "./workspace-manager";

const PORT = Number(process.env.CMUX_VM_MCP_PORT) || 4850;

/** Access tokens expire after 24 hours */
const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function getToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return null;
}

function getAuthorizedAllocation(request: Request, allocationId: string) {
  const token = getToken(request);
  const allocation = getAllocation(allocationId);
  if (!token || !allocation?.accessToken || allocation.accessToken !== token) {
    return null;
  }

  if (
    allocation.accessTokenCreatedAt &&
    Date.now() - allocation.accessTokenCreatedAt > ACCESS_TOKEN_TTL_MS
  ) {
    return null;
  }

  return { allocation, token };
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Authorization,Content-Type",
    },
  });
}

function corsHeaders(): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400",
  });
}

// ── MCP JSON-RPC handler ─────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params?: Record<string, unknown>;
  id: string | number;
}

interface JsonRpcResponse {
  jsonrpc: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: string | number;
}

async function handleJsonRpc(msg: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { method, params, id } = msg;

  try {
    switch (method) {
      case "tools/list": {
        const tools = getToolDefinitions();
        return { jsonrpc: "2.0", result: { tools }, id };
      }

      case "tools/call": {
        const toolName = params?.name as string;
        const toolArgs = (params?.arguments as Record<string, unknown>) ?? {};
        const allocationId = (params?._allocationId as string) ?? "";

        const tool = getTool(toolName);
        if (!tool) {
          return {
            jsonrpc: "2.0",
            error: { code: -32601, message: `Unknown tool: ${toolName}` },
            id,
          };
        }

        const result = await tool.handler(toolArgs, allocationId);

        // Return native MCP image content block for screenshot results
        const typedResult = result as Record<string, unknown>;
        if (typedResult.image && typedResult.mimeType) {
          return {
            jsonrpc: "2.0",
            result: {
              content: [
                {
                  type: "image" as const,
                  data: typedResult.image as string,
                  mimeType: typedResult.mimeType as string,
                },
              ],
            },
            id,
          };
        }

        return {
          jsonrpc: "2.0",
          result: {
            content: [
              {
                type: "text",
                text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
              },
            ],
          },
          id,
        };
      }

      case "setup_allocation": {
        const result = setupAllocation({
          allocationId: params?.allocationId as string,
          buildDir: params?.buildDir as string,
          simulatorDeviceType: (params?.simulatorDeviceType as string) || "iPhone 16 Pro",
          simulatorRuntime: (params?.simulatorRuntime as string) || "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
        });

        // Store access token if provided
        if (params?.accessToken) {
          setAllocationAccessToken(result.allocationId, params.accessToken as string);
        }

        // Store rsync info if provided
        if (params?.rsyncEndpoint && params?.rsyncSecret) {
          setRsyncInfo(
            result.allocationId,
            params.rsyncEndpoint as string,
            params.rsyncSecret as string,
          );
        }

        return {
          jsonrpc: "2.0",
          result: { success: true, ...result },
          id,
        };
      }

      case "cleanup_allocation": {
        cleanupAllocation({
          allocationId: params?.allocationId as string,
          buildDir: params?.buildDir as string | undefined,
          simulatorUdid: params?.simulatorUdid as string | undefined,
        });
        return { jsonrpc: "2.0", result: { success: true }, id };
      }

      case "initialize": {
        return {
          jsonrpc: "2.0",
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: "cmux-vm-ios-mcp-server",
              version: "1.0.0",
            },
          },
          id,
        };
      }

      default:
        return {
          jsonrpc: "2.0",
          error: { code: -32601, message: `Unknown method: ${method}` },
          id,
        };
    }
  } catch (error) {
    console.error(`Error handling ${method}:`, error);
    return {
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : "Internal error",
      },
      id,
    };
  }
}

// ── HTTP handlers ────────────────────────────────────────────────────────

async function handleToolCall(request: Request, allocationId: string): Promise<Response> {
  const auth = getAuthorizedAllocation(request, allocationId);
  if (!auth) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const body = await request.json() as {
    name?: string;
    arguments?: Record<string, unknown>;
  };
  const toolName = body.name;
  if (!toolName) {
    return jsonResponse({ error: "Missing tool name" }, 400);
  }

  const tool = getTool(toolName);
  if (!tool) {
    return jsonResponse({ error: `Unknown tool: ${toolName}` }, 404);
  }

  try {
    const result = await tool.handler(body.arguments ?? {}, allocationId);
    return jsonResponse({ result });
  } catch (error) {
    console.error(`[vm-mcp] tool ${toolName} failed:`, error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Tool invocation failed" },
      500,
    );
  }
}

async function handleScreenshot(request: Request, allocationId: string): Promise<Response> {
  const auth = getAuthorizedAllocation(request, allocationId);
  if (!auth) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const format = new URL(request.url).searchParams.get("format") === "jpeg" ? "jpeg" : "png";
  const screenshotTool = getTool("ios_screenshot");
  if (!screenshotTool) {
    return jsonResponse({ error: "ios_screenshot tool unavailable" }, 500);
  }

  try {
    const result = await screenshotTool.handler({ format }, allocationId) as {
      image?: string;
      mimeType?: string;
      error?: string;
    };
    if (result.error || !result.image) {
      return jsonResponse({ error: result.error ?? "Screenshot unavailable" }, 500);
    }

    return new Response(Buffer.from(result.image, "base64"), {
      status: 200,
      headers: {
        "Content-Type": result.mimeType ?? "image/png",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[vm-mcp] screenshot failed:", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Screenshot failed" },
      500,
    );
  }
}

// ── Path parser ──────────────────────────────────────────────────────────

interface ParsedPath {
  allocationId: string;
  action: string;
}

function parsePath(pathname: string): ParsedPath | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "allocations") {
    return null;
  }
  return { allocationId: parts[1], action: parts[2] };
}

// ── Server ───────────────────────────────────────────────────────────────

const _server = Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Health check
    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, port: PORT });
    }

    // JSON-RPC endpoint (for MCP protocol)
    if (url.pathname === "/jsonrpc" && request.method === "POST") {
      const body = await request.json() as JsonRpcRequest;
      const result = await handleJsonRpc(body);
      return new Response(JSON.stringify(result), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // REST-style allocation endpoints
    const path = parsePath(url.pathname);
    if (!path) {
      return new Response("Not found", { status: 404, headers: corsHeaders() });
    }

    if (request.method === "GET" && path.action === "screenshot") {
      return handleScreenshot(request, path.allocationId);
    }

    if (request.method === "POST" && path.action === "tools-call") {
      return handleToolCall(request, path.allocationId);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
});

console.log(`[vm-ios-mcp-server] listening on 0.0.0.0:${PORT}`);
