import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { stopContainersForRunsFromTree } from "./archiveTask";

describe("stopContainersForRunsFromTree - cmux sandbox path", () => {
  let server: ReturnType<typeof createServer> | null = null;
  let serverUrl = "";
  const calls: { method: string; url: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const method = req.method || "";
      const url = req.url || "";
      calls.push({ method, url });
      // Only accept POST /api/sandboxes/:id/stop
      if (
        method === "POST" &&
        url.startsWith("/api/sandboxes/") &&
        url.endsWith("/stop")
      ) {
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    }).listen(0);

    await new Promise<void>((resolve) =>
      server!.on("listening", () => resolve())
    );
    const addr = server.address();
    if (addr && typeof addr === "object" && addr.port) {
      serverUrl = `http://localhost:${addr.port}`;
      process.env.NEXT_PUBLIC_WWW_ORIGIN = serverUrl;
    } else {
      throw new Error("Failed to get test server port");
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("performs POST to sandboxes/{id}/stop and returns success", async () => {
    const now = Date.now();
    const instanceId = "sandbox_test_instance";

    const tree = [
      {
        _id: "rm1",
        _creationTime: now,
        taskId: "tm1",
        prompt: "p",
        status: "running",
        log: "",
        createdAt: now,
        updatedAt: now,
        userId: "test-user",
        teamId: "default",
        vscode: {
          provider: "morph",
          status: "running",
          containerName: instanceId,
        },
        environment: null,
        children: [],
      },
    ];

    const results = await stopContainersForRunsFromTree(tree, "tm1");
    expect(results).toHaveLength(1);
    expect(results[0]?.success).toBe(true);
    expect(results[0]?.containerName).toBe(instanceId);
    expect(results[0]?.provider).toBe("morph");

    // Verify HTTP call
    const hit = calls.find((c) => c.method === "POST");
    expect(hit).toBeTruthy();
    expect(hit?.url).toBe(`/api/sandboxes/${instanceId}/stop`);
  });
});
