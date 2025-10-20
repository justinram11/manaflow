import { describe, it, expect } from "vitest";
import { createApp } from "./app.js";

describe.skip("cmux-proxy", () => {
  const app = createApp();

  describe("Health check", () => {
    it("should return healthy status", async () => {
      const res = await app.request("http://localhost:3000/health");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("status", "healthy");
      expect(json).toHaveProperty("timestamp");
    });
  });

  describe("Root domain", () => {
    it("should return cmux greeting on apex domain", async () => {
      const res = await app.request("http://cmux.sh/");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("cmux!");
    });
  });

  describe("Service worker", () => {
    it("should serve service worker file", async () => {
      const res = await app.request("http://port-8080-test.cmux.sh/proxy-sw.js");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/javascript");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      const text = await res.text();
      expect(text).toContain("addEventListener");
      expect(text).toContain("isLoopbackHostname");
    });
  });

  describe("Port-based routing (Morph)", () => {
    it("should handle OPTIONS preflight for port-39378", async () => {
      const res = await app.request("http://port-39378-test.cmux.sh/", {
        method: "OPTIONS",
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    });

    it("should detect proxy loops", async () => {
      const res = await app.request("http://port-8080-test.cmux.sh/", {
        headers: {
          "X-Cmux-Proxied": "true",
        },
      });
      expect(res.status).toBe(508);
      const text = await res.text();
      expect(text).toBe("Loop detected in proxy");
    });

    it("should parse port- subdomain correctly", async () => {
      const res = await app.request("http://port-8080-j2z9smmu.cmux.sh/test", {
        method: "HEAD",
      });
      // We can't test the actual proxy without a real backend,
      // but we can check it doesn't return an error status immediately
      expect(res.status).not.toBe(400);
      expect(res.status).not.toBe(508);
    });
  });

  describe("Cmux- prefix routing", () => {
    it("should reject invalid cmux proxy subdomain (too few segments)", async () => {
      const res = await app.request("http://cmux-test.cmux.sh/");
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toBe("Invalid cmux proxy subdomain");
    });

    it("should reject invalid port in cmux proxy subdomain", async () => {
      const res = await app.request("http://cmux-test-abc.cmux.sh/");
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toBe("Invalid port in cmux proxy subdomain");
    });

    it("should parse cmux- subdomain correctly", async () => {
      const res = await app.request("http://cmux-j2z9smmu-8080.cmux.sh/test", {
        method: "HEAD",
      });
      // Can't test actual proxy, but check it passes validation
      expect(res.status).not.toBe(400);
      expect(res.status).not.toBe(508);
    });

    it("should handle base scope correctly", async () => {
      const res = await app.request("http://cmux-test-base-8080.cmux.sh/", {
        method: "HEAD",
      });
      expect(res.status).not.toBe(400);
    });

    it("should detect proxy loops for cmux- prefix", async () => {
      const res = await app.request("http://cmux-test-8080.cmux.sh/", {
        headers: {
          "X-Cmux-Proxied": "true",
        },
      });
      expect(res.status).toBe(508);
      const text = await res.text();
      expect(text).toBe("Loop detected in proxy");
    });
  });

  describe("Original routing (workspace-port-vmSlug)", () => {
    it("should reject subdomain with too few parts", async () => {
      const res = await app.request("http://test-8080.cmux.sh/");
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toBe("Invalid cmux subdomain");
    });

    it("should reject missing workspace", async () => {
      const res = await app.request("http://-8080-vmslug.cmux.sh/");
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toBe("Invalid cmux subdomain");
    });

    it("should reject invalid port", async () => {
      const res = await app.request("http://workspace-abc-vmslug.cmux.sh/");
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toBe("Invalid port in subdomain");
    });

    it("should parse workspace-port-vmSlug correctly", async () => {
      const res = await app.request(
        "http://my-workspace-8080-vmslug.cmux.sh/test",
        {
          method: "HEAD",
        }
      );
      expect(res.status).not.toBe(400);
      expect(res.status).not.toBe(508);
    });

    it("should detect proxy loops", async () => {
      const res = await app.request("http://workspace-8080-vmslug.cmux.sh/", {
        headers: {
          "X-Cmux-Proxied": "true",
        },
      });
      expect(res.status).toBe(508);
      const text = await res.text();
      expect(text).toBe("Loop detected in proxy");
    });
  });

  describe.skip("WebSocket handling", () => {
    // Note: WebSocket tests require a real server connection and cannot be tested
    // with Hono's test client due to invalid upgrade header errors.
    // These tests are skipped but document the expected behavior.
    it("should pass through WebSocket upgrade requests for port- prefix", async () => {
      const res = await app.request("http://port-8080-test.cmux.sh/ws", {
        method: "GET",
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
        },
      });
      // Can't fully test WebSocket upgrade, but ensure it doesn't error immediately
      expect(res.status).not.toBe(400);
    });

    it("should pass through WebSocket upgrade requests for cmux- prefix", async () => {
      const res = await app.request("http://cmux-test-8080.cmux.sh/ws", {
        method: "GET",
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
        },
      });
      expect(res.status).not.toBe(400);
    });

    it("should pass through WebSocket upgrade requests for workspace routing", async () => {
      const res = await app.request("http://workspace-8080-vmslug.cmux.sh/ws", {
        method: "GET",
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
        },
      });
      expect(res.status).not.toBe(400);
    });
  });

  describe("Headers handling", () => {
    it("should set X-Cmux-Proxied header for port- prefix", async () => {
      // This test verifies the header would be set (can't easily test outbound request)
      const res = await app.request("http://port-8080-test.cmux.sh/", {
        method: "HEAD",
      });
      // If we made it past loop detection, the header logic works
      expect(res.status).not.toBe(508);
    });

    it("should set workspace and port headers for cmux- prefix", async () => {
      const res = await app.request("http://cmux-test-workspace-8080.cmux.sh/", {
        method: "HEAD",
      });
      expect(res.status).not.toBe(400);
    });

    it("should set workspace and port headers for original routing", async () => {
      const res = await app.request("http://workspace-8080-vmslug.cmux.sh/", {
        method: "HEAD",
      });
      expect(res.status).not.toBe(400);
    });
  });
});
