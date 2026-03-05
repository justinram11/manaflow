import type { CapabilityHandler, JsonRpcRequest, JsonRpcResponse } from "../../types";
import { DirectMcpBridge, DirectVncBridge } from "./direct-connection";

function getDefaultLocalVncPort(allocationId: string): number {
  let hash = 0;
  for (const char of allocationId) {
    hash = (hash * 31 + char.charCodeAt(0)) % 10000;
  }
  return 45000 + hash;
}

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
  const vncBridges = new Map<string, DirectVncBridge>();

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
                const vncBridge = vncBridges.get(allocId);
                if (vncBridge) {
                  vncBridge.disconnect();
                  vncBridges.delete(allocId);
                }
              }
            }
            break;

          case "connect_direct": {
            const allocId = params.allocationId as string;
            const mcpEndpoint = params.mcpEndpoint as string | undefined;
            const vncEndpoint = params.vncEndpoint as string | undefined;
            const rsyncEndpoint = params.rsyncEndpoint as string | undefined;
            const rsyncSecret = params.rsyncSecret as string | undefined;

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

            // Set up direct MCP bridge
            if (mcpEndpoint) {
              // Disconnect existing bridge if any
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

            // Set up direct VNC bridge
            if (vncEndpoint) {
              const existing = vncBridges.get(allocId);
              if (existing) existing.disconnect();

              const { ensureSimulatorCapture } = await import(
                "@cmux/mac-resource-provider/workspace-manager"
              );
              const localVncPort =
                typeof params.localVncPort === "number"
                  ? params.localVncPort
                  : getDefaultLocalVncPort(allocId);
              const captureUdid = ensureSimulatorCapture(allocId, localVncPort);
              if (!captureUdid) {
                throw new Error(
                  `No simulator available for allocation ${allocId}; cannot start VNC capture`,
                );
              }

              // Parse tcp://host:port format
              const vncUrl = new URL(vncEndpoint);
              const vncBridge = new DirectVncBridge({
                remoteHost: vncUrl.hostname,
                remotePort: parseInt(vncUrl.port, 10),
                localPort: localVncPort,
              });
              vncBridges.set(allocId, vncBridge);
              vncBridge.connect();
              console.log(
                `[resource:ios] Direct VNC bridge created for allocation ${allocId} (simulator ${captureUdid}, local port ${localVncPort})`,
              );
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
              const vncBridge = vncBridges.get(allocId);
              if (vncBridge) {
                vncBridge.disconnect();
                vncBridges.delete(allocId);
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
      // Clean up all direct connections
      for (const [, bridge] of directBridges) {
        bridge.disconnect();
      }
      directBridges.clear();
      for (const [, bridge] of vncBridges) {
        bridge.disconnect();
      }
      vncBridges.clear();
    },
  };
}
