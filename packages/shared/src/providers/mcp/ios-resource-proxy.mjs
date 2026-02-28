#!/usr/bin/env node
/**
 * MCP stdio proxy for iOS resource provider.
 * Runs inside the workspace container, proxies MCP JSON-RPC requests
 * to the cmux server which forwards them to the Mac daemon.
 *
 * Environment variables:
 *   CMUX_MCP_PROXY_URL - Server endpoint for MCP proxying
 *   CMUX_TASK_RUN_JWT  - JWT for authentication
 */

import { createInterface } from "node:readline";

const PROXY_URL = process.env.CMUX_MCP_PROXY_URL;
const JWT = process.env.CMUX_TASK_RUN_JWT;

if (!PROXY_URL) {
  process.stderr.write("ERROR: CMUX_MCP_PROXY_URL not set\n");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin });

function writeResponse(response) {
  process.stdout.write(JSON.stringify(response) + "\n");
}

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
    return; // No response needed for notifications
  }

  // Proxy everything else to the server
  try {
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
      writeResponse({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: `Proxy error (${res.status}): ${errorText}`,
        },
        id,
      });
      return;
    }

    const response = await res.json();
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
