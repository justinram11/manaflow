#!/usr/bin/env node
/**
 * MCP stdio proxy for iOS resource provider.
 * Runs inside the workspace container, proxies MCP JSON-RPC requests
 * to the Mac daemon via either a direct WebSocket connection (low latency)
 * or the cmux server HTTP path (fallback).
 *
 * Environment variables:
 *   CMUX_MCP_PROXY_URL      - Server endpoint for MCP proxying (fallback path)
 *   CMUX_TASK_RUN_JWT        - JWT for authentication
 *   CMUX_DIRECT_MCP_TOKEN    - Token for direct WebSocket auth (optional)
 *   CMUX_DIRECT_MCP_PORT     - Port for direct WebSocket server (default 39385)
 */

import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

const PROXY_URL = process.env.CMUX_MCP_PROXY_URL;
const JWT = process.env.CMUX_TASK_RUN_JWT;
const DIRECT_TOKEN = process.env.CMUX_DIRECT_MCP_TOKEN;
const DIRECT_PORT = parseInt(process.env.CMUX_DIRECT_MCP_PORT || "39385", 10);

if (!PROXY_URL) {
  process.stderr.write("ERROR: CMUX_MCP_PROXY_URL not set\n");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin });

function writeResponse(response) {
  process.stdout.write(JSON.stringify(response) + "\n");
}

// ── Direct WebSocket connection state ────────────────────────────────
let directWs = null;
const pendingDirectRequests = new Map(); // id → { resolve, timer }

function isDirectConnected() {
  return directWs !== null && directWs.readyState === 1;
}

function sendViaDirectWs(request) {
  return new Promise((resolve, reject) => {
    if (!isDirectConnected()) {
      reject(new Error("Direct WebSocket not connected"));
      return;
    }

    // tools/call (e.g. ios_sync_code with rsync) can take much longer than tools/list
    const timeoutMs = request.method === "tools/call" ? 120000 : 5000;
    const timer = setTimeout(() => {
      pendingDirectRequests.delete(request.id);
      reject(new Error("Direct WebSocket request timed out"));
    }, timeoutMs);

    pendingDirectRequests.set(request.id, { resolve, timer });

    try {
      directWs.send(JSON.stringify(request));
    } catch (err) {
      clearTimeout(timer);
      pendingDirectRequests.delete(request.id);
      reject(err);
    }
  });
}

function handleDirectWsMessage(data) {
  try {
    const response = JSON.parse(data.toString());
    const pending = pendingDirectRequests.get(response.id);
    if (pending) {
      clearTimeout(pending.timer);
      pendingDirectRequests.delete(response.id);
      pending.resolve(response);
    }
  } catch (err) {
    process.stderr.write(`[ios-proxy] Failed to parse direct WS message: ${err}\n`);
  }
}

function handleDirectWsClose() {
  process.stderr.write("[ios-proxy] Direct WebSocket connection closed\n");
  directWs = null;
  // Resolve pending with null so they fall back to HTTP
  for (const [, { resolve: res, timer }] of pendingDirectRequests) {
    clearTimeout(timer);
    res(null);
  }
  pendingDirectRequests.clear();
}

// ── Minimal WebSocket frame helpers ──────────────────────────────────

function sendFrame(socket, opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

/**
 * Minimal WebSocket wrapper over a raw TCP socket.
 * Handles text frames (0x1), close (0x8), and ping/pong (0x9/0xa).
 * No npm dependencies needed — the container has Node.js.
 */
function createMinimalWebSocket(socket) {
  const ws = new EventEmitter();
  ws.readyState = 1; // OPEN
  let buffer = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (buffer.length < 4) return;
        payloadLength = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (buffer.length < 10) return;
        payloadLength = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskSize = isMasked ? 4 : 0;
      if (buffer.length < offset + maskSize + payloadLength) return;

      let payload;
      if (isMasked) {
        const mask = buffer.subarray(offset, offset + 4);
        offset += 4;
        payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i % 4];
        }
      } else {
        payload = buffer.subarray(offset, offset + payloadLength);
      }
      buffer = buffer.subarray(offset + payloadLength);

      if (opcode === 0x1) {
        ws.emit("message", payload);
      } else if (opcode === 0x8) {
        ws.readyState = 3;
        ws.emit("close");
        socket.end();
        return;
      } else if (opcode === 0x9) {
        sendFrame(socket, 0xa, payload);
      }
    }
  });

  socket.on("close", () => {
    ws.readyState = 3;
    ws.emit("close");
  });

  socket.on("error", (err) => {
    ws.emit("error", err);
  });

  ws.send = (data) => {
    if (ws.readyState !== 1) return;
    const payload = typeof data === "string" ? Buffer.from(data) : data;
    sendFrame(socket, 0x1, payload);
  };

  ws.close = () => {
    if (ws.readyState !== 1) return;
    ws.readyState = 2;
    sendFrame(socket, 0x8, Buffer.alloc(0));
    socket.end();
  };

  return ws;
}

