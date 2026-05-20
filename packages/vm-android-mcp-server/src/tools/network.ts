import type { ToolDefinition, ToolHandler } from "./index";
import { spawn } from "node:child_process";
import { getAllocation } from "../workspace-manager";
import { exec } from "../exec";

/**
 * Ports we've already proxied. Maps `port` -> child socat pid. The emulator
 * sees the container's loopback as 10.0.2.2, so we only need socat to bind
 * 127.0.0.1:<port> on the container and forward to the workspace.
 */
const activeProxies = new Map<number, number>();

function isPortListening(port: number): boolean {
  try {
    const out = exec(`ss -tnl 'sport = :${port}' | tail -n +2`).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

const androidProxyWorkspacePort: ToolHandler = async (params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");

  const port = Number(params.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: "port must be an integer between 1 and 65535" };
  }
  const workspaceHost =
    (params.workspaceHost as string | undefined) ?? alloc.workspaceHost;
  if (!workspaceHost) {
    return {
      error:
        "No workspaceHost configured for this allocation, and none provided. Pass workspaceHost explicitly.",
    };
  }

  const existing = activeProxies.get(port);
  if (existing) {
    return {
      success: true,
      port,
      workspaceHost,
      target: `${workspaceHost}:${port}`,
      pid: existing,
      reused: true,
      emulatorUrl: `http://10.0.2.2:${port}`,
    };
  }

  if (isPortListening(port)) {
    return {
      error: `127.0.0.1:${port} is already in use by another process in the container.`,
    };
  }

  // socat in fork mode handles multiple concurrent connections. Detached so
  // it survives this RPC call. Output to /var/log/cmux for debugging.
  try {
    exec(`mkdir -p /var/log/cmux`);
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        `exec socat TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr TCP:${workspaceHost}:${port}`,
      ],
      {
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      },
    );
    child.unref();
    if (!child.pid) {
      return { error: "Failed to spawn socat (no pid)" };
    }
    activeProxies.set(port, child.pid);
    // Give socat a moment to bind so a subsequent connection attempt sees it.
    exec(`sleep 0.5`);
    return {
      success: true,
      port,
      workspaceHost,
      target: `${workspaceHost}:${port}`,
      pid: child.pid,
      emulatorUrl: `http://10.0.2.2:${port}`,
    };
  } catch (error) {
    console.error("[android_proxy_workspace_port] failed", error);
    return { error: String(error) };
  }
};

const androidWorkspaceInfo: ToolHandler = async (_params, allocationId) => {
  const alloc = getAllocation(allocationId);
  if (!alloc) throw new Error("Allocation not found");

  return {
    workspaceHost: alloc.workspaceHost ?? null,
    rsyncEndpoint: alloc.rsyncEndpoint ?? null,
    buildDir: alloc.buildDir,
    activeProxies: Array.from(activeProxies.entries()).map(([port, pid]) => ({
      port,
      pid,
      emulatorUrl: `http://10.0.2.2:${port}`,
    })),
    notes:
      "Apps in the emulator reach the android container's loopback at 10.0.2.2. " +
      "Use android_proxy_workspace_port to forward 127.0.0.1:<port> -> workspaceHost:<port>, " +
      "then build the flutter app with --dart-define=API_BASE_URL=http://10.0.2.2:<port>.",
  };
};

export const networkTools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: "android_proxy_workspace_port",
      description:
        "Forward 127.0.0.1:<port> in the android container to <workspaceHost>:<port> via socat. Apps in the emulator then reach the workspace's server at http://10.0.2.2:<port>. Idempotent per port. workspaceHost defaults to the allocation's recorded workspace hostname.",
      inputSchema: {
        type: "object",
        properties: {
          port: { type: "number", description: "TCP port to forward (same number on both sides)" },
          workspaceHost: {
            type: "string",
            description: "Override the recorded workspace hostname",
          },
        },
        required: ["port"],
      },
    },
    handler: androidProxyWorkspacePort,
  },
  {
    definition: {
      name: "android_workspace_info",
      description:
        "Show the workspace hostname, rsync endpoint, and active port proxies for this allocation. Use this to find the right value for API_BASE_URL (always http://10.0.2.2:<port> from inside the emulator after android_proxy_workspace_port).",
      inputSchema: { type: "object", properties: {} },
    },
    handler: androidWorkspaceInfo,
  },
];
