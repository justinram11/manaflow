import { describe, expect, it } from "vitest";
import { app } from "./app.ts";

describe("bearer auth middleware", () => {
  const validToken = process.env.COMPUTE_PROVIDER_API_KEY ?? "dev-secret-key";

  it("rejects requests without Authorization header", async () => {
    const res = await app.request("/api/instances", { method: "GET" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe("Missing Authorization header");
  });

  it("rejects requests with invalid token", async () => {
    const res = await app.request("/api/instances", {
      method: "GET",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe("Invalid API key");
  });

  it("rejects requests with malformed Authorization header", async () => {
    const res = await app.request("/api/instances", {
      method: "GET",
      headers: { Authorization: "Basic abc123" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.message).toBe("Invalid Authorization header format");
  });

  it("allows requests with valid bearer token", async () => {
    const res = await app.request("/api/instances", {
      method: "GET",
      headers: { Authorization: `Bearer ${validToken}` },
    });
    // Should get 200 (empty list from provider) not 401
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("instances");
  });

  it("allows unauthenticated access to /api/doc", async () => {
    const res = await app.request("/api/doc", { method: "GET" });
    expect(res.status).toBe(200);
  });

  it("allows unauthenticated access to /api/swagger", async () => {
    const res = await app.request("/api/swagger", { method: "GET" });
    expect(res.status).toBe(200);
  });
});
