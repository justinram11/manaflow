#!/usr/bin/env bun

import net from "node:net";

const RAW_PORT = 39386;
const WS_PORT = 39387;

/** @typedef {{ rawSocket: net.Socket | null, pairId: string | null }} WsData */

/** @type {net.Socket[]} */
const pendingRawSockets = [];
/** @type {Array<ServerWebSocket<WsData>>} */
const pendingWebSockets = [];
let nextPairId = 1;

function makePairId() {
  return `pair-${nextPairId++}`;
}

function removePending(list, item) {
  const index = list.indexOf(item);
  if (index !== -1) {
    list.splice(index, 1);
  }
}

function closePair(rawSocket, webSocket, reason) {
  const pairId = webSocket.data.pairId ?? "unpaired";
  console.error(`[ios-vnc-proxy] closing ${pairId}: ${reason}`);
  try {
    rawSocket.destroy();
  } catch {}
  try {
    webSocket.close();
  } catch {}
}

function pairSockets(rawSocket, webSocket) {
  const pairId = makePairId();
  webSocket.data.rawSocket = rawSocket;
  webSocket.data.pairId = pairId;

  console.error(
    `[ios-vnc-proxy] paired ${pairId} raw ${rawSocket.remoteAddress}:${rawSocket.remotePort} -> ws ${webSocket.remoteAddress}`,
  );

  rawSocket.on("data", (chunk) => {
    if (webSocket.readyState !== 1) {
      closePair(rawSocket, webSocket, "websocket not open during raw data");
      return;
    }

    const bytes = new Uint8Array(chunk);
    const sent = webSocket.sendBinary(bytes);
    if (sent <= 0) {
      closePair(rawSocket, webSocket, `websocket send failed with status ${sent}`);
      return;
    }

    console.error(`[ios-vnc-proxy] ${pairId} raw->ws ${bytes.byteLength} bytes`);
  });

  rawSocket.on("close", () => {
    closePair(rawSocket, webSocket, "raw socket closed");
  });

  rawSocket.on("error", (error) => {
    console.error(`[ios-vnc-proxy] ${pairId} raw socket error: ${error.message}`);
    closePair(rawSocket, webSocket, "raw socket error");
  });
}

function attemptPairing() {
  while (pendingRawSockets.length > 0 && pendingWebSockets.length > 0) {
    const rawSocket = pendingRawSockets.shift();
    const webSocket = pendingWebSockets.shift();

    if (!rawSocket || !webSocket) {
      return;
    }

    if (rawSocket.destroyed) {
      console.error("[ios-vnc-proxy] skipped destroyed raw socket while pairing");
      try {
        webSocket.close();
      } catch {}
      continue;
    }

    if (webSocket.readyState !== 1) {
      console.error("[ios-vnc-proxy] skipped non-open websocket while pairing");
      try {
        rawSocket.destroy();
      } catch {}
      continue;
    }

    pairSockets(rawSocket, webSocket);
  }
}

const rawServer = net.createServer((socket) => {
  console.error(
    `[ios-vnc-proxy] raw connection from ${socket.remoteAddress}:${socket.remotePort}`,
  );
  pendingRawSockets.push(socket);
  socket.on("close", () => removePending(pendingRawSockets, socket));
  socket.on("error", () => removePending(pendingRawSockets, socket));
  attemptPairing();
});

rawServer.listen(RAW_PORT, "0.0.0.0", () => {
  console.error(`[ios-vnc-proxy] raw relay listening on ${RAW_PORT}`);
});

Bun.serve(
  /** @type {Serve<WsData>} */ ({
    port: WS_PORT,
    idleTimeout: 255,
    fetch(req, server) {
      if (
        server.upgrade(req, {
          data: { rawSocket: null, pairId: null },
        })
      ) {
        return;
      }

      return new Response("WebSocket upgrade required", { status: 426 });
    },
    websocket: {
      open(ws) {
        console.error(`[ios-vnc-proxy] websocket opened from ${ws.remoteAddress}`);
        pendingWebSockets.push(ws);
        attemptPairing();
      },
      message(ws, message) {
        const rawSocket = ws.data.rawSocket;
        const pairId = ws.data.pairId ?? "unpaired";
        if (!rawSocket || rawSocket.destroyed) {
          console.error(`[ios-vnc-proxy] ${pairId} dropping ws message without raw socket`);
          return;
        }

        if (typeof message === "string") {
          rawSocket.write(Buffer.from(message));
          console.error(`[ios-vnc-proxy] ${pairId} ws->raw ${message.length} text bytes`);
          return;
        }

        const bytes = Buffer.from(message);
        rawSocket.write(bytes);
        console.error(`[ios-vnc-proxy] ${pairId} ws->raw ${bytes.length} binary bytes`);
      },
      close(ws) {
        removePending(pendingWebSockets, ws);
        const rawSocket = ws.data.rawSocket;
        const pairId = ws.data.pairId ?? "unpaired";
        console.error(`[ios-vnc-proxy] websocket closed for ${pairId}`);
        if (rawSocket && !rawSocket.destroyed) {
          rawSocket.destroy();
        }
      },
    },
  }),
);

console.error(`[ios-vnc-proxy] websocket relay listening on ${WS_PORT}`);
