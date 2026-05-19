import { afterEach, describe, expect, it } from "vitest";
import { loadIncusResourceProviderConfig } from "./config";

describe("loadIncusResourceProviderConfig", () => {
  const originalImage = process.env.CMUX_ANDROID_INCUS_IMAGE;
  const originalPort = process.env.CMUX_ANDROID_VM_MCP_PORT;

  afterEach(() => {
    if (originalImage === undefined) {
      delete process.env.CMUX_ANDROID_INCUS_IMAGE;
    } else {
      process.env.CMUX_ANDROID_INCUS_IMAGE = originalImage;
    }
    if (originalPort === undefined) {
      delete process.env.CMUX_ANDROID_VM_MCP_PORT;
    } else {
      process.env.CMUX_ANDROID_VM_MCP_PORT = originalPort;
    }
  });

  it("defaults to the cmux-sandbox-android image and port 4860", () => {
    delete process.env.CMUX_ANDROID_INCUS_IMAGE;
    delete process.env.CMUX_ANDROID_VM_MCP_PORT;
    const config = loadIncusResourceProviderConfig();
    expect(config.androidImage).toBe("cmux-sandbox-android");
    expect(config.vmMcpPort).toBe(4860);
  });

  it("honors environment overrides", () => {
    process.env.CMUX_ANDROID_INCUS_IMAGE = "custom-android";
    process.env.CMUX_ANDROID_VM_MCP_PORT = "5000";
    const config = loadIncusResourceProviderConfig();
    expect(config.androidImage).toBe("custom-android");
    expect(config.vmMcpPort).toBe(5000);
  });
});
