import type { CapabilityHandler, JsonRpcRequest, JsonRpcResponse } from "../../types";
import { DirectMcpBridge } from "./direct-connection";

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

  // Active direct connections keyed by allocation ID
  const directBridges = new Map<string, DirectMcpBridge>();

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
      "connect_direct",
      "disconnect_direct",
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
            // Also clean up any direct connections for this allocation
            {
              const allocId = params.allocationId as string | undefined;
              if (allocId) {
                const bridge = directBridges.get(allocId);
                if (bridge) {
                  bridge.disconnect();
                  directBridges.delete(allocId);
                }
              }
            }
            break;

          case "connect_direct": {
            const allocId = params.allocationId as string;
            const mcpEndpoint = params.mcpEndpoint as string | undefined;
            const rsyncEndpoint = params.rsyncEndpoint as string | undefined;
            const rsyncSecret = params.rsyncSecret as string | undefined;
            const accessToken = params.accessToken as string | undefined;

            if (!allocId) {
              return {
                jsonrpc: "2.0",
                error: { code: -32602, message: "Missing allocationId" },
                id: request.id,
              };
            }

            // Store rsync info for ios_sync_code tool
            if (rsyncEndpoint && rsyncSecret) {
              const { setRsyncInfo } = await import(
                "@cmux/mac-resource-provider/workspace-manager"
              );
              setRsyncInfo(allocId, rsyncEndpoint, rsyncSecret);
              console.log(`[resource:ios] rsync endpoint stored for allocation ${allocId}`);
            }
            if (accessToken || rsyncSecret) {
              const { setAllocationAccessToken } = await import(
                "@cmux/mac-resource-provider/workspace-manager"
              );
              setAllocationAccessToken(allocId, accessToken ?? rsyncSecret ?? "");
            }

            // Set up direct MCP bridge
            if (mcpEndpoint) {
              const existing = directBridges.get(allocId);
              if (existing) existing.disconnect();

              const bridge = new DirectMcpBridge({
                endpoint: mcpEndpoint,
                allocationId: allocId,
                mcpHandler: handler,
              });
              directBridges.set(allocId, bridge);
              bridge.connect();
              console.log(`[resource:ios] Direct MCP bridge created for allocation ${allocId}`);
            }

            result = { connected: true };
            break;
          }

          case "disconnect_direct": {
            const allocId = params.allocationId as string;
            if (allocId) {
              const bridge = directBridges.get(allocId);
              if (bridge) {
                bridge.disconnect();
                directBridges.delete(allocId);
              }
            }
            result = { disconnected: true };
            break;
          }

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
      console.log("[resource:ios] Shutting down...");
      for (const [, bridge] of directBridges) {
        bridge.disconnect();
      }
      directBridges.clear();
    },
  };
}
