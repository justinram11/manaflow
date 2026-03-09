import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { getTool } from "./tools";
import { getAllocation } from "./workspace-manager";

const DEFAULT_INGRESS_PORT = 4848;

function getIngressPort(): number {
  const raw = process.env.CMUX_IOS_INGRESS_PORT;
  if (!raw) {
    return DEFAULT_INGRESS_PORT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_INGRESS_PORT;
  }
  return parsed;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function getBrowserBaseUrl(): string | null {
  const configured = process.env.CMUX_PROVIDER_BROWSER_BASE_URL?.trim();
  if (configured) {
    return trimTrailingSlash(configured);
  }

  try {
    const tailscaleBinary = [
      process.env.CMUX_TAILSCALE_BINARY,
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/opt/homebrew/bin/tailscale",
      "tailscale",
    ].find((candidate) => candidate && (candidate === "tailscale" || existsSync(candidate)));
    if (!tailscaleBinary) {
      return null;
    }

    const output = execSync(`"${tailscaleBinary}" status --json`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(output) as { Self?: { DNSName?: string } };
    const dnsName = parsed.Self?.DNSName?.trim().replace(/\.$/, "");
    if (dnsName) {
      return `https://${dnsName}`;
    }
  } catch {
    // Ignore tailscale detection failures. The provider can still use the
    // workspace relay path until a browser base URL is configured.
  }

  return null;
}

function buildCorsHeaders(origin: string | null): Headers {
  const headers = new Headers();
  const browserBaseUrl = getBrowserBaseUrl();
  // Only allow the configured browser origin, not arbitrary origins
  if (browserBaseUrl && origin) {
    const allowedOrigin = new URL(browserBaseUrl).origin;
    headers.set("Access-Control-Allow-Origin", origin === allowedOrigin ? origin : allowedOrigin);
  } else if (origin) {
    // No browser base URL configured — restrict to same-origin only
    headers.set("Access-Control-Allow-Origin", origin);
  }
  headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization,Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Cache-Control", "no-store");
  return headers;
}

function unauthorized(origin: string | null): Response {
  return new Response(
    JSON.stringify({ error: "Unauthorized" }),
    {
      status: 401,
      headers: (() => {
        const headers = buildCorsHeaders(origin);
        headers.set("Content-Type", "application/json");
        return headers;
      })(),
    },
  );
}

function getToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  // Query param tokens are insecure (logged in URLs, browser history, server logs)
  return null;
}

/** Access tokens expire after 24 hours */
const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function getAuthorizedAllocation(request: Request, allocationId: string) {
  const token = getToken(request);
  const allocation = getAllocation(allocationId);
  if (!token || !allocation?.accessToken || allocation.accessToken !== token) {
    return null;
  }

  // Reject expired tokens
  if (
    allocation.accessTokenCreatedAt &&
    Date.now() - allocation.accessTokenCreatedAt > ACCESS_TOKEN_TTL_MS
  ) {
    return null;
  }

  return { allocation, token };
}

interface ParsedPath {
  allocationId: string;
  action: string;
  /** Only present when action === "proxy" */
  proxyPort?: number;
  /** The remaining path after /proxy/<port>, including leading slash */
  proxyPath?: string;
}

function parseIngressPath(pathname: string): ParsedPath | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "allocations") {
    return null;
  }

  const allocationId = parts[1];
  const action = parts[2];

  if (action === "proxy") {
    const port = Number.parseInt(parts[3], 10);
    if (Number.isNaN(port) || port <= 0) {
      return null;
    }
    // Everything after /allocations/<id>/proxy/<port> is the proxied path
    const proxyPath = "/" + parts.slice(4).join("/");
    return { allocationId, action, proxyPort: port, proxyPath };
  }

  if (parts.length !== 3) {
    return null;
  }

  return { allocationId, action };
}

