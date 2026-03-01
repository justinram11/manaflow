import type { CapabilityHandler, JsonRpcRequest, JsonRpcResponse } from "../../types";

/**
 * Resource:ios-simulator capability handler.
 *
 * This is a thin wrapper that delegates to the existing mac-resource-provider
 * MCP handler. The mac-resource-provider package must be installed alongside
 * this daemon on macOS machines.
 *
 * On machines without Xcode/simctl, this capability won't be registered.
 */
export function createResourceIosHandler(): CapabilityHandler {
  // Lazily import the MCP handler from mac-resource-provider
  // This allows the daemon to run on Linux without needing the iOS tools
  let mcpHandler: {
    handleJsonRpcRequest: (msg: Record<string, unknown>) => Promise<unknown>;
    handleSetupAllocation: (params: Record<string, unknown>) => Promise<unknown>;
    handleCleanupAllocation: (params: Record<string, unknown>) => Promise<unknown>;
  } | null = null;

  async function getMcpHandler() {
    if (!mcpHandler) {
      // Dynamic import since this package may not be installed on Linux
      const { handleJsonRpcMessage: handleJsonRpcRequest } = await import("@cmux/mac-resource-provider/mcp-handler");
      const { setupAllocation, cleanupAllocation } = await import(
        "@cmux/mac-resource-provider/workspace-manager"
      );
      mcpHandler = {
        handleJsonRpcRequest,
        handleSetupAllocation: setupAllocation,
        handleCleanupAllocation: cleanupAllocation,
      };
    }
    return mcpHandler;
  }

  return {
    capability: "resource:ios-simulator",

    methods: [
      "tools/list",
      "tools/call",
      "setup_allocation",
      "cleanup_allocation",
      "initialize",
    ],

    async handle(request: JsonRpcRequest): Promise<JsonRpcResponse> {
      try {
        const handler = await getMcpHandler();
        const params = (request.params ?? {}) as Record<string, unknown>;

        let result: unknown;

        switch (request.method) {
          case "setup_allocation":
            result = await handler.handleSetupAllocation(params);
            break;

          case "cleanup_allocation":
            result = await handler.handleCleanupAllocation(params);
            break;

          default:
            // Forward all other methods (tools/list, tools/call, initialize)
            // to the MCP handler as JSON-RPC
            result = await handler.handleJsonRpcRequest({
              jsonrpc: "2.0",
              method: request.method,
              params: request.params,
              id: request.id,
            });
            // The MCP handler returns a full JSON-RPC response
            if (
              result &&
              typeof result === "object" &&
              "jsonrpc" in result
            ) {
              return result as JsonRpcResponse;
            }
            break;
        }

        return { jsonrpc: "2.0", result, id: request.id };
      } catch (error) {
        console.error(`[resource:ios] Error handling ${request.method}:`, error);
        return {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : "Unknown error",
          },
          id: request.id,
        };
      }
    },

    async shutdown() {
      // Clean up all allocations on shutdown
      console.log("[resource:ios] Shutting down...");
    },
  };
}
