import { z } from "zod";
import {
  setupAllocation,
  cleanupAllocation,
  getAllocation,
} from "@cmux/incus-resource-provider";
import type { CapabilityHandler, JsonRpcRequest, JsonRpcResponse } from "../../types";

/**
 * resource:android-emulator capability handler.
 *
 * Unlike the iOS resource handler (which targets a pre-existing shared Tart
 * VM), the Android provider launches a fresh `cmux-sandbox-android` Incus
 * container per allocation. The host daemon therefore exposes RPC methods to
 * the backend to drive that container lifecycle.
 */

const SetupParams = z.object({
  allocationId: z.string().min(1),
  accessToken: z.string().min(1),
  tailscaleAuthKey: z.string().optional(),
  workspaceHost: z.string().optional(),
  rsyncEndpoint: z.string().optional(),
  rsyncSecret: z.string().optional(),
});

const CleanupParams = z.object({
  allocationId: z.string().min(1),
});

const StatusParams = z.object({
  allocationId: z.string().min(1),
});

export function createResourceAndroidHandler(): CapabilityHandler {
  return {
    capability: "resource:android-emulator",

    methods: ["android.setup", "android.cleanup", "android.getStatus"],

    async handle(request: JsonRpcRequest): Promise<JsonRpcResponse> {
      try {
        switch (request.method) {
          case "android.setup": {
            const params = SetupParams.parse(request.params ?? {});
            const info = await setupAllocation({
              allocationId: params.allocationId,
              accessToken: params.accessToken,
              tailscaleAuthKey: params.tailscaleAuthKey,
              workspaceHost: params.workspaceHost,
              rsyncEndpoint: params.rsyncEndpoint,
              rsyncSecret: params.rsyncSecret,
            });
            return {
              jsonrpc: "2.0",
              result: {
                allocationId: info.allocationId,
                containerName: info.containerName,
                containerIp: info.containerIp,
                tailscaleHostname: info.tailscaleHostname,
                status: info.status,
              },
              id: request.id,
            };
          }

          case "android.cleanup": {
            const params = CleanupParams.parse(request.params ?? {});
            await cleanupAllocation({ allocationId: params.allocationId });
            return {
              jsonrpc: "2.0",
              result: { success: true },
              id: request.id,
            };
          }

          case "android.getStatus": {
            const params = StatusParams.parse(request.params ?? {});
            const info = getAllocation(params.allocationId);
            return {
              jsonrpc: "2.0",
              result: info
                ? {
                    allocationId: info.allocationId,
                    containerName: info.containerName,
                    containerIp: info.containerIp,
                    tailscaleHostname: info.tailscaleHostname,
                    status: info.status,
                  }
                : null,
              id: request.id,
            };
          }

          default:
            return {
              jsonrpc: "2.0",
              error: {
                code: -32601,
                message: `Method not found: ${request.method}`,
              },
              id: request.id,
            };
        }
      } catch (error) {
        console.error(`[resource:android] Error handling ${request.method}:`, error);
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
      console.log("[resource:android] Shutting down...");
    },
  };
}