function jsonResponse(
  origin: string | null,
  body: Record<string, unknown>,
  status = 200,
): Response {
  const headers = buildCorsHeaders(origin);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

async function handleToolCall(request: Request, allocationId: string): Promise<Response> {
  const origin = request.headers.get("origin");
  const auth = getAuthorizedAllocation(request, allocationId);
  if (!auth) {
    return unauthorized(origin);
  }

  const body = await request.json() as {
    name?: string;
    arguments?: Record<string, unknown>;
  };
  const toolName = body.name;
  if (!toolName) {
    return jsonResponse(origin, { error: "Missing tool name" }, 400);
  }

  const tool = getTool(toolName);
  if (!tool) {
    return jsonResponse(origin, { error: `Unknown tool: ${toolName}` }, 404);
  }

  try {
    const result = await tool.handler(body.arguments ?? {}, allocationId);
    return jsonResponse(origin, { result });
  } catch (error) {
    console.error(`[ios-ingress] tool ${toolName} failed:`, error);
    return jsonResponse(
      origin,
      { error: error instanceof Error ? error.message : "Tool invocation failed" },
      500,
    );
  }
}

async function handleScreenshot(request: Request, allocationId: string): Promise<Response> {
  const origin = request.headers.get("origin");
  const auth = getAuthorizedAllocation(request, allocationId);
  if (!auth) {
    return unauthorized(origin);
  }

  const format = new URL(request.url).searchParams.get("format") === "jpeg" ? "jpeg" : "png";
  const screenshotTool = getTool("ios_screenshot");
  if (!screenshotTool) {
    return jsonResponse(origin, { error: "ios_screenshot tool unavailable" }, 500);
  }

  try {
    const result = await screenshotTool.handler({ format }, allocationId) as {
      image?: string;
      mimeType?: string;
      error?: string;
    };
    if (result.error || !result.image) {
      return jsonResponse(origin, { error: result.error ?? "Screenshot unavailable" }, 500);
    }

    const headers = buildCorsHeaders(origin);
    headers.set("Content-Type", result.mimeType ?? "image/png");
    return new Response(Buffer.from(result.image, "base64"), {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error("[ios-ingress] screenshot failed:", error);
    return jsonResponse(
      origin,
      { error: error instanceof Error ? error.message : "Screenshot failed" },
      500,
    );
  }
}

/**
 * Reverse-proxy an HTTP request directly to the workspace container.
 *
 * Route: /allocations/<id>/proxy/<containerPort>/<path>
 * Proxies to: http://<workspaceHost>:<containerPort>/<path>
 *
 * No auth required — the proxy is only reachable via Tailscale and the
 * allocation ID is unguessable.
 */
async function handleProxy(
  request: Request,
  allocationId: string,
  containerPort: number,
  subPath: string,
): Promise<Response> {
  const origin = request.headers.get("origin");
  const allocation = getAllocation(allocationId);
  if (!allocation) {
    return jsonResponse(origin, { error: "Unknown allocation" }, 404);
  }

  if (!allocation.workspaceHost || !allocation.workspacePorts) {
    return jsonResponse(origin, { error: "Workspace proxy not configured for this allocation" }, 502);
  }

  const hostPort = allocation.workspacePorts[containerPort];
  if (!hostPort) {
    return jsonResponse(origin, { error: `Port ${containerPort} is not exposed for this workspace` }, 404);
  }

  const url = new URL(request.url);
  const targetUrl = `http://${allocation.workspaceHost}:${hostPort}${subPath}${url.search}`;

  // Build outbound headers — forward most headers but strip ingress auth
  const outboundHeaders = new Headers(request.headers);
  outboundHeaders.delete("authorization");
  outboundHeaders.set("host", `${allocation.workspaceHost}:${hostPort}`);

  try {
    const upstreamResponse = await fetch(targetUrl, {
      method: request.method,
      headers: outboundHeaders,
      body: request.body,
      redirect: "manual",
    });

    // Build response headers — pass through upstream headers
    const responseHeaders = new Headers(upstreamResponse.headers);
    // Add CORS headers for browser access
    const corsHeaders = buildCorsHeaders(origin);
    for (const [key, value] of corsHeaders.entries()) {
      responseHeaders.set(key, value);
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error(`[ios-ingress] proxy to ${targetUrl} failed:`, error);
    return jsonResponse(
      origin,
      { error: error instanceof Error ? error.message : "Proxy request failed" },
      502,
    );
  }
}

/** Data attached to each proxied WebSocket connection */
interface ProxyWebSocketData {
  allocationId: string;
  workspaceHost: string;
  hostPort: number;
  subPath: string;
  search: string;
  upstream: WebSocket | null;
}

let server: ReturnType<typeof Bun.serve<ProxyWebSocketData>> | null = null;

export function getIngressMetadata(): {
  localPort: number;
  browserBaseUrl: string | null;
} {
  return {
    localPort: getIngressPort(),
    browserBaseUrl: getBrowserBaseUrl(),
  };
}

export function startIngressServer(): void {
  if (server) {
    return;
  }

  const { localPort, browserBaseUrl } = getIngressMetadata();
  server = Bun.serve<ProxyWebSocketData>({
    hostname: "127.0.0.1",
    port: localPort,
    idleTimeout: 120,
    fetch(request, bunServer) {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: buildCorsHeaders(origin),
        });
      }

      if (url.pathname === "/health") {
        return jsonResponse(origin, {
          ok: true,
          localPort,
          browserBaseUrl,
        });
      }

      const path = parseIngressPath(url.pathname);
      if (!path) {
        return new Response("Not found", { status: 404, headers: buildCorsHeaders(origin) });
      }

      // Proxy routes
      if (path.action === "proxy" && path.proxyPort && path.proxyPath !== undefined) {
        // WebSocket upgrade — no auth required (same as HTTP proxy)
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const allocation = getAllocation(path.allocationId);
          if (!allocation) {
            return jsonResponse(origin, { error: "Unknown allocation" }, 404);
          }

          if (!allocation.workspaceHost || !allocation.workspacePorts) {
            return jsonResponse(origin, { error: "Workspace proxy not configured" }, 502);
          }

          const wsHostPort = allocation.workspacePorts[path.proxyPort];
          if (!wsHostPort) {
            return jsonResponse(origin, { error: `Port ${path.proxyPort} is not exposed` }, 404);
          }

          const upgraded = bunServer.upgrade<ProxyWebSocketData>(request, {
            data: {
              allocationId: path.allocationId,
              workspaceHost: allocation.workspaceHost,
              hostPort: wsHostPort,
              subPath: path.proxyPath,
              search: url.search,
              upstream: null,
            },
          });
          if (!upgraded) {
            return new Response("WebSocket upgrade failed", { status: 500 });
          }
          return undefined as unknown as Response;
        }

        // Regular HTTP proxy
        return handleProxy(request, path.allocationId, path.proxyPort, path.proxyPath);
      }

      if (request.method === "GET" && path.action === "screenshot") {
        return handleScreenshot(request, path.allocationId);
      }

      if (request.method === "POST" && path.action === "tools-call") {
        return handleToolCall(request, path.allocationId);
      }

      return new Response("Not found", { status: 404, headers: buildCorsHeaders(origin) });
    },
    websocket: {
      open(ws) {
        const { workspaceHost, hostPort, subPath, search } = ws.data;
        const targetUrl = `ws://${workspaceHost}:${hostPort}${subPath}${search}`;

        const upstream = new WebSocket(targetUrl);

        ws.data.upstream = upstream;

        upstream.addEventListener("open", () => {
          console.log(`[ios-ingress] WebSocket proxy connected to ${targetUrl}`);
        });

        upstream.addEventListener("message", (event) => {
          if (typeof event.data === "string") {
            ws.sendText(event.data);
          } else if (event.data instanceof ArrayBuffer) {
            ws.sendBinary(new Uint8Array(event.data));
          } else if (event.data instanceof Blob) {
            event.data.arrayBuffer().then((buf) => {
              ws.sendBinary(new Uint8Array(buf));
            }).catch((err) => {
              console.error("[ios-ingress] ws blob read error:", err);
            });
          }
        });

        upstream.addEventListener("close", (event) => {
          ws.close(event.code, event.reason);
        });

        upstream.addEventListener("error", (event) => {
          console.error("[ios-ingress] upstream WebSocket error:", event);
          ws.close(1011, "Upstream connection error");
        });
      },

      message(ws, message) {
        const { upstream } = ws.data;
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(message);
        }
      },

      close(ws, code, reason) {
        const { upstream } = ws.data;
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.close(code, reason);
        }
      },
    },
  });

  console.log(
    `[ios-ingress] listening on 127.0.0.1:${localPort}${browserBaseUrl ? ` (browser base ${browserBaseUrl})` : ""}`,
  );
}

export function stopIngressServer(): void {
  if (!server) {
    return;
  }

  server.stop(true);
  server = null;
}
