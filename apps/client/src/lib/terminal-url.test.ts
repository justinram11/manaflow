import { describe, expect, it } from "vitest";
import { buildTerminalUrl, buildTerminalWebSocketUrl } from "./terminal-url";

describe("terminal url helpers", () => {
  it("preserves workspace proxy prefixes when resolving terminal endpoints", () => {
    const result = buildTerminalUrl(
      "https://ubuntu.tail486199.ts.net/_cmux/workspaces/ubuntu/40759/",
      "/sessions"
    );

    expect(result.toString()).toBe(
      "https://ubuntu.tail486199.ts.net/_cmux/workspaces/ubuntu/40759/sessions"
    );
  });

  it("builds websocket urls under the same workspace proxy prefix", () => {
    const result = buildTerminalWebSocketUrl(
      "https://ubuntu.tail486199.ts.net/_cmux/workspaces/ubuntu/40759/",
      "cmux-terminal"
    );

    expect(result.toString()).toBe(
      "wss://ubuntu.tail486199.ts.net/_cmux/workspaces/ubuntu/40759/sessions/cmux-terminal/ws"
    );
  });
});
