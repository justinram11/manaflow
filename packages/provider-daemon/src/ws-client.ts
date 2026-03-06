import WebSocket from "ws";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname, platform, arch } from "node:os";
import type { CapabilityRegistry } from "./capability-registry";
import type { DaemonConfig, JsonRpcRequest } from "./types";

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 45_000;

function trimTrailingDot(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function getProviderBrowserBaseUrl(capabilities: string[]): string | null {
  const configured = process.env.CMUX_PROVIDER_BROWSER_BASE_URL?.trim();
  if (configured) {
    return configured.endsWith("/") ? configured.slice(0, -1) : configured;
  }

  if (!capabilities.includes("resource:ios-simulator")) {
    return null;
  }

  try {
    const tailscaleBinary = [
      process.env.CMUX_TAILSCALE_BINARY,
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/opt/homebrew/bin/tailscale",
      "tailscale",
    ].find((candidate) => candidate && (candidate === "tailscale" || existsSync(candidate)));
    if (!tailscaleBinary) {
      return null;
    }

    const output = execSync(`"${tailscaleBinary}" status --json`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(output) as {
      Self?: { DNSName?: string };
    };
    const dnsName = parsed.Self?.DNSName?.trim();
    if (dnsName) {
      return `https://${trimTrailingDot(dnsName)}`;
    }
  } catch {
    // Ignore tailscale detection failures.
  }

  return null;
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
    const browserBaseUrl = getProviderBrowserBaseUrl(capabilities);
    if (browserBaseUrl) {
      metadata.browserBaseUrl = browserBaseUrl;
      metadata.iosIngressPort = process.env.CMUX_IOS_INGRESS_PORT ?? "4848";
    }
    info.metadata = metadata;

    return info;
  }
}
