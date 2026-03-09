#!/usr/bin/env node
/**
 * Simplified MCP stdio proxy for direct VM MCP server.
 * Runs inside the workspace container, forwards JSON-RPC requests
 * directly to the in-VM MCP server over HTTP (via Tailscale).
 *
 * This replaces the complex ios-resource-proxy.mjs which had WebSocket,
 * multi-hop proxy chain, and reconnection logic.
 *
 * Environment variables:
 *   CMUX_VM_MCP_URL           - VM MCP server URL (e.g. http://cmux-tart-cmux-ios-dev:4850)
 *   CMUX_IOS_ALLOCATION_ID    - Allocation ID to inject into tools/call requests
 *   CMUX_IOS_DIRECT_TOKEN     - Bearer token for REST endpoints (screenshots, tools-call)
 */

import { createInterface } from "node:readline";

const VM_MCP_URL = process.env.CMUX_VM_MCP_URL;
const ALLOCATION_ID = process.env.CMUX_IOS_ALLOCATION_ID;
const TOKEN = process.env.CMUX_IOS_DIRECT_TOKEN;

if (!VM_MCP_URL) {
  process.stderr.write("ERROR: CMUX_VM_MCP_URL not set\n");
  process.exit(1);
}

const jsonRpcUrl = `${VM_MCP_URL}/jsonrpc`;
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
          name: "cmux-ios-vm-proxy",
          version: "1.0.0",
        },
      },
      id,
    });
    return;
  }

  // Ignore notifications
  if (method === "notifications/initialized") {
    return;
  }

  // Inject allocation ID into tools/call requests
  if (method === "tools/call" && ALLOCATION_ID) {
    request.params = request.params || {};
    request.params._allocationId = ALLOCATION_ID;
  }

  try {
    const res = await fetch(jsonRpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      const errorText = await res.text();
      writeResponse({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: `VM MCP server error (${res.status}): ${errorText}`,
        },
        id,
      });
      return;
    }

    const response = await res.json();
    writeResponse(response);
  } catch (error) {
    process.stderr.write(`[ios-vm-proxy] ${method} failed: ${error.message}\n`);
    writeResponse({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: `VM MCP connection error: ${error.message}`,
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
