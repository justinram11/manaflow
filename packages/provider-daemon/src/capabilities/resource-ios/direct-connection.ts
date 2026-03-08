import WebSocket from "ws";

/**
 * DirectMcpBridge connects outbound to the workspace container's WebSocket server,
 * receives JSON-RPC requests from the iOS MCP proxy inside the container,
 * dispatches them to the Mac's MCP handler, and sends responses back.
 *
 * This eliminates the US round-trip through the cmux server for co-located
 * Mac + workspace deployments.
 */
export class DirectMcpBridge {
  private ws: WebSocket | null = null;
  private endpoint: string;
  private allocationId: string;
  private mcpHandler: {
    handleJsonRpcRequest: (msg: Record<string, unknown>) => Promise<unknown>;
  };
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private destroyed = false;

  constructor(opts: {
    endpoint: string;
    allocationId: string;
    mcpHandler: {
      handleJsonRpcRequest: (msg: Record<string, unknown>) => Promise<unknown>;
    };
  }) {
    this.endpoint = opts.endpoint;
    this.allocationId = opts.allocationId;
    this.mcpHandler = opts.mcpHandler;
  }

  connect(): void {
    if (this.destroyed) return;
    this.cleanupWs();

    console.log(`[direct-mcp] Connecting to ${this.endpoint} for allocation ${this.allocationId}`);

    const ws = new WebSocket(this.endpoint);
    this.ws = ws;

    ws.on("open", () => {
      console.log(`[direct-mcp] Connected to workspace for allocation ${this.allocationId}`);
      this.reconnectDelay = 1000; // Reset backoff on success
    });

    ws.on("message", (data: WebSocket.Data) => {
      this.handleMessage(data).catch((err) => {
        console.error(`[direct-mcp] Error handling message:`, err);
      });
    });

    ws.on("close", () => {
      console.log(`[direct-mcp] Connection closed for allocation ${this.allocationId}`);
      this.ws = null;
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      console.error(`[direct-mcp] WebSocket error for allocation ${this.allocationId}:`, err.message);
      // close event will fire after error, triggering reconnect
    });
  }

  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupWs();
    console.log(`[direct-mcp] Disconnected for allocation ${this.allocationId}`);
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private cleanupWs(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private async handleMessage(data: WebSocket.Data): Promise<void> {
    const text = typeof data === "string" ? data : data.toString();
    let request: Record<string, unknown>;

    try {
      request = JSON.parse(text);
    } catch (err) {
      console.error(`[direct-mcp] Failed to parse incoming JSON-RPC:`, err);
      return;
    }

    // Inject _allocationId into params so the handler knows which simulator to use
    const params = (request.params ?? {}) as Record<string, unknown>;
    params._allocationId = this.allocationId;
    request.params = params;

    try {
      const result = await this.mcpHandler.handleJsonRpcRequest({
        jsonrpc: "2.0",
        method: request.method as string,
        params: request.params,
        id: request.id,
      });

      // The MCP handler may return a full JSON-RPC response
      const response =
        result && typeof result === "object" && "jsonrpc" in (result as Record<string, unknown>)
          ? result
          : { jsonrpc: "2.0", result, id: request.id };

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(response));
      }
    } catch (err) {
      const errorResponse = {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : "Unknown error",
        },
        id: request.id,
      };

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(errorResponse));
      }
    }
  }
}

