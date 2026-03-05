#!/usr/bin/env bun

import net from "node:net";

const RAW_PORT = 39386;
const WS_PORT = 39387;

const pendingRawSockets = [];
const pendingWebSockets = [];

function removePending(list, item) {
  const index = list.indexOf(item);
  if (index !== -1) list.splice(index, 1);
}

function closePair(rawSocket, webSocket) {
  try {
    rawSocket.destroy();
  } catch {}
  try {
    webSocket.close();
  } catch {}
}

function pairSockets(rawSocket, webSocket) {
  webSocket.data = { rawSocket };
  rawSocket.on("data", (chunk) => {
    try {
      webSocket.send(chunk);
    } catch {
      closePair(rawSocket, webSocket);
    }
  });
  rawSocket.on("close", () => closePair(rawSocket, webSocket));
  rawSocket.on("error", () => closePair(rawSocket, webSocket));
}

function attemptPairing() {
  while (pendingRawSockets.length > 0 && pendingWebSockets.length > 0) {
    const rawSocket = pendingRawSockets.shift();
    const webSocket = pendingWebSockets.shift();
    if (!rawSocket || !webSocket) return;
    if (rawSocket.destroyed) {
      closePair(rawSocket, webSocket);
      continue;
    }
    pairSockets(rawSocket, webSocket);
  }
}

const rawServer = net.createServer((socket) => {
  pendingRawSockets.push(socket);
  socket.on("close", () => removePending(pendingRawSockets, socket));
  socket.on("error", () => removePending(pendingRawSockets, socket));
  attemptPairing();
});

rawServer.listen(RAW_PORT, "0.0.0.0", () => {
  console.error(`[ios-vnc-proxy] raw relay listening on ${RAW_PORT}`);
});

Bun.serve({
  port: WS_PORT,
  idleTimeout: 255,
  fetch(req, server) {
    if (server.upgrade(req, { data: { rawSocket: null } })) {
      return;
    }
    return new Response("WebSocket upgrade required", { status: 426 });
  },
  websocket: {
    open(ws) {
      pendingWebSockets.push(ws);
      attemptPairing();
    },
    message(ws, message) {
      const rawSocket = ws.data?.rawSocket;
      if (!rawSocket || rawSocket.destroyed) return;
      if (typeof message === "string") {
        rawSocket.write(Buffer.from(message));
        return;
      }
      rawSocket.write(Buffer.from(message));
    },
    close(ws) {
      removePending(pendingWebSockets, ws);
      const rawSocket = ws.data?.rawSocket;
      if (rawSocket && !rawSocket.destroyed) {
        rawSocket.destroy();
      }
    },
  },
});

console.error(`[ios-vnc-proxy] websocket relay listening on ${WS_PORT}`);
