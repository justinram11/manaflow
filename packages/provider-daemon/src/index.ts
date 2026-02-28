import { loadConfig } from "./config";
import { CapabilityRegistry } from "./capability-registry";
import { WsClient } from "./ws-client";
import { detectIncus, createComputeIncusHandler } from "./capabilities/compute-incus/index";
import { detectXcodeSimctl, createResourceIosHandler } from "./capabilities/resource-ios/index";

async function main() {
  console.log("cmux provider daemon starting...");

  // Load configuration
  const config = loadConfig();
  console.log(`Server: ${config.serverUrl}`);

  // Detect capabilities
  const registry = new CapabilityRegistry();

  const [hasIncus, hasXcode] = await Promise.all([
    detectIncus(),
    detectXcodeSimctl(),
  ]);

  if (hasIncus) {
    registry.register(createComputeIncusHandler());
  }

  if (hasXcode) {
    registry.register(createResourceIosHandler());
  }

  const capabilities = registry.getCapabilities();
  if (capabilities.length === 0) {
    console.error("No capabilities detected. Install incus (Linux) or Xcode (macOS) to enable capabilities.");
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
