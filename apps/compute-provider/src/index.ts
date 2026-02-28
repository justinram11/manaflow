import { serve } from "@hono/node-server";
import { app, provider } from "./app.ts";
import { env } from "./env.ts";
import { reconcileOrphans, startGarbageCollector } from "./garbage-collector.ts";

const port = env.PORT ?? 9780;

console.log(`[compute-provider] Starting on port ${port}...`);

serve({
  fetch: app.fetch,
  port,
});

console.log(`[compute-provider] Ready at http://localhost:${port}`);
console.log(`[compute-provider] Swagger UI: http://localhost:${port}/api/swagger`);

// Reconcile orphaned containers from before this process started
reconcileOrphans().catch((error) => {
  console.error("[compute-provider] Orphan reconciliation failed:", error);
});

// Start TTL-based garbage collection
const stopGc = startGarbageCollector(provider);

process.on("SIGINT", () => {
  stopGc();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopGc();
  process.exit(0);
});
