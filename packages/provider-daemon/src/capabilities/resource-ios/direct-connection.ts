import WebSocket from "ws";
import * as net from "node:net";

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

/**
 * DirectVncBridge creates a TCP connection to the workspace container's
 * iOS VNC input port and bridges it to a local VNC capture server.
 */
export class DirectVncBridge {
  private socket: net.Socket | null = null;
  private localPort: number;
  private remoteHost: string;
  private remotePort: number;
  private destroyed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;

  constructor(opts: {
    remoteHost: string;
    remotePort: number;
    localPort: number;
  }) {
    this.remoteHost = opts.remoteHost;
    this.remotePort = opts.remotePort;
    this.localPort = opts.localPort;
  }

  connect(): void {
    if (this.destroyed) return;
    this.cleanup();

    console.log(`[direct-vnc] Connecting to ${this.remoteHost}:${this.remotePort} → localhost:${this.localPort}`);

    const remote = net.connect(this.remotePort, this.remoteHost);
    this.socket = remote;

    remote.on("connect", () => {
      console.log(`[direct-vnc] Connected to workspace VNC input`);
      this.reconnectDelay = 1000;

      // Bridge to local VNC capture server
      const local = net.connect(this.localPort, "127.0.0.1");

      local.on("connect", () => {
        console.log(`[direct-vnc] Bridged to local VNC capture on port ${this.localPort}`);
        remote.pipe(local);
        local.pipe(remote);
      });

      local.on("error", (err) => {
        console.error(`[direct-vnc] Local VNC error:`, err.message);
        remote.destroy();
      });

      local.on("close", () => {
        remote.destroy();
      });

      remote.on("close", () => {
        local.destroy();
      });
    });

    remote.on("error", (err) => {
      console.error(`[direct-vnc] Remote connection error:`, err.message);
    });

    remote.on("close", () => {
      this.socket = null;
      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      }
    });
  }

  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanup();
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  private cleanup(): void {
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* ignore */ }
      this.socket = null;
    }
  }
}
