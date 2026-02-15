import { execFile } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TAP network management for Firecracker VMs.
 *
 * Each VM gets its own TAP interface with a /30 subnet from 172.16.0.0/16.
 * The fc-helper.sh sudo script handles the actual TAP/iptables operations.
 */

const __fc_dirname = path.dirname(fileURLToPath(import.meta.url));
const FC_HELPER_PATH = path.resolve(
  __fc_dirname,
  "../../../../../../scripts/fc-helper.sh",
);

export interface TapAllocation {
  tapName: string;
  guestIp: string;
  hostIp: string;
  guestMac: string;
  subnetIndex: number;
}

// Track allocated subnets to avoid collisions
const allocatedSubnets = new Set<number>();

// Generate a deterministic MAC address from an index
function generateMac(index: number): string {
  // Use locally-administered, unicast MAC prefix (02:FC:xx:xx:xx:xx)
  const b0 = (index >> 8) & 0xff;
  const b1 = index & 0xff;
  return `02:FC:00:00:${b0.toString(16).padStart(2, "0")}:${b1.toString(16).padStart(2, "0")}`;
}

/**
 * Execute the fc-helper.sh script with sudo.
 */
function runFcHelper(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "sudo",
      [FC_HELPER_PATH, ...args],
      { timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `fc-helper ${args[0]} failed: ${error.message}\nstderr: ${stderr}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/**
 * Get the default outbound network interface.
 */
function getDefaultInterface(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "ip",
      ["route", "show", "default"],
      (error, stdout) => {
        if (error) {
          reject(new Error(`Failed to get default route: ${error.message}`));
          return;
        }
        // Parse "default via X.X.X.X dev <iface> ..."
        const match = stdout.match(/dev\s+(\S+)/);
        if (!match) {
          reject(new Error("Could not parse default interface from ip route"));
          return;
        }
        resolve(match[1]);
      },
    );
  });
}

/**
 * Allocate a TAP device and /30 subnet for a new Firecracker VM.
 *
 * Each VM gets a /30 subnet from 172.16.0.0/16:
 *   - Subnet N → 172.16.{N/64}.{(N%64)*4} /30
 *   - Host IP: .1 within the /30
 *   - Guest IP: .2 within the /30
 *
 * This allows up to ~16k VMs (172.16.0.0/16 ÷ /30 = 16384 subnets).
 */
export async function allocateTap(): Promise<TapAllocation> {
  // Find a free subnet index
  let subnetIndex = 0;
  while (allocatedSubnets.has(subnetIndex)) {
    subnetIndex++;
    if (subnetIndex >= 16384) {
      throw new Error("No more available subnets for Firecracker VMs");
    }
  }
  allocatedSubnets.add(subnetIndex);

  // Calculate IPs from subnet index
  // Each /30 uses 4 addresses: network, host, guest, broadcast
  const flatOffset = subnetIndex * 4;
  const octet2 = (flatOffset >> 8) & 0xff;
  const octet3 = flatOffset & 0xff;

  const hostIp = `172.16.${octet2}.${octet3 + 1}`;
  const guestIp = `172.16.${octet2}.${octet3 + 2}`;
  const guestMac = generateMac(subnetIndex);
  const tapName = `fc_tap${subnetIndex}`;

  try {
    // Create TAP device
    await runFcHelper(["tap-create", tapName, hostIp, "30"]);

    // Set up NAT for outbound internet access
    const outboundIface = await getDefaultInterface();
    await runFcHelper(["nat-setup", tapName, guestIp, outboundIface]);

    return { tapName, guestIp, hostIp, guestMac, subnetIndex };
  } catch (error) {
    // Clean up on failure
    allocatedSubnets.delete(subnetIndex);
    try {
      await runFcHelper(["tap-delete", tapName]);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Release a TAP device and clean up iptables rules.
 */
export async function releaseTap(allocation: TapAllocation): Promise<void> {
  try {
    const outboundIface = await getDefaultInterface();
    await runFcHelper([
      "nat-teardown",
      allocation.tapName,
      allocation.guestIp,
      outboundIface,
    ]);
  } catch (error) {
    console.error(
      `[firecracker-network] NAT teardown failed for ${allocation.tapName}:`,
      error,
    );
  }

  try {
    await runFcHelper(["tap-delete", allocation.tapName]);
  } catch (error) {
    console.error(
      `[firecracker-network] TAP delete failed for ${allocation.tapName}:`,
      error,
    );
  }

  allocatedSubnets.delete(allocation.subnetIndex);
}

/**
 * Set up port forwarding from a host port to a guest IP:port.
 */
export async function addPortForward(
  hostPort: number,
  guestIp: string,
  guestPort: number,
): Promise<void> {
  const outboundIface = await getDefaultInterface();
  await runFcHelper([
    "port-forward-add",
    String(hostPort),
    guestIp,
    String(guestPort),
    outboundIface,
  ]);
}

/**
 * Remove port forwarding.
 */
export async function removePortForward(
  hostPort: number,
  guestIp: string,
  guestPort: number,
): Promise<void> {
  const outboundIface = await getDefaultInterface();
  await runFcHelper([
    "port-forward-del",
    String(hostPort),
    guestIp,
    String(guestPort),
    outboundIface,
  ]);
}

/**
 * Allocate an ephemeral port on the host.
 * Binds to port 0, reads the assigned port, and releases the socket.
 */
export function allocateEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to allocate ephemeral port"));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/**
 * Copy a rootfs file using sparse-aware copy (via fc-helper.sh).
 */
export async function copyRootfs(src: string, dst: string): Promise<void> {
  await runFcHelper(["copy-rootfs", src, dst]);
}