function computeWebSocketAcceptKey(key) {
  return createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-5AB5DC11650A")
    .digest("base64");
}

// ── WebSocket server for Mac daemon to connect to ────────────────────
if (DIRECT_TOKEN) {
  const wsServer = createServer();

  wsServer.on("upgrade", (req, socket) => {
    const url = new URL(req.url, `http://localhost:${DIRECT_PORT}`);
    const token = url.searchParams.get("token");

    if (token !== DIRECT_TOKEN) {
      process.stderr.write("[ios-proxy] Direct WS auth failed: invalid token\n");
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    if (directWs) {
      process.stderr.write("[ios-proxy] Replacing existing direct WS connection\n");
      try { directWs.close(); } catch { /* ignore */ }
      directWs = null;
    }

    const acceptKey = computeWebSocketAcceptKey(req.headers["sec-websocket-key"]);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
      "\r\n"
    );

    const ws = createMinimalWebSocket(socket);
    directWs = ws;

    process.stderr.write("[ios-proxy] Direct WebSocket connection established from Mac daemon\n");

    ws.on("message", handleDirectWsMessage);
    ws.on("close", handleDirectWsClose);
    ws.on("error", (err) => {
      process.stderr.write(`[ios-proxy] Direct WS error: ${err.message}\n`);
      handleDirectWsClose();
    });
  });

  wsServer.listen(DIRECT_PORT, "0.0.0.0", () => {
    process.stderr.write(`[ios-proxy] Direct MCP WebSocket server listening on port ${DIRECT_PORT}\n`);
  });

  wsServer.on("error", (err) => {
    process.stderr.write(`[ios-proxy] WebSocket server error: ${err.message}\n`);
  });
}

// ── HTTP fallback ────────────────────────────────────────────────────

async function sendViaHttp(request) {
  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(JWT ? { Authorization: `Bearer ${JWT}` } : {}),
    },
    body: JSON.stringify(request),
  });

  if (!res.ok) {
    const errorText = await res.text();
    return {
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: `Proxy error (${res.status}): ${errorText}`,
      },
      id: request.id,
    };
  }

  return await res.json();
}

// ── Request routing ──────────────────────────────────────────────────

async function handleRequest(request) {
  const { method, id } = request;

  // Handle initialize locally
  if (method === "initialize") {
    writeResponse({
      jsonrpc: "2.0",
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "cmux-ios-resource",
          version: "1.0.0",
        },
      },
      id,
    });
    return;
  }

  // Handle notifications/initialized locally
  if (method === "notifications/initialized") {
    return;
  }

  // Try direct WebSocket first, fall back to HTTP
  if (isDirectConnected()) {
    try {
      const response = await sendViaDirectWs(request);
      if (response) {
        process.stderr.write(`[ios-proxy] ${method} → direct WebSocket\n`);
        writeResponse(response);
        return;
      }
      process.stderr.write(`[ios-proxy] ${method} → direct WS dropped, falling back to HTTP\n`);
    } catch (err) {
      process.stderr.write(`[ios-proxy] ${method} → direct WS error: ${err.message}, falling back to HTTP\n`);
    }
  }

  // HTTP fallback
  try {
    const response = await sendViaHttp(request);
    process.stderr.write(`[ios-proxy] ${method} → HTTP\n`);
    writeResponse(response);
  } catch (error) {
    writeResponse({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: `Proxy connection error: ${error.message}`,
      },
      id,
    });
  }
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line);
    handleRequest(request).catch((err) => {
      process.stderr.write(`Unhandled error: ${err}\n`);
    });
  } catch (err) {
    process.stderr.write(`Failed to parse JSON-RPC: ${err}\n`);
  }
});

rl.on("close", () => {
  process.exit(0);
});
