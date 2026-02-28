import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import { getDb } from "./utils/dbClient";
import { getByToken } from "@cmux/db/queries/providers";
import {
  updateProviderStatus,
  updateProviderHeartbeat,
  updateProvider,
} from "@cmux/db/mutations/providers";
import { serverLogger } from "./utils/fileLogger";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ProviderConnection {
  ws: WebSocket;
  providerId: string;
  pending: Map<string, PendingRequest>;
  heartbeatInterval: ReturnType<typeof setInterval>;
  lastPong: number;
}

const connections = new Map<string, ProviderConnection>();

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const LONG_RUNNING_TIMEOUT_MS = 5 * 60 * 1000; // 5 min (compute.launch, compute.createSnapshot)
const BUILD_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const HEARTBEAT_TIMEOUT_MS = 60 * 1000;

// Methods that trigger builds and need longer timeouts (30 min)
const BUILD_METHODS = new Set([
  "ios_build",
  "ios_build_and_run",
  "ios_resolve_packages",
  "ios_sync_code",
]);

// Methods that are long-running compute operations (5 min)
const LONG_RUNNING_METHODS = new Set([
  "compute.launch",
  "compute.createSnapshot",
]);

function getTimeoutForMethod(method: string): number {
  if (BUILD_METHODS.has(method)) return BUILD_TIMEOUT_MS;
  if (LONG_RUNNING_METHODS.has(method)) return LONG_RUNNING_TIMEOUT_MS;
  return DEFAULT_TIMEOUT_MS;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function setupProviderWS(httpServer: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (url.pathname !== "/provider-ws") return;

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
    let authenticated = false;
    let providerId: string | null = null;

    // Try to extract token from the upgrade request headers
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const rawToken = authHeader.slice(7);
      const hashed = hashToken(rawToken);
      const db = getDb();
      const provider = getByToken(db, hashed);
      if (provider) {
        authenticated = true;
        providerId = provider.id;
        registerConnection(ws, provider.id);
        serverLogger.info(`Provider connected: ${provider.name} (${provider.id})`);
      }
    }

    if (!authenticated) {
      // Allow auth via first message
      ws.once("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "auth" && msg.token) {
            const hashed = hashToken(msg.token);
            const db = getDb();
            const provider = getByToken(db, hashed);
            if (provider) {
              authenticated = true;
              providerId = provider.id;
              registerConnection(ws, provider.id);
              ws.send(JSON.stringify({ type: "auth_ok", providerId: provider.id }));
              serverLogger.info(
                `Provider authenticated via message: ${provider.name} (${provider.id})`,
              );

              // Update provider info if sent (capabilities, metadata, etc.)
              if (msg.info) {
                const patch: Parameters<typeof updateProvider>[2] = {};
                if (msg.info.osVersion) patch.osVersion = msg.info.osVersion;
                if (msg.info.hostname) patch.hostname = msg.info.hostname;
                if (msg.info.capabilities) patch.capabilities = msg.info.capabilities;
                if (msg.info.arch) patch.arch = msg.info.arch;
                if (msg.info.metadata) patch.metadata = msg.info.metadata;

                updateProvider(db, provider.id, patch);
              }
              return;
            }
          }
        } catch (error) {
          console.error("Failed to parse auth message:", error);
        }

        ws.send(JSON.stringify({ type: "auth_error", message: "Invalid token" }));
        ws.close(4001, "Authentication failed");
      });
    }

    ws.on("message", (data) => {
      if (!authenticated || !providerId) return;

      try {
        const msg = JSON.parse(data.toString());
        handleProviderMessage(providerId, msg);
      } catch (error) {
        console.error("Failed to parse provider message:", error);
      }
    });

    ws.on("close", () => {
      if (providerId) {
        cleanupConnection(providerId);
      }
    });

    ws.on("error", (error) => {
      console.error(`Provider WS error (${providerId}):`, error);
      if (providerId) {
        cleanupConnection(providerId);
      }
    });

    ws.on("pong", () => {
      const conn = providerId ? connections.get(providerId) : null;
      if (conn) {
        conn.lastPong = Date.now();
      }
    });
  });
}

