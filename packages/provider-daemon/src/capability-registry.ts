import type { CapabilityHandler, JsonRpcRequest, JsonRpcResponse } from "./types";

export class CapabilityRegistry {
  private handlers = new Map<string, CapabilityHandler>();
  private methodMap = new Map<string, CapabilityHandler>();

  register(handler: CapabilityHandler): void {
    this.handlers.set(handler.capability, handler);
    for (const method of handler.methods) {
      this.methodMap.set(method, handler);
    }
    console.log(`Registered capability: ${handler.capability} (${handler.methods.length} methods)`);
  }

  getCapabilities(): string[] {
    return Array.from(this.handlers.keys());
  }

  async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const handler = this.methodMap.get(request.method);
    if (!handler) {
      return {
        jsonrpc: "2.0",
        error: {
          code: -32601,
          message: `Method not found: ${request.method}`,
        },
        id: request.id,
      };
    }

    return handler.handle(request);
  }

  async shutdown(): Promise<void> {
    for (const [, handler] of this.handlers) {
      if (handler.shutdown) {
        await handler.shutdown();
      }
    }
  }
}
