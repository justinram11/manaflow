import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { bearerAuth } from "./auth.ts";
import { createInstanceRoutes } from "./routes/instances.ts";
import { createSnapshotRoutes } from "./routes/snapshots.ts";
import { IncusProvider } from "./incus/provider.ts";

const provider = new IncusProvider();

const app = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      }));
      return c.json({ code: 422, message: "Validation Error", errors }, 422);
    }
  },
}).basePath("/api");

// Middleware
app.use("*", logger());
app.use("*", prettyJSON());

// Auth on API routes only (exclude /doc and /swagger)
app.use("/instances/*", bearerAuth);
app.use("/instances", bearerAuth);
app.use("/snapshots/*", bearerAuth);
app.use("/snapshots", bearerAuth);

// Routes
const instanceRoutes = createInstanceRoutes(provider);
const snapshotRoutes = createSnapshotRoutes(provider);

app.route("/", instanceRoutes);
app.route("/", snapshotRoutes);

// OpenAPI documentation
app.doc("/doc", {
  openapi: "3.0.0",
  info: {
    version: "1.0.0",
    title: "Compute Provider API",
    description: "API for managing compute instances (Incus containers)",
  },
});

app.get("/swagger", swaggerUI({ url: "/api/doc" }));

// 404 handler
app.notFound((c) => {
  return c.json(
    { code: 404, message: `Route ${c.req.path} not found` },
    404,
  );
});

// Error handler
app.onError((err, c) => {
  console.error(`${err}`);
  return c.json(
    { code: 500, message: "Internal Server Error" },
    500,
  );
});

export { app, provider };
