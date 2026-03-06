import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import WebSocket from "ws";
import { getTool } from "./tools";
import { ensureSimulatorCapture, getAllocation } from "./workspace-manager";

const DEFAULT_INGRESS_PORT = 4848;

type IngressSocketData = {
  allocationId: string;
  token: string;
  upstream?: WebSocket;
};

function getDefaultLocalVncPort(allocationId: string): number {
  let hash = 0;
  for (const char of allocationId) {
    hash = (hash * 31 + char.charCodeAt(0)) % 10000;
  }
  return 45000 + hash;
}

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
  headers.set("Access-Control-Allow-Origin", origin || "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
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

  return new URL(request.url).searchParams.get("token");
}

function getAuthorizedAllocation(request: Request, allocationId: string) {
  const token = getToken(request);
  const allocation = getAllocation(allocationId);
  if (!token || !allocation?.accessToken || allocation.accessToken !== token) {
    return null;
  }

  return { allocation, token };
}

function parseIngressPath(pathname: string): {
  allocationId: string;
  action: string;
} | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "allocations") {
    return null;
  }

  return {
    allocationId: parts[1],
    action: parts[2],
  };
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

let server: ReturnType<typeof Bun.serve<IngressSocketData>> | null = null;

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
  server = Bun.serve<IngressSocketData>({
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

      if (path.action === "websockify") {
        const auth = getAuthorizedAllocation(request, path.allocationId);
        if (!auth) {
          return unauthorized(origin);
        }

        const upgraded = bunServer.upgrade(request, {
          data: {
            allocationId: path.allocationId,
            token: auth.token,
          },
        });
        if (upgraded) {
          return undefined;
        }
        return new Response("WebSocket upgrade failed", {
          status: 400,
          headers: buildCorsHeaders(origin),
        });
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
        const allocation = getAllocation(ws.data.allocationId);
        if (!allocation?.accessToken || allocation.accessToken !== ws.data.token) {
          ws.close(1008, "Unauthorized");
          return;
        }

        const localPort = allocation.capturePort ?? getDefaultLocalVncPort(ws.data.allocationId);
        const captureUdid = ensureSimulatorCapture(ws.data.allocationId, localPort);
        if (!captureUdid) {
          ws.close(1011, "Simulator unavailable");
          return;
        }

        const capturePort = getAllocation(ws.data.allocationId)?.capturePort;
        if (!capturePort) {
          ws.close(1011, "Capture unavailable");
          return;
        }

        const upstream = new WebSocket(`ws://127.0.0.1:${capturePort}/websockify`);
        ws.data.upstream = upstream;

        upstream.on("message", (message, isBinary) => {
          ws.send(message, isBinary);
        });

        upstream.on("close", (code, reason) => {
          ws.close(code, reason.toString() || undefined);
        });

        upstream.on("error", (error) => {
          console.error(`[ios-ingress] upstream websocket failed for ${ws.data.allocationId}:`, error);
          ws.close(1011, "Upstream VNC failed");
        });
      },
      message(ws, message) {
        const upstream = ws.data.upstream;
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(message);
        }
      },
      close(ws) {
        ws.data.upstream?.close();
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
