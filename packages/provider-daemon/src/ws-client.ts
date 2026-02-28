import WebSocket from "ws";
import { execSync } from "node:child_process";
import { hostname, platform, arch } from "node:os";
import type { CapabilityRegistry } from "./capability-registry";
import type { DaemonConfig, JsonRpcRequest } from "./types";

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30_000;

export class WsClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;

  constructor(
    private config: DaemonConfig,
    private registry: CapabilityRegistry,
  ) {}

  connect(): void {
    if (this.closing) return;

    const wsUrl = this.config.serverUrl.replace(/^http/, "ws");
    console.log(`Connecting to ${wsUrl}/provider-ws ...`);

    this.ws = new WebSocket(`${wsUrl}/provider-ws`, {
      headers: {
        Authorization: `Bearer ${this.config.token}`,
      },
    });

    this.ws.on("open", () => {
      console.log("Connected to server");
      this.reconnectDelay = INITIAL_RECONNECT_DELAY;

      // Send auth + system info
      const info = this.getSystemInfo();
      this.send({
        type: "auth",
        token: this.config.token,
        info,
      });
    });

    this.ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        await this.handleMessage(msg);
      } catch (error) {
        console.error("Failed to handle message:", error);
      }
    });

    this.ws.on("close", () => {
      console.log("Disconnected from server");
      this.scheduleReconnect();
    });

    this.ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });

    this.ws.on("ping", () => {
      this.ws?.pong();
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
      const response = await this.registry.handleRequest(msg as JsonRpcRequest);
      this.send(response);
    }
  }

  send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private scheduleReconnect(): void {
    if (this.closing) return;

    console.log(`Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  close(): void {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.ws?.close();
  }

  private getSystemInfo(): Record<string, unknown> {
    const info: Record<string, unknown> = {
      platform: platform(),
      arch: arch(),
      hostname: hostname(),
      capabilities: this.registry.getCapabilities(),
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
    info.metadata = metadata;

    return info;
  }
}
