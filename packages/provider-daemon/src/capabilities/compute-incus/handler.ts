import type { CapabilityHandler, JsonRpcRequest, JsonRpcResponse } from "../../types";

/**
 * Compute:incus capability handler.
 *
 * Bridges JSON-RPC requests to the local compute-provider HTTP API.
 * The compute-provider app continues to run as a standalone service
 * managing Incus containers, and this handler acts as a JSON-RPC adapter.
 */

const COMPUTE_PROVIDER_URL = process.env.COMPUTE_PROVIDER_URL ?? "http://localhost:9780";
const COMPUTE_PROVIDER_API_KEY = process.env.COMPUTE_PROVIDER_API_KEY ?? "";

async function callComputeProvider(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const url = `${COMPUTE_PROVIDER_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${COMPUTE_PROVIDER_API_KEY}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Compute provider ${method} ${path} failed (${res.status}): ${errorText}`);
  }

  if (res.status === 204) return {};
  return res.json();
}

export const handler: CapabilityHandler = {
  capability: "compute:incus",

  methods: [
    "compute.launch",
    "compute.exec",
    "compute.stop",
    "compute.pause",
    "compute.resume",
    "compute.destroy",
    "compute.getStatus",
    "compute.listInstances",
    "compute.createSnapshot",
    "compute.listSnapshots",
    "compute.deleteSnapshot",
  ],

  async handle(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = (request.params ?? {}) as Record<string, unknown>;

    try {
      let result: unknown;

      switch (request.method) {
        case "compute.launch":
          result = await callComputeProvider("POST", "/api/instances", {
            snapshotId: params.snapshotId as string | undefined,
            displays: params.displays as string[] | undefined,
            wantsIos: params.wantsIos as boolean | undefined,
            metadata: params.metadata as Record<string, string> | undefined,
            ttlSeconds: params.ttlSeconds as number | undefined,
          });
          break;

        case "compute.exec":
          result = await callComputeProvider("POST", `/api/instances/${params.id}/exec`, {
            command: params.command as string,
          });
          break;

        case "compute.stop":
          result = await callComputeProvider("POST", `/api/instances/${params.id}/stop`);
          break;

        case "compute.pause":
          result = await callComputeProvider("POST", `/api/instances/${params.id}/pause`);
          break;

        case "compute.resume":
          result = await callComputeProvider("POST", `/api/instances/${params.id}/resume`);
          break;

        case "compute.destroy":
          result = await callComputeProvider("DELETE", `/api/instances/${params.id}`);
          break;

        case "compute.getStatus":
          result = await callComputeProvider("GET", `/api/instances/${params.id}`);
          break;

        case "compute.listInstances":
          result = await callComputeProvider("GET", "/api/instances");
          break;

        case "compute.createSnapshot":
          result = await callComputeProvider("POST", `/api/instances/${params.id}/snapshots`, {
            name: params.name as string,
          });
          break;

        case "compute.listSnapshots":
          result = await callComputeProvider("GET", "/api/snapshots");
          break;

        case "compute.deleteSnapshot":
          result = await callComputeProvider("DELETE", `/api/snapshots/${params.id}`);
          break;

        default:
          return {
            jsonrpc: "2.0",
            error: { code: -32601, message: `Unknown compute method: ${request.method}` },
            id: request.id,
          };
      }

      return { jsonrpc: "2.0", result, id: request.id };
    } catch (error) {
      console.error(`[compute:incus] Error handling ${request.method}:`, error);
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
};
