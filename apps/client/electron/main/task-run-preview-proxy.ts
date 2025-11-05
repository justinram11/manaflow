import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import net, { type Socket } from "node:net";
import tls, { type TLSSocket } from "node:tls";
import { randomBytes, createHash } from "node:crypto";
import { URL } from "node:url";
import type { Session, WebContents } from "electron";
import { isLoopbackHostname } from "@cmux/shared";
import type { Logger } from "./chrome-camouflage";

type ProxyServer = http.Server;

const TASK_RUN_PREVIEW_PREFIX = "task-run-preview:";
const CMUX_DOMAINS = [
  "cmux.app",
  "cmux.sh",
  "cmux.dev",
  "cmux.local",
  "cmux.localhost",
  "autobuild.app",
] as const;

interface ProxyRoute {
  morphId: string;
  scope: string;
  domainSuffix: (typeof CMUX_DOMAINS)[number];
}

interface ProxyContext {
  username: string;
  password: string;
  route: ProxyRoute | null;
  session: Session;
  webContentsId: number;
  persistKey?: string;
}

interface ProxyTarget {
  url: URL;
  secure: boolean;
  connectPort: number;
}

interface ConfigureOptions {
  webContents: WebContents;
  initialUrl: string;
  persistKey?: string;
  logger: Logger;
}

let proxyServer: ProxyServer | null = null;
let proxyPort: number | null = null;
let proxyLogger: Logger | null = null;
let startingProxy: Promise<number> | null = null;

const contextsByUsername = new Map<string, ProxyContext>();
const contextsByWebContentsId = new Map<number, ProxyContext>();

function proxyLog(event: string, data?: Record<string, unknown>): void {
  try {
    proxyLogger?.log("Preview proxy", { event, ...(data ?? {}) });
  } catch {
    // ignore logging failures
  }
}

function proxyWarn(event: string, data?: Record<string, unknown>): void {
  try {
    proxyLogger?.warn("Preview proxy", { event, ...(data ?? {}) });
  } catch {
    // ignore logging failures
  }
}

export function isTaskRunPreviewPersistKey(
  key: string | undefined
): key is string {
  return typeof key === "string" && key.startsWith(TASK_RUN_PREVIEW_PREFIX);
}

export function getPreviewPartitionForPersistKey(
  key: string | undefined
): string | null {
  if (!isTaskRunPreviewPersistKey(key)) {
    return null;
  }
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return `persist:cmux-preview-${hash}`;
}

export function getProxyCredentialsForWebContents(
  id: number
): { username: string; password: string } | null {
  const context = contextsByWebContentsId.get(id);
  if (!context) return null;
  return { username: context.username, password: context.password };
}

export function releasePreviewProxy(webContentsId: number): void {
  const context = contextsByWebContentsId.get(webContentsId);
  if (!context) return;
  contextsByWebContentsId.delete(webContentsId);
  contextsByUsername.delete(context.username);
  proxyLog("reset-session-proxy", {
    webContentsId,
    persistKey: context.persistKey,
  });
  void context.session
    .setProxy({ mode: "direct" })
    .catch(() => {
      // Ignore proxy reset failures
    });
}

export async function configurePreviewProxyForView(
  options: ConfigureOptions
): Promise<() => void> {
  const { webContents, initialUrl, persistKey, logger } = options;
  const route = deriveRoute(initialUrl);
  if (!route) {
    logger.warn("Preview proxy skipped; unable to parse cmux host", {
      url: initialUrl,
      persistKey,
    });
    return () => {};
  }

  const port = await ensureProxyServer(logger);
  const username = `wc-${webContents.id}-${randomBytes(4).toString("hex")}`;
  const password = randomBytes(12).toString("hex");

  const context: ProxyContext = {
    username,
    password,
    route,
    session: webContents.session,
    webContentsId: webContents.id,
    persistKey,
  };

  contextsByUsername.set(username, context);
  contextsByWebContentsId.set(webContents.id, context);

  try {
    await webContents.session.setProxy({
      proxyRules: `http=127.0.0.1:${port};https=127.0.0.1:${port}`,
      proxyBypassRules: "<-loopback>",
    });
  } catch (error) {
    contextsByUsername.delete(username);
    contextsByWebContentsId.delete(webContents.id);
    logger.warn("Failed to configure preview proxy", { error });
    throw error;
  }

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    releasePreviewProxy(webContents.id);
    proxyLog("released-context", {
      webContentsId: webContents.id,
      persistKey,
    });
  };

  webContents.once("destroyed", cleanup);
  proxyLog("configured-context", {
    webContentsId: webContents.id,
    persistKey,
    route,
  });
  return cleanup;
}

