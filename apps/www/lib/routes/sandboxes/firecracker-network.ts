import { execFile } from "node:child_process";
import { execSync } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";

/**
 * TAP network management for Firecracker VMs.
 *
 * Each VM gets its own TAP interface with a /30 subnet from 172.16.0.0/16.
 * The fc-helper.sh sudo script handles the actual TAP/iptables operations.
 */

// Use git to find the project root reliably regardless of bundler output paths
const PROJECT_ROOT = execSync("git rev-parse --show-toplevel", {
  encoding: "utf-8",
}).trim();
const FC_HELPER_PATH = path.join(PROJECT_ROOT, "scripts/fc-helper.sh");

export interface TapAllocation {
  tapName: string;
  guestIp: string;
  hostIp: string;
  guestMac: string;
  subnetIndex: number;
}

// Track allocated subnets to avoid collisions.
// Initialized from kernel state so we skip over TAPs left by previous runs.
const allocatedSubnets = new Set<number>();

// Scan existing fc_tap* devices so we never collide with orphaned TAPs
try {
  const tapOutput = execSync("ip -o link show | grep fc_tap || true", {
    encoding: "utf-8",
  });
  for (const line of tapOutput.split("\n")) {
    const match = line.match(/fc_tap(\d+)/);
    if (match) {
      allocatedSubnets.add(parseInt(match[1], 10));
    }
  }
  if (allocatedSubnets.size > 0) {
    console.log(
      `[firecracker-network] Found existing TAP devices, reserved indices: ${[...allocatedSubnets].join(", ")}`,
    );
  }
} catch {
  // Non-fatal: if we can't scan, we'll rely on the stale cleanup path
}

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
    // Delete stale TAP device if it exists from a previous run
    try {
      await runFcHelper(["tap-delete", tapName]);
    } catch {
      // No stale device to clean up
    }

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
 * Recreate a TAP device with specific name/IPs for snapshot restore.
 *
 * Firecracker snapshots bake in the TAP device name and can't be reconfigured.
 * We must recreate the exact same TAP the snapshot expects.
 */
export async function recreateTap(
  tapName: string,
  guestIp: string,
  guestMac: string,
): Promise<TapAllocation> {
  // Parse subnet index from TAP name (fc_tapN)
  const match = tapName.match(/fc_tap(\d+)/);
  if (!match) {
    throw new Error(`Invalid TAP name for recreate: ${tapName}`);
  }
  const subnetIndex = parseInt(match[1], 10);

  // Calculate host IP from subnet index
  const flatOffset = subnetIndex * 4;
  const octet2 = (flatOffset >> 8) & 0xff;
  const octet3 = flatOffset & 0xff;
  const hostIp = `172.16.${octet2}.${octet3 + 1}`;

  // Reserve the index
  allocatedSubnets.add(subnetIndex);

  try {
    // Delete stale TAP if it exists
    try {
      await runFcHelper(["tap-delete", tapName]);
    } catch {
      // No stale device
    }

    // Create TAP device with the original name/IPs
    await runFcHelper(["tap-create", tapName, hostIp, "30"]);

    // Set up NAT for outbound internet access
    const outboundIface = await getDefaultInterface();
    await runFcHelper(["nat-setup", tapName, guestIp, outboundIface]);

    return { tapName, guestIp, hostIp, guestMac, subnetIndex };
  } catch (error) {
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
 * Start a TCP proxy that listens on 0.0.0.0:hostPort and forwards to guestIp:guestPort.
 *
 * This replaces iptables DNAT which doesn't work reliably across different
 * network interfaces (Tailscale, Docker bridge, etc.) due to FORWARD chain conflicts.
 * A userspace proxy works regardless of the network topology.
 *
 * Returns the listening port and a cleanup function to stop the proxy.
 */
export function startPortProxy(
  guestIp: string,
  guestPort: number,
): Promise<{ hostPort: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((clientSocket) => {
      const targetSocket = net.createConnection(
        { host: guestIp, port: guestPort },
        () => {
          clientSocket.pipe(targetSocket);
          targetSocket.pipe(clientSocket);
        },
      );

      targetSocket.on("error", (err) => {
        console.error(
          `[port-proxy] Connection to ${guestIp}:${guestPort} failed:`,
          err.message,
        );
        clientSocket.destroy();
      });

      clientSocket.on("error", () => {
        targetSocket.destroy();
      });

      clientSocket.on("close", () => {
        targetSocket.destroy();
      });

      targetSocket.on("close", () => {
        clientSocket.destroy();
      });
    });

    server.listen(0, "0.0.0.0", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to allocate proxy port"));
        return;
      }
      const hostPort = addr.port;
      console.log(
        `[port-proxy] Listening on 0.0.0.0:${hostPort} → ${guestIp}:${guestPort}`,
      );
      resolve({
        hostPort,
        close: () => {
          server.close();
        },
      });
    });

    server.on("error", (err) => {
      reject(new Error(`Failed to start port proxy: ${err.message}`));
    });
  });
}

/**
 * Copy a rootfs file using sparse-aware copy (via fc-helper.sh).
 */
export async function copyRootfs(src: string, dst: string): Promise<void> {
  await runFcHelper(["copy-rootfs", src, dst]);
}
