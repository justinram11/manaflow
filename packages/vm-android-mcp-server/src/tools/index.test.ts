import { describe, expect, it } from "vitest";
import { getTool, getToolDefinitions } from "./index";

describe("vm-android-mcp-server tool registry", () => {
  it("registers all expected android tools", () => {
    const names = getToolDefinitions().map((t) => t.name);
    const expected = [
      "android_boot",
      "android_list_devices",
      "android_install_apk",
      "android_launch",
      "android_screenshot",
      "android_tap",
      "android_text",
      "android_key",
      "android_logcat",
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });

  it("returns a handler for each registered tool", () => {
    for (const def of getToolDefinitions()) {
      const tool = getTool(def.name);
      expect(tool).toBeDefined();
      expect(typeof tool?.handler).toBe("function");
    }
  });

  it("gives each tool a non-empty description and object input schema", () => {
    for (const def of getToolDefinitions()) {
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.inputSchema.type).toBe("object");
    }
  });

  it("returns undefined for an unknown tool", () => {
    expect(getTool("android_does_not_exist")).toBeUndefined();
  });
});