export function startPreviewProxy(logger: Logger): Promise<number> {
  return ensureProxyServer(logger);
}

async function ensureProxyServer(logger: Logger): Promise<number> {
  if (proxyPort && proxyServer) {
    return proxyPort;
  }
  if (startingProxy) {
    return startingProxy;
  }
  startingProxy = startProxyServer(logger);
  try {
    const port = await startingProxy;
    proxyPort = port;
    return port;
  } finally {
    startingProxy = null;
  }
}

async function startProxyServer(logger: Logger): Promise<number> {
  const startPort = 39385;
  const maxAttempts = 50;
  for (let i = 0; i < maxAttempts; i += 1) {
    const candidatePort = startPort + i;
    const server = http.createServer();
    attachServerHandlers(server);
    try {
      await listen(server, candidatePort);
      proxyServer = server;
      proxyLogger = logger;
      console.log(`[cmux-preview-proxy] listening on port ${candidatePort}`);
      logger.log("Preview proxy listening", { port: candidatePort });
      proxyLog("listening", { port: candidatePort });
      return candidatePort;
    } catch (error) {
      server.removeAllListeners();
      try {
        server.close();
      } catch {
        // ignore close failure
      }
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Unable to bind preview proxy port");
}

function listen(server: ProxyServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off("error", handleError);
      resolve();
    };
    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(port, "127.0.0.1");
  });
}

function attachServerHandlers(server: ProxyServer) {
  server.on("request", handleHttpRequest);
  server.on("connect", handleConnect);
  server.on("upgrade", handleUpgrade);
  server.on("clientError", (error, socket) => {
    proxyLogger?.warn("Proxy client error", { error });
    socket.end();
  });
}

function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
  const context = authenticateRequest(req.headers);
  if (!context) {
    respondProxyAuthRequired(res);
    return;
  }

  const target = parseProxyRequestTarget(req);
  if (!target) {
    proxyWarn("http-target-parse-failed", {
      url: req.url,
      host: req.headers.host,
    });
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  const rewritten = rewriteTarget(target, context);
  proxyLog("http-request", {
    username: context.username,
    requestedHost: target.hostname,
    requestedPort: target.port,
    rewrittenHost: rewritten.url.hostname,
    rewrittenPort: rewritten.connectPort,
    persistKey: context.persistKey,
  });
  forwardHttpRequest(req, res, rewritten, context);
}

function handleConnect(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer
) {
  const context = authenticateRequest(req.headers);
  if (!context) {
    respondProxyAuthRequiredSocket(socket);
    return;
  }

  const target = parseConnectTarget(req.url ?? "");
  if (!target) {
    proxyWarn("connect-target-parse-failed", {
      url: req.url,
    });
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.end();
    return;
  }

  proxyLog("connect-request", {
    username: context.username,
    hostname: target.hostname,
    port: target.port,
    persistKey: context.persistKey,
  });
  const upstream = net.connect(target.port, target.hostname, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) {
      upstream.write(head);
    }
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on("error", (error) => {
    proxyLogger?.warn("CONNECT upstream error", { error });
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.end();
  });

  socket.on("error", () => {
    upstream.destroy();
  });
}

function handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
  const context = authenticateRequest(req.headers);
  if (!context) {
    respondProxyAuthRequiredSocket(socket);
    return;
  }

  const target = parseProxyRequestTarget(req);
  if (!target) {
    proxyWarn("upgrade-target-parse-failed", {
      url: req.url,
      host: req.headers.host,
    });
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.end();
    return;
  }

  const rewritten = rewriteTarget(target, context);
  proxyLog("upgrade-request", {
    username: context.username,
    requestedHost: target.hostname,
    requestedPort: target.port,
    rewrittenHost: rewritten.url.hostname,
    rewrittenPort: rewritten.connectPort,
    persistKey: context.persistKey,
  });
  forwardUpgradeRequest(req, socket, head, rewritten);
}

function authenticateRequest(
  headers: IncomingHttpHeaders
): ProxyContext | null {
  const raw = headers["proxy-authorization"];
  if (typeof raw !== "string") {
    return null;
  }
  const match = raw.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) return null;
  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);
  const context = contextsByUsername.get(username);
  if (!context || context.password !== password) {
    return null;
  }
  return context;
}

function respondProxyAuthRequired(res: ServerResponse) {
  res.writeHead(407, {
    "Proxy-Authenticate": 'Basic realm="Cmux Preview Proxy"',
  });
  res.end("Proxy Authentication Required");
}

function respondProxyAuthRequiredSocket(socket: Socket) {
  socket.write(
    "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Cmux Preview Proxy\"\r\n\r\n"
  );
  socket.end();
}

function parseProxyRequestTarget(req: IncomingMessage): URL | null {
  try {
    if (req.url && /^[a-z]+:\/\//i.test(req.url)) {
      const normalized = req.url.replace(
        /^ws(s)?:\/\//i,
        (_match, secure) => (secure ? "https://" : "http://")
      );
      return new URL(normalized);
    }
    const host = req.headers.host;
    if (!host || !req.url) {
      return null;
    }
    return new URL(`http://${host}${req.url}`);
  } catch {
    return null;
  }
}

function parseConnectTarget(input: string): { hostname: string; port: number } | null {
  if (!input) return null;
  const [host, portString] = input.split(":");
  const port = Number.parseInt(portString ?? "", 10);
  if (!host || Number.isNaN(port)) {
    return null;
  }
  return { hostname: host, port };
}

function rewriteTarget(url: URL, context: ProxyContext): ProxyTarget {
  const rewritten = new URL(url.toString());
  let secure = rewritten.protocol === "https:";

  if (context.route && isLoopbackHostname(rewritten.hostname)) {
    const requestedPort = determineRequestedPort(url);
    rewritten.protocol = "https:";
    rewritten.hostname = buildCmuxHost(context.route, requestedPort);
    rewritten.port = "";
    secure = true;
  }

  const connectPort = Number.parseInt(rewritten.port, 10);
  const resolvedPort = Number.isNaN(connectPort)
    ? secure
      ? 443
      : 80
    : connectPort;

  return {
    url: rewritten,
    secure,
    connectPort: resolvedPort,
  };
}