function registerConnection(ws: WebSocket, providerId: string): void {
  // Close any existing connection for this provider
  const existing = connections.get(providerId);
  if (existing) {
    clearInterval(existing.heartbeatInterval);
    for (const [, pending] of existing.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Provider reconnected"));
    }
    try {
      existing.ws.close();
    } catch {
      // Ignore close errors on stale connection
    }
  }

  const conn: ProviderConnection = {
    ws,
    providerId,
    pending: new Map(),
    heartbeatInterval: setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        // Check if pong was received recently
        if (Date.now() - conn.lastPong > HEARTBEAT_TIMEOUT_MS) {
          serverLogger.warn(`Provider ${providerId} heartbeat timeout, closing`);
          ws.terminate();
          cleanupConnection(providerId);
          return;
        }

        ws.ping();

        // Update heartbeat in DB
        try {
          const db = getDb();
          updateProviderHeartbeat(db, providerId);
        } catch (error) {
          console.error("Failed to update heartbeat:", error);
        }
      }
    }, HEARTBEAT_INTERVAL_MS),
    lastPong: Date.now(),
  };

  connections.set(providerId, conn);

  // Mark provider as online
  try {
    const db = getDb();
    updateProviderStatus(db, providerId, "online");
  } catch (error) {
    console.error("Failed to update provider status:", error);
  }
}

function cleanupConnection(providerId: string): void {
  const conn = connections.get(providerId);
  if (!conn) return;

  clearInterval(conn.heartbeatInterval);

  // Reject all pending requests
  for (const [, pending] of conn.pending) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("Provider disconnected"));
  }

  connections.delete(providerId);

  // Mark provider as offline
  try {
    const db = getDb();
    updateProviderStatus(db, providerId, "offline");
  } catch (error) {
    console.error("Failed to update provider status:", error);
  }

  serverLogger.info(`Provider disconnected: ${providerId}`);
}

function handleProviderMessage(providerId: string, msg: Record<string, unknown>): void {
  const conn = connections.get(providerId);
  if (!conn) return;

  // Handle JSON-RPC responses
  if (msg.id && (msg.result !== undefined || msg.error !== undefined)) {
    const requestId = String(msg.id);
    const pending = conn.pending.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      conn.pending.delete(requestId);
      pending.resolve(msg);
    }
    return;
  }

  // Handle heartbeat ack
  if (msg.type === "heartbeat") {
    try {
      const db = getDb();
      updateProviderHeartbeat(db, providerId);
    } catch (error) {
      console.error("Failed to update heartbeat:", error);
    }
  }
}

export interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params?: unknown;
  id: string | number;
}

export interface JsonRpcResponse {
  jsonrpc: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: string | number;
}

/**
 * Send a JSON-RPC request to a provider.
 * Timeout is determined by the method type.
 */
export function sendJsonRpcRequest(
  providerId: string,
  request: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const conn = connections.get(providerId);
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Provider not connected"));
  }

  const timeoutMs = getTimeoutForMethod(request.method);
  const requestId = String(request.id);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      conn.pending.delete(requestId);
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    conn.pending.set(requestId, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timeout,
    });

    conn.ws.send(JSON.stringify(request));
  });
}

export function isProviderConnected(providerId: string): boolean {
  const conn = connections.get(providerId);
  return conn !== undefined && conn.ws.readyState === WebSocket.OPEN;
}

/**
 * Send a setup-allocation command to a provider daemon
 */
export function sendSetupAllocation(
  providerId: string,
  data: {
    allocationId: string;
    buildDir: string;
    simulatorDeviceType: string;
    simulatorRuntime: string;
  },
): Promise<JsonRpcResponse> {
  return sendJsonRpcRequest(providerId, {
    jsonrpc: "2.0",
    method: "setup_allocation",
    params: data,
    id: `setup-${data.allocationId}`,
  });
}

/**
 * Send a cleanup-allocation command to a provider daemon
 */
export function sendCleanupAllocation(
  providerId: string,
  data: {
    allocationId: string;
    buildDir?: string | null;
    simulatorUdid?: string | null;
  },
): Promise<JsonRpcResponse> {
  return sendJsonRpcRequest(providerId, {
    jsonrpc: "2.0",
    method: "cleanup_allocation",
    params: data,
    id: `cleanup-${data.allocationId}`,
  });
}
