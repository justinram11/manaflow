import * as http from "node:http";
import * as net from "node:net";
import path from "node:path";
import type { Socket } from "node:net";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { sentryVitePlugin } from "@sentry/vite-plugin";

import { relatedProjects } from "@vercel/related-projects";

const NEXT_PUBLIC_RELATED_WWW_ORIGIN_PREVIEW = relatedProjects({
  noThrow: true,
}).find((p) => p.project.name === "cmux-www")?.preview.branch;

const WORKSPACE_PROXY_PREFIX = "/_cmux/workspaces/";

type WorkspaceProxyTarget = {
  host: string;
  port: number;
  upstreamPath: string;
};

function getRequestOrigin(req: http.IncomingMessage): string {
  const host = req.headers.host ?? "localhost";
  const forwardedProtoHeader = req.headers["x-forwarded-proto"];
  const forwardedProto = Array.isArray(forwardedProtoHeader)
    ? forwardedProtoHeader[0]
    : forwardedProtoHeader;
  const protocol =
    forwardedProto ??
    (host.includes(".ts.net") ? "https" : "http");
  return `${protocol}://${host}`;
}

function getWorkspaceProxyPrefix(target: WorkspaceProxyTarget): string {
  return `${WORKSPACE_PROXY_PREFIX}${encodeURIComponent(target.host)}/${encodeURIComponent(String(target.port))}`;
}

function rewriteWorkspaceHtml(
  html: string,
  target: WorkspaceProxyTarget,
  req: http.IncomingMessage
): string {
  const proxyPrefix = getWorkspaceProxyPrefix(target);
  const origin = getRequestOrigin(req);
  const escapedProxyPrefix = proxyPrefix.replaceAll("/", "\\/");
  const escapedOriginPrefix = `${origin}${proxyPrefix}`;
  const escapedOriginPrefixForJson = escapedOriginPrefix.replaceAll("/", "\\/");

  let rewritten = html.replaceAll('"/oss-', `"${proxyPrefix}/oss-`);
  rewritten = rewritten.replaceAll("'/oss-", `'${escapedProxyPrefix}/oss-`);
  rewritten = rewritten.replaceAll('="/oss-', `="${proxyPrefix}/oss-`);
  rewritten = rewritten.replaceAll('content="/oss-', `content="${proxyPrefix}/oss-`);
  rewritten = rewritten.replaceAll(
    "&quot;serverBasePath&quot;:&quot;/&quot;",
    `&quot;serverBasePath&quot;:&quot;${proxyPrefix}/&quot;`
  );
  rewritten = rewritten.replace(
    /&quot;resourceUrlTemplate&quot;:&quot;https?:\/\/[^/]+\/oss-/g,
    `&quot;resourceUrlTemplate&quot;:&quot;${escapedOriginPrefixForJson}/oss-`
  );
  rewritten = rewritten.replace(
    /&quot;callbackRoute&quot;:&quot;\/oss-/g,
    `&quot;callbackRoute&quot;:&quot;${escapedProxyPrefix}/oss-`
  );

  return rewritten;
}

function parseWorkspaceProxyTarget(rawUrl: string | undefined): WorkspaceProxyTarget | null {
  if (!rawUrl) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl, "http://localhost");
  } catch {
    return null;
  }

  if (!parsedUrl.pathname.startsWith(WORKSPACE_PROXY_PREFIX)) {
    return null;
  }

  const suffix = parsedUrl.pathname.slice(WORKSPACE_PROXY_PREFIX.length);
  const [encodedHost, encodedPort, ...pathSegments] = suffix.split("/");
  if (!encodedHost || !encodedPort) {
    return null;
  }

  const host = decodeURIComponent(encodedHost);
  const port = Number.parseInt(decodeURIComponent(encodedPort), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }

  const upstreamPathname = `/${pathSegments.join("/")}`;
  const upstreamPath = `${upstreamPathname}${parsedUrl.search}`;

  return {
    host,
    port,
    upstreamPath,
  };
}

function proxyWorkspaceHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: WorkspaceProxyTarget
): void {
  const upstreamHeaders = { ...req.headers, host: `${target.host}:${target.port}` };
  const proxyReq = http.request(
    {
      hostname: target.host,
      port: target.port,
      path: target.upstreamPath,
      method: req.method,
      headers: upstreamHeaders,
    },
    (proxyRes) => {
      const contentTypeHeader = proxyRes.headers["content-type"];
      const contentType = Array.isArray(contentTypeHeader)
        ? contentTypeHeader[0]
        : contentTypeHeader;
      const shouldRewriteHtml = contentType?.includes("text/html") ?? false;

      if (!shouldRewriteHtml) {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      proxyRes.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      proxyRes.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const rewrittenBody = rewriteWorkspaceHtml(body, target, req);
        const headers = { ...proxyRes.headers };
        delete headers["content-length"];
        delete headers["content-security-policy"];
        res.writeHead(proxyRes.statusCode ?? 502, headers);
        res.end(rewrittenBody);
      });
    }
  );

  proxyReq.on("error", (error) => {
    console.error("[workspace-proxy] HTTP proxy error:", error);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end("Workspace proxy request failed");
  });

  req.pipe(proxyReq);
}

