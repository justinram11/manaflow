import { serve } from "@hono/node-server";
import { app } from "./app.ts";
import { env } from "./env.ts";

const port = env.PORT ?? 9780;

console.log(`[compute-provider] Starting on port ${port}...`);

serve({
  fetch: app.fetch,
  port,
});

console.log(`[compute-provider] Ready at http://localhost:${port}`);
console.log(`[compute-provider] Swagger UI: http://localhost:${port}/api/swagger`);
