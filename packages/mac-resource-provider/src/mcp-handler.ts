import { getToolDefinitions, getTool } from "./tools/index";
import { setupAllocation, cleanupAllocation } from "./workspace-manager";

interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params?: Record<string, unknown>;
  id: string | number;
}

interface JsonRpcResponse {
  jsonrpc: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: string | number;
}

export async function handleJsonRpcMessage(msg: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { method, params, id } = msg;

  try {
    switch (method) {
      case "tools/list": {
        const tools = getToolDefinitions();
        return {
          jsonrpc: "2.0",
          result: { tools },
          id,
        };
      }

      case "tools/call": {
        const toolName = params?.name as string;
        const toolArgs = (params?.arguments as Record<string, unknown>) ?? {};
        const allocationId = (params?._allocationId as string) ?? "";

        const tool = getTool(toolName);
        if (!tool) {
          return {
            jsonrpc: "2.0",
            error: { code: -32601, message: `Unknown tool: ${toolName}` },
            id,
          };
        }

        const result = await tool.handler(toolArgs, allocationId);
        return {
          jsonrpc: "2.0",
          result: {
            content: [
              {
                type: "text",
                text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
              },
            ],
          },
          id,
        };
      }

      case "setup_allocation": {
        const result = setupAllocation({
          allocationId: params?.allocationId as string,
          buildDir: params?.buildDir as string,
          simulatorDeviceType: (params?.simulatorDeviceType as string) || "iPhone 16 Pro",
          simulatorRuntime: (params?.simulatorRuntime as string) || "iOS-18-6",
        });
        return {
          jsonrpc: "2.0",
          result: { success: true, ...result },
          id,
        };
      }

      case "cleanup_allocation": {
        cleanupAllocation({
          allocationId: params?.allocationId as string,
          buildDir: params?.buildDir as string | undefined,
          simulatorUdid: params?.simulatorUdid as string | undefined,
        });
        return {
          jsonrpc: "2.0",
          result: { success: true },
          id,
        };
      }

      case "initialize": {
        return {
          jsonrpc: "2.0",
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: "cmux-ios-resource-provider",
              version: "1.0.0",
            },
          },
          id,
        };
      }

      default:
        return {
          jsonrpc: "2.0",
          error: { code: -32601, message: `Unknown method: ${method}` },
          id,
        };
    }
  } catch (error) {
    console.error(`Error handling ${method}:`, error);
    return {
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : "Internal error",
      },
      id,
    };
  }
}
