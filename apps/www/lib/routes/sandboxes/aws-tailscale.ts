/**
 * Tailscale API integration for the AWS compute provider.
 *
 * Handles:
 *  - Generating ephemeral auth keys for workspace instances
 *  - Discovering Tailscale IPs by hostname
 *  - Sharing nodes to external tailnets
 *  - Cleaning up nodes on instance termination
 */

/** Tailscale device info from the API. */
export interface TailscaleDevice {
  id: string;
  hostname: string;
  addresses: string[]; // Tailscale IPs (100.x.x.x)
  online: boolean;
  lastSeen: string;
  os: string;
  tags?: string[];
}

/** Tailscale auth key. */
export interface TailscaleAuthKey {
  id: string;
  key: string;
  expires: string;
}

const TAILSCALE_API_BASE = "https://api.tailscale.com/api/v2";

/**
 * Create a Tailscale API client bound to a specific tailnet.
 */
export function createTailscaleClient(opts: {
  apiKey: string;
  tailnet: string;
}) {
  const { apiKey, tailnet } = opts;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  async function apiRequest<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${TAILSCALE_API_BASE}${path}`;
    const res = await fetch(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Tailscale API ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`,
      );
    }

    // Some endpoints return empty body (204)
    const text = await res.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  return {
    /**
     * Create an ephemeral, pre-authorized auth key for a workspace instance.
     * Ephemeral keys auto-deregister the node when the instance goes offline.
     */
    async createAuthKey(opts?: {
      description?: string;
      tags?: string[];
      expirySeconds?: number;
    }): Promise<TailscaleAuthKey> {
      return apiRequest<TailscaleAuthKey>(
        "POST",
        `/tailnet/${tailnet}/keys`,
        {
          capabilities: {
            devices: {
              create: {
                reusable: false,
                ephemeral: true,
                preauthorized: true,
                tags: opts?.tags ?? ["tag:workspace"],
              },
            },
          },
          expirySeconds: opts?.expirySeconds ?? 300, // 5 min to use it
          description: opts?.description ?? "cmux workspace",
        },
      );
    },

    /**
     * Find a device by hostname. Returns null if not found or not yet online.
     */
    async findDeviceByHostname(
      hostname: string,
    ): Promise<TailscaleDevice | null> {
      const res = await apiRequest<{ devices: TailscaleDevice[] }>(
        "GET",
        `/tailnet/${tailnet}/devices`,
      );

      return (
        res.devices.find(
          (d) => d.hostname === hostname || d.hostname === `${hostname}.`,
        ) ?? null
      );
    },

    /**
     * Poll for a device to appear and come online.
     * Used after EC2 instance launch to discover the Tailscale IP.
     */
    async waitForDevice(
      hostname: string,
      timeoutMs = 120_000,
    ): Promise<TailscaleDevice> {
      const start = Date.now();
      const interval = 5_000;

      while (Date.now() - start < timeoutMs) {
        const device = await this.findDeviceByHostname(hostname);
        if (device && device.addresses.length > 0) {
          return device;
        }
        await new Promise((r) => setTimeout(r, interval));
      }

      throw new Error(
        `Tailscale device "${hostname}" did not appear within ${timeoutMs}ms`,
      );
    },

    /**
     * Share a device to another tailnet (for node sharing with external tailnets).
     */
    async shareDevice(
      deviceId: string,
      targetTailnet: string,
    ): Promise<void> {
      await apiRequest(
        "POST",
        `/device/${deviceId}/shares/invite`,
        { email: targetTailnet },
      );
    },

    /**
     * Delete/remove a device from the tailnet.
     * Used for cleanup when ephemeral key doesn't auto-deregister.
     */
    async deleteDevice(deviceId: string): Promise<void> {
      await apiRequest("DELETE", `/device/${deviceId}`);
    },

    /**
     * List all devices in the tailnet with a specific tag.
     */
    async listDevicesByTag(tag: string): Promise<TailscaleDevice[]> {
      const res = await apiRequest<{ devices: TailscaleDevice[] }>(
        "GET",
        `/tailnet/${tailnet}/devices`,
      );

      return res.devices.filter((d) => d.tags?.includes(tag));
    },
  };
}

export type TailscaleClient = ReturnType<typeof createTailscaleClient>;

/**
 * Generate the user-data script that configures Tailscale on an EC2 instance.
 * This runs on first boot after the AMI (which already has Tailscale installed).
 */
export function generateTailscaleUserData(opts: {
  authKey: string;
  hostname: string;
}): string {
  // User-data scripts run as root on first boot
  return `#!/bin/bash
set -euo pipefail

# Enable and start Tailscale
systemctl enable --now tailscaled

# Wait for tailscaled to be ready
sleep 2

# Join the tailnet with the ephemeral auth key
tailscale up \\
  --authkey="${opts.authKey}" \\
  --hostname="${opts.hostname}" \\
  --ssh \\
  --accept-routes

echo "Tailscale configured: hostname=${opts.hostname}"
`;
}
