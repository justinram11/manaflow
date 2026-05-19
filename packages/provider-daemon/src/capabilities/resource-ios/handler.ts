import type { CapabilityHandler, JsonRpcRequest, JsonRpcResponse } from "../../types";

/**
 * Resource:ios-simulator capability registration for Tart-backed providers.
 *
 * The host daemon only advertises the capability and VM metadata now. Tooling,
 * allocation setup, and simulator management run inside the VM MCP server.
 */
export function createResourceIosHandler(): CapabilityHandler {
  return {
    capability: "resource:ios-simulator",
    methods: [],

    async handle(request: JsonRpcRequest): Promise<JsonRpcResponse> {
      return {
        jsonrpc: "2.0",
        error: {
          code: -32601,
          message: `Method not found: ${request.method}`,
        },
        id: request.id,
      };
    },

    async shutdown() {
      console.log("[resource:ios] Shutting down...");
    },
  };
}
