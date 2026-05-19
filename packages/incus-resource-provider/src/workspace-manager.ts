import {
  incusLaunch,
  incusDelete,
  incusAddUnixCharDevice,
  incusExec,
  configureContainerNetwork,
  waitForContainerIp,
} from "./incus";

/** Incus image alias for the Android emulator container. */
const ANDROID_IMAGE = process.env.CMUX_ANDROID_INCUS_IMAGE ?? "cmux-sandbox-android";
/** Port the in-container vm-android-mcp-server listens on. */
const VM_MCP_PORT = Number(process.env.CMUX_ANDROID_VM_MCP_PORT) || 4860;

export interface AndroidAllocationInfo {
  allocationId: string;
  /** Incus container name for this allocation. */
  containerName: string;
  /** Container IPv4 address, once assigned. */
  containerIp?: string;
  /** Tailscale MagicDNS hostname, if Tailscale is enabled. */
  tailscaleHostname?: string;
  status: "launching" | "ready" | "failed" | "released";
  accessToken?: string;
  createdAt: number;
}

const allocations = new Map<string, AndroidAllocationInfo>();

function containerNameFor(allocationId: string): string {
  // Incus container names must be DNS-safe and <= 63 chars.
  const safeId = allocationId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 24);
  return `cmux-android-${safeId}`;
}

/**
 * Launch a fresh Android emulator container for an allocation.
 *
 * - `incus launch cmux-sandbox-android`
 * - passes through /dev/kvm and /dev/net/tun
 * - optionally joins the Tailscale network
 * - waits for an IP; the in-container systemd unit boots the MCP server
 */
export async function setupAllocation(params: {
  allocationId: string;
  accessToken: string;
  tailscaleAuthKey?: string;
}): Promise<AndroidAllocationInfo> {
  const { allocationId, accessToken } = params;

  const existing = allocations.get(allocationId);
  if (existing) {
    return existing;
  }

  const containerName = containerNameFor(allocationId);
  const info: AndroidAllocationInfo = {
    allocationId,
    containerName,
    status: "launching",
    accessToken,
    createdAt: Date.now(),
  };
  allocations.set(allocationId, info);

  try {
    await incusLaunch(ANDROID_IMAGE, containerName);

    // /dev/kvm is required for hardware-accelerated emulation.
    await incusAddUnixCharDevice(containerName, "kvm", "/dev/kvm", "/dev/kvm");

    // TUN device for Tailscale (harmless if Tailscale is not used).
    try {
      await incusAddUnixCharDevice(containerName, "tun", "/dev/net/tun", "/dev/net/tun");
    } catch (tunError) {
      console.error(`[incus-resource] Failed to add TUN device to ${containerName}:`, tunError);
    }

    // Docker-exported images lack a DHCP client; bootstrap networking.
    await configureContainerNetwork(containerName);

    const ip = await waitForContainerIp(containerName, 90_000);
    info.containerIp = ip;

    // Join Tailscale so the backend can reach the MCP server via MagicDNS.
    if (params.tailscaleAuthKey) {
      try {
        info.tailscaleHostname = containerName;
        await incusExec(containerName, [
          "bash",
          "-lc",
          `tailscale up --authkey='${params.tailscaleAuthKey}' --hostname='${containerName}' --accept-dns=true || true`,
        ], { timeout: 60_000 });
      } catch (tsError) {
        console.error(`[incus-resource] Tailscale up failed for ${containerName}:`, tsError);
      }
    }

    // The MCP server starts via the cmux-android-mcp.service systemd unit.
    // Boot the allocation inside it once the server is reachable.
    await waitForMcpServer(containerName);
    await callVmMcp(containerName, "setup_allocation", {
      allocationId,
      buildDir: `/tmp/cmux-builds/${allocationId}`,
      accessToken,
    });

    // Start the Android display services so VNC streaming works.
    try {
      await incusExec(containerName, [
        "systemctl",
        "start",
        "cmux-android-xvfb.service",
        "cmux-android-tigervnc.service",
        "cmux-android-vnc-proxy.service",
      ]);
    } catch (displayError) {
      console.error(
        `[incus-resource] Failed to start Android display services in ${containerName}:`,
        displayError,
      );
    }

    info.status = "ready";
    return info;
  } catch (error) {
    console.error(`[incus-resource] setupAllocation failed for ${allocationId}:`, error);
    info.status = "failed";
    // Best-effort cleanup of a partially-created container.
    try {
      await incusDelete(containerName);
    } catch (deleteError) {
      console.error(`[incus-resource] cleanup delete of ${containerName} failed:`, deleteError);
    }
    throw error;
  }
}

/** Force-delete the allocation's container. */
export async function cleanupAllocation(params: { allocationId: string }): Promise<void> {
  const { allocationId } = params;
  const info = allocations.get(allocationId);
  const containerName = info?.containerName ?? containerNameFor(allocationId);

  try {
    await incusDelete(containerName);
  } catch (error) {
    console.error(`[incus-resource] cleanupAllocation failed for ${allocationId}:`, error);
  }

  if (info) {
    info.status = "released";
  }
  allocations.delete(allocationId);
}

export function getAllocation(allocationId: string): AndroidAllocationInfo | undefined {
  return allocations.get(allocationId);
}

export function getAllAllocations(): AndroidAllocationInfo[] {
  return Array.from(allocations.values());
}

/** Wait until the in-container MCP server answers /health. */
async function waitForMcpServer(containerName: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await incusExec(containerName, [
      "bash",
      "-lc",
      `curl -sf http://127.0.0.1:${VM_MCP_PORT}/health`,
    ], { timeout: 10_000 });
    if (result.exitCode === 0) {
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`MCP server in ${containerName} not ready within ${timeoutMs}ms`);
}

/** Call a JSON-RPC method on the in-container MCP server via `incus exec` + curl. */
async function callVmMcp(
  containerName: string,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
    id: `host-${method}-${Date.now()}`,
  });
  const result = await incusExec(containerName, [
    "bash",
    "-lc",
    `curl -sf -X POST http://127.0.0.1:${VM_MCP_PORT}/jsonrpc ` +
      `-H 'Content-Type: application/json' -d '${body.replace(/'/g, `'"'"'`)}'`,
  ], { timeout: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(`VM MCP ${method} failed in ${containerName}: ${result.stderr}`);
  }
}
