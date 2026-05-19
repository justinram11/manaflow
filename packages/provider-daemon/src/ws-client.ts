import WebSocket from "ws";
import { execSync } from "node:child_process";
import { hostname, platform, arch } from "node:os";
import type { CapabilityRegistry } from "./capability-registry";
import type { DaemonConfig, JsonRpcRequest } from "./types";

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 15_000;
// Resource handlers can block on synchronous build/sync commands. Allow the
// websocket to stay up across those operations instead of self-reconnecting.
const PONG_TIMEOUT_MS = 45 * 60 * 1000;

function getAdvertisedMaxConcurrentSlots(
  capabilities: string[],
  configuredMaxConcurrentSlots?: number,
): number | undefined {
  if (configuredMaxConcurrentSlots !== undefined) {
    return configuredMaxConcurrentSlots;
  }

  const isIosOnlyProvider =
    capabilities.includes("resource:ios-simulator") &&
    !capabilities.includes("compute:incus");

  if (isIosOnlyProvider) {
    return 1;
  }

  return undefined;
}


export class WsClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;
  private closing = false;
  private connectedAt = 0;

  constructor(
    private config: DaemonConfig,
    private registry: CapabilityRegistry,
  ) {}

  connect(): void {
    if (this.closing) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.clearHealthCheck();
    this.clearReconnectTimer();

    const wsUrl = this.config.serverUrl.replace(/^http/, "ws");
    console.log(`Connecting to ${wsUrl}/provider-ws ...`);

    const ws = new WebSocket(`${wsUrl}/provider-ws`, {
      headers: {
        Authorization: `Bearer ${this.config.token}`,
      },
    });
    this.ws = ws;

    ws.on("open", () => {
      if (this.ws !== ws) {
        ws.close();
        return;
      }

      console.log("Connected to server");
      this.reconnectDelay = INITIAL_RECONNECT_DELAY;
      this.lastPong = Date.now();
      this.connectedAt = Date.now();
      this.clearReconnectTimer();
      this.startHealthCheck();

      // Send auth + system info
      const info = this.getSystemInfo();
      this.send({
        type: "auth",
        token: this.config.token,
        info,
      });
    });

    ws.on("message", async (data) => {
      if (this.ws !== ws) {
        return;
      }

      try {
        const msg = JSON.parse(data.toString());
        await this.handleMessage(msg);
      } catch (error) {
        console.error("Failed to handle message:", error);
      }
    });

    ws.on("close", (code, reason) => {
      if (this.ws !== ws) {
        return;
      }

      this.ws = null;
      const connectedForMs = this.connectedAt ? Date.now() - this.connectedAt : 0;
      console.log(
        `Disconnected from server (code=${code}, reason=${reason.toString() || "none"}, connectedForMs=${connectedForMs})`,
      );
      this.clearHealthCheck();
      this.scheduleReconnect();
    });

    ws.on("error", (error) => {
      if (this.ws !== ws) {
        return;
      }
      console.error("WebSocket error:", error);
    });

    ws.on("ping", () => {
      if (this.ws !== ws) {
        return;
      }
      this.lastPong = Date.now();
    });

    ws.on("pong", () => {
      if (this.ws !== ws) {
        return;
      }
      this.lastPong = Date.now();
    });
  }

  private async handleMessage(msg: Record<string, unknown>): Promise<void> {
    // Auth responses
    if (msg.type === "auth_ok") {
      console.log(`Authenticated as provider ${msg.providerId}`);
      return;
    }
    if (msg.type === "auth_error") {
      console.error(`Authentication failed: ${msg.message}`);
      this.closing = true;
      this.ws?.close();
      return;
    }

    // JSON-RPC requests
    if (msg.jsonrpc === "2.0" && msg.method && msg.id !== undefined) {
      try {
        const response = await this.registry.handleRequest(msg as JsonRpcRequest);
        this.send(response);
      } catch (error) {
        console.error(`[ws-client] Unhandled error in handler for ${msg.method}:`, error);
        this.send({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal handler error",
          },
          id: msg.id,
        });
      }
    }
  }

  send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private scheduleReconnect(): void {
    if (this.closing) return;

    this.clearReconnectTimer();
    console.log(`Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  close(): void {
    this.closing = true;
    this.clearHealthCheck();
    this.clearReconnectTimer();
    this.ws?.close();
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      // After sleep/wake, Date.now() jumps forward. If lastPong is stale,
      // the connection is dead — terminate and reconnect immediately.
      if (Date.now() - this.lastPong > PONG_TIMEOUT_MS) {
        console.log("Connection appears stale (no pong received), reconnecting...");
        this.clearHealthCheck();
        this.ws.terminate();
        return;
      }

      this.ws.ping();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private clearHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private getSystemInfo(): Record<string, unknown> {
    const capabilities = this.registry.getCapabilities();
    const advertisedMaxConcurrentSlots = getAdvertisedMaxConcurrentSlots(
      capabilities,
      this.config.maxConcurrentSlots,
    );
    const info: Record<string, unknown> = {
      platform: platform(),
      arch: arch(),
      hostname: hostname(),
      capabilities,
      metadata: {} as Record<string, string>,
    };

    // Get OS version
    try {
      if (platform() === "darwin") {
        info.osVersion = execSync("sw_vers -productVersion", { encoding: "utf-8" }).trim();
      } else {
        info.osVersion = execSync("uname -r", { encoding: "utf-8" }).trim();
      }
    } catch {
      // Ignore
    }

    if (advertisedMaxConcurrentSlots !== undefined) {
      info.maxConcurrentSlots = advertisedMaxConcurrentSlots;
    }

    // Get metadata (xcode version, incus version, etc.)
    const metadata: Record<string, string> = {};
    try {
      if (platform() === "darwin") {
        metadata.xcodeVersion = execSync("xcodebuild -version 2>/dev/null | head -1", {
          encoding: "utf-8",
        }).trim();
      }
    } catch {
      // Ignore
    }
    try {
      metadata.incusVersion = execSync("incus version 2>/dev/null", {
        encoding: "utf-8",
      }).trim();
    } catch {
      // Ignore
    }
    if (capabilities.includes("resource:ios-simulator")) {
      const vmName = process.env.CMUX_TART_BASE_IMAGE ?? "cmux-ios-dev";
      metadata.vmTailscaleHostname =
        process.env.CMUX_TART_VM_TAILSCALE_HOSTNAME?.trim() || `cmux-tart-${vmName}`;
      metadata.vmMcpPort = process.env.CMUX_VM_MCP_PORT ?? "4850";
    }
    if (capabilities.includes("resource:android-emulator")) {
      // The Android provider launches a fresh container per allocation, so the
      // VM MCP hostname is allocation-specific (returned from android.setup).
      // Only the in-container MCP port is static metadata here.
      metadata.androidVmMcpPort = process.env.CMUX_ANDROID_VM_MCP_PORT ?? "4860";
    }
    info.metadata = metadata;

    return info;
  }
}
