import { loadConfig } from "./config";
import { CapabilityRegistry } from "./capability-registry";
import { WsClient } from "./ws-client";
import { detectIncus, createComputeIncusHandler } from "./capabilities/compute-incus/index";
import { detectTart, createResourceIosHandler } from "./capabilities/resource-ios/index";
import {
  detectAndroidIncus,
  createResourceAndroidHandler,
} from "./capabilities/resource-android/index";

async function main() {
  console.log("cmux provider daemon starting...");

  // Load configuration
  const config = loadConfig();
  console.log(`Server: ${config.serverUrl}`);

  // Detect capabilities
  const registry = new CapabilityRegistry();

  const [hasIncus, hasTart, hasAndroidIncus] = await Promise.all([
    detectIncus(),
    detectTart(),
    detectAndroidIncus(),
  ]);

  if (hasIncus) {
    registry.register(createComputeIncusHandler());
  }

  if (hasTart) {
    registry.register(createResourceIosHandler());
  }

  if (hasAndroidIncus) {
    registry.register(createResourceAndroidHandler());
  }

  const capabilities = registry.getCapabilities();
  if (capabilities.length === 0) {
    console.error("No capabilities detected. Install incus (Linux) or tart (macOS) to enable capabilities.");
    process.exit(1);
  }

  console.log(`Detected capabilities: ${capabilities.join(", ")}`);

  // Connect to server
  const client = new WsClient(config, registry);
  client.connect();

  // Graceful shutdown
  async function shutdown() {
    console.log("Shutting down...");
    client.close();
    await registry.shutdown();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