function determineRequestedPort(url: URL): number {
  if (url.port) {
    const parsed = Number.parseInt(url.port, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  if (url.protocol === "https:" || url.protocol === "wss:") {
    return 443;
  }
  return 80;
}

function buildCmuxHost(route: ProxyRoute, port: number): string {
  const safePort = Number.isFinite(port) && port > 0 ? Math.floor(port) : 80;
  return `cmux-${route.morphId}-${route.scope}-${safePort}.${route.domainSuffix}`;
}

function forwardHttpRequest(
  clientReq: IncomingMessage,
  clientRes: ServerResponse,
  target: ProxyTarget,
  context: ProxyContext
) {
  const { url, secure, connectPort } = target;
  const requestHeaders: Record<string, string> = {};

  for (const [key, value] of Object.entries(clientReq.headers)) {
    if (!value) continue;
    if (key.toLowerCase() === "proxy-authorization") continue;
    if (Array.isArray(value)) {
      requestHeaders[key] = value.join(", ");
    } else {
      requestHeaders[key] = value;
    }
  }
  requestHeaders.host = url.host;

  const requestOptions = {
    protocol: secure ? "https:" : "http:",
    hostname: url.hostname,
    port: connectPort,
    method: clientReq.method,
    path: url.pathname + url.search,
    headers: requestHeaders,
  };

  const httpModule = secure ? https : http;
  const proxyReq = httpModule.request(requestOptions, (proxyRes) => {
    clientRes.writeHead(
      proxyRes.statusCode ?? 500,
      proxyRes.statusMessage ?? "",
      proxyRes.headers
    );
    proxyRes.pipe(clientRes);
  });

  proxyReq.on("error", (error) => {
    proxyWarn("http-upstream-error", {
      error,
      persistKey: context.persistKey,
      username: context.username,
      host: url.hostname,
    });
    if (!clientRes.headersSent) {
      clientRes.writeHead(502);
    }
    clientRes.end("Bad Gateway");
  });

  clientReq.pipe(proxyReq);
  clientReq.on("aborted", () => {
    proxyReq.destroy();
  });
}

function forwardUpgradeRequest(
  clientReq: IncomingMessage,
  socket: Socket,
  head: Buffer,
  target: ProxyTarget
) {
  const { url, secure, connectPort } = target;
  const upstream: Socket | TLSSocket = secure
    ? tls.connect({
        host: url.hostname,
        port: connectPort,
        servername: url.hostname,
      })
    : net.connect(connectPort, url.hostname);

  const handleConnected = () => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(clientReq.headers)) {
      if (!value) continue;
      if (key.toLowerCase() === "proxy-authorization") continue;
      headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    headers.host = url.host;

    const lines = [
      `${clientReq.method ?? "GET"} ${url.pathname}${url.search} HTTP/1.1`,
    ];
    for (const [key, value] of Object.entries(headers)) {
      lines.push(`${key}: ${value}`);
    }
    lines.push("\r\n");
    upstream.write(lines.join("\r\n"));
    if (head.length > 0) {
      upstream.write(head);
    }

    upstream.pipe(socket);
    socket.pipe(upstream);
  };

  if (secure && upstream instanceof tls.TLSSocket) {
    upstream.once("secureConnect", handleConnected);
  } else {
    upstream.once("connect", handleConnected);
  }

  upstream.on("error", (error) => {
    proxyWarn("upgrade-upstream-error", {
      error,
      host: url.hostname,
      port: connectPort,
    });
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.end();
  });

  socket.on("error", () => {
    upstream.destroy();
  });
}

function deriveRoute(url: string): ProxyRoute | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const morphMatch = hostname.match(
      /^port-(\d+)-morphvm-([^.]+)\.http\.cloud\.morph\.so$/
    );
    if (morphMatch) {
      const morphId = morphMatch[2];
      if (morphId) {
        return {
          morphId,
          scope: "base",
          domainSuffix: "cmux.app",
        };
      }
    }
    for (const domain of CMUX_DOMAINS) {
      const suffix = `.${domain}`;
      if (!hostname.endsWith(suffix)) {
        continue;
      }
      const subdomain = hostname.slice(0, -suffix.length);
      if (!subdomain.startsWith("cmux-")) {
        continue;
      }
      const remainder = subdomain.slice("cmux-".length);
      const segments = remainder.split("-").filter((segment) => segment.length > 0);
      if (segments.length < 3) {
        continue;
      }
      const portSegment = segments.pop();
      const scopeSegment = segments.pop();
      if (!portSegment || !scopeSegment) {
        continue;
      }
      if (!/^\d+$/.test(portSegment)) {
        continue;
      }
      const morphId = segments.join("-");
      if (!morphId) {
        continue;
      }
      return {
        morphId,
        scope: scopeSegment,
        domainSuffix: domain,
      };
    }
  } catch {
    return null;
  }
  return null;
}
