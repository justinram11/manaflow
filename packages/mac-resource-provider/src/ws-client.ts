import WebSocket from "ws";
import type { Config } from "./config";
import { execSync } from "node:child_process";

type MessageHandler = (msg: Record<string, unknown>) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private config: Config;
  private onMessage: MessageHandler;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private closed = false;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;

  private static readonly HEALTH_CHECK_INTERVAL_MS = 15_000;
  private static readonly PONG_TIMEOUT_MS = 45_000;

  constructor(config: Config, onMessage: MessageHandler) {
    this.config = config;
    this.onMessage = onMessage;
  }

  connect(): void {
    if (this.closed) return;

    this.clearHealthCheck();

    const wsUrl = this.config.serverUrl
      .replace(/^http/, "ws")
      .replace(/\/$/, "");

    console.log(`Connecting to ${wsUrl}/provider-ws ...`);

    this.ws = new WebSocket(`${wsUrl}/provider-ws`, {
      headers: {
        Authorization: `Bearer ${this.config.token}`,
      },
    });

    this.ws.on("open", () => {
      console.log("Connected to server");
      this.reconnectDelay = 1000;
      this.lastPong = Date.now();
      this.startHealthCheck();

      // Send auth message with system info
      this.send({
        type: "auth",
        token: this.config.token,
        info: this.getSystemInfo(),
      });
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.onMessage(msg);
      } catch (error) {
        console.error("Failed to parse message:", error);
      }
    });

    this.ws.on("close", () => {
      console.log("Disconnected from server");
      this.clearHealthCheck();
      this.scheduleReconnect();
    });

    this.ws.on("error", (error) => {
      console.error("WebSocket error:", error.message);
    });

    this.ws.on("ping", () => {
      this.ws?.pong();
      this.lastPong = Date.now();
    });

    this.ws.on("pong", () => {
      this.lastPong = Date.now();
    });
  }

  send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.closed = true;
    this.clearHealthCheck();
    this.ws?.close();
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      // After sleep/wake, Date.now() jumps forward. If lastPong is stale,
      // the connection is dead — terminate and reconnect immediately.
      if (Date.now() - this.lastPong > WsClient.PONG_TIMEOUT_MS) {
        console.log("Connection appears stale (no pong received), reconnecting...");
        this.clearHealthCheck();
        this.ws.terminate();
        // terminate fires 'close', which calls scheduleReconnect
        return;
      }

      this.ws.ping();
    }, WsClient.HEALTH_CHECK_INTERVAL_MS);
  }

  private clearHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;

    console.log(`Reconnecting in ${this.reconnectDelay}ms...`);
    setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  private getSystemInfo(): Record<string, string | string[]> {
    const info: Record<string, string | string[]> = {
      platform: "macos",
      arch: process.arch === "arm64" ? "arm64" : "x86_64",
    };

    try {
      info.osVersion = execSync("sw_vers -productVersion", { encoding: "utf-8" }).trim();
    } catch {
      info.osVersion = "unknown";
    }

    try {
      info.hostname = execSync("hostname", { encoding: "utf-8" }).trim();
    } catch {
      info.hostname = "unknown";
    }

    try {
      const xcodeOutput = execSync("xcodebuild -version", { encoding: "utf-8" });
      const match = xcodeOutput.match(/Xcode (\S+)/);
      if (match) info.xcodeVersion = match[1];
    } catch {
      // Xcode not installed
    }

    const capabilities: string[] = [];
    try {
      execSync("xcrun simctl list devices", { encoding: "utf-8" });
      capabilities.push("ios-simulator");
    } catch {
      // No simulator support
    }
    info.capabilities = capabilities;

    return info;
  }
}
