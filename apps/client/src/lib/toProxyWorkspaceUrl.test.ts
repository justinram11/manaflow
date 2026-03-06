import { beforeAll, describe, expect, it } from "vitest";

let toProxyWorkspaceUrl: typeof import("./toProxyWorkspaceUrl").toProxyWorkspaceUrl;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_WWW_ORIGIN = "http://localhost:5173";
  ({ toProxyWorkspaceUrl } = await import("./toProxyWorkspaceUrl"));
});

describe("toProxyWorkspaceUrl", () => {
  it("rewrites http workspace urls to the same-origin workspace proxy on https pages", () => {
    const result = toProxyWorkspaceUrl(
      "http://ubuntu:40754/?folder=/root/workspace",
      "https://ubuntu.tail486199.ts.net"
    );

    expect(result).toBe(
      "https://ubuntu.tail486199.ts.net/_cmux/workspaces/ubuntu/40754/?folder=/root/workspace"
    );
  });

  it("keeps direct workspace urls on insecure origins", () => {
    const result = toProxyWorkspaceUrl(
      "http://ubuntu:40754/?folder=/root/workspace",
      "http://ubuntu:5173"
    );

    expect(result).toBe("http://ubuntu:40754/?folder=/root/workspace");
  });
});