function writeUpgradeRequest(
  req: http.IncomingMessage,
  socket: Socket,
  head: Buffer,
  target: WorkspaceProxyTarget
): void {
  const upstreamHeaders = Object.entries(req.headers)
    .map(([key, value]) => {
      if (typeof value === "undefined") {
        return null;
      }
      if (Array.isArray(value)) {
        return value.map((entry) => `${key}: ${entry}`).join("\r\n");
      }
      if (key.toLowerCase() === "host") {
        return `${key}: ${target.host}:${target.port}`;
      }
      return `${key}: ${value}`;
    })
    .filter((entry): entry is string => entry !== null)
    .join("\r\n");

  socket.write(
    `${req.method ?? "GET"} ${target.upstreamPath} HTTP/${req.httpVersion}\r\n${upstreamHeaders}\r\n\r\n`
  );

  if (head.length > 0) {
    socket.write(head);
  }
}

function proxyWorkspaceWebSocket(
  req: http.IncomingMessage,
  clientSocket: Socket,
  head: Buffer,
  target: WorkspaceProxyTarget
): void {
  const upstreamSocket = net.connect(target.port, target.host, () => {
    writeUpgradeRequest(req, upstreamSocket, head, target);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstreamSocket.on("error", (error) => {
    console.error("[workspace-proxy] WebSocket proxy error:", error);
    clientSocket.destroy(error);
  });

  clientSocket.on("error", (error) => {
    console.error("[workspace-proxy] Client WebSocket error:", error);
    upstreamSocket.destroy(error);
  });
}

function workspaceProxyPlugin(): Plugin {
  let hasUpgradeHandler = false;

  return {
    name: "cmux-workspace-proxy",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const target = parseWorkspaceProxyTarget(req.url);
        if (!target) {
          next();
          return;
        }
        proxyWorkspaceHttpRequest(req, res, target);
      });

      if (hasUpgradeHandler) {
        return;
      }

      server.httpServer?.on("upgrade", (req, socket, head) => {
        const target = parseWorkspaceProxyTarget(req.url);
        if (!target) {
          return;
        }
        proxyWorkspaceWebSocket(req, socket, head, target);
      });

      hasUpgradeHandler = true;
    },
  };
}

// Ensure all env is loaded
await import("./src/client-env.ts");

const SentryVitePlugin = process.env.SENTRY_AUTH_TOKEN
  ? sentryVitePlugin({
      org: "manaflow",
      project: "cmux-client-web",
      authToken: process.env.SENTRY_AUTH_TOKEN,
      sourcemaps: {
        filesToDeleteAfterUpload: ["**/*.map"],
      },
      telemetry: false,
    })
  : undefined;

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tsconfigPaths({
      // Only scan from apps/client to avoid dev-docs submodules with unresolved tsconfig extends
      root: import.meta.dirname,
    }),
    workspaceProxyPlugin(),
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
    SentryVitePlugin,
  ],
  resolve: {
    // Dedupe so Monaco services (e.g. hoverService) are registered once
    dedupe: ["monaco-editor"],
    alias: {
      // Explicitly resolve workspace package subpath exports for rolldown-vite compatibility
      "@cmux/www-openapi-client/client.gen": path.resolve(
        import.meta.dirname,
        "../../packages/www-openapi-client/src/client/client.gen.ts"
      ),
    },
  },
  optimizeDeps: {
    // Skip pre-bundling to avoid shipping a second Monaco runtime copy
    exclude: ["monaco-editor"],
  },
  define: {
    "process.env": {},
    "process.env.NODE_ENV": JSON.stringify(
      process.env.NODE_ENV || "development"
    ),
    "process.env.NEXT_PUBLIC_RELATED_WWW_ORIGIN_PREVIEW": JSON.stringify(
      NEXT_PUBLIC_RELATED_WWW_ORIGIN_PREVIEW
    ),
    global: "globalThis",
  },
  envPrefix: "NEXT_PUBLIC_",
  // TODO: make this safe
  server: {
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:9779",
        changeOrigin: true,
      },
      "/handler": {
        target: "http://127.0.0.1:9779",
        changeOrigin: true,
      },
      "/socket.io": {
        target: "http://127.0.0.1:9776",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
