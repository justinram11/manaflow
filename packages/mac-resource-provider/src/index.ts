import { loadConfig } from "./config";
import { WsClient } from "./ws-client";
import { handleJsonRpcMessage } from "./mcp-handler";
import { setBuildConcurrency } from "./tools/build";

async function main() {
  console.log("cmux Mac Resource Provider starting...");

  const config = loadConfig();
  console.log(`Server: ${config.serverUrl}`);
  console.log(`Max concurrent builds: ${config.maxConcurrentBuilds}`);

  setBuildConcurrency(config.maxConcurrentBuilds);

  const client = new WsClient(config, async (msg) => {
    // Handle auth responses
    if (msg.type === "auth_ok") {
      console.log(`Authenticated as provider: ${msg.providerId}`);
      return;
    }
    if (msg.type === "auth_error") {
      console.error(`Authentication failed: ${msg.message}`);
      return;
    }

    // Handle JSON-RPC requests from server
    if (msg.jsonrpc === "2.0" && msg.method) {
      const response = await handleJsonRpcMessage(msg as Parameters<typeof handleJsonRpcMessage>[0]);
      client.send(response as unknown as Record<string, unknown>);
      return;
    }

    console.log("Unhandled message:", msg);
  });

  client.connect();

  // Graceful shutdown
  const shutdown = () => {
    console.log("Shutting down...");
    client.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
