import * as net from "node:net";
import { env } from "@/lib/utils/www-env";
import { IncusSandboxInstance } from "./incus-sandbox-instance";
import {
  incusLaunch,
  incusSnapshotCopy,
  incusSnapshotDelete,
  incusDelete,
  incusListContainers,
  waitForContainerIp,
} from "./incus-api";

/**
 * Incus provider for cmux sandboxes.
 *
 * Uses Incus system containers (LXC) as the isolation backend.
 * Each sandbox gets its own container with security.nesting=true for DinD.
 * TCP port proxies forward host ports to the container's internal services,
 * same pattern as the Firecracker provider.
 */

// Ports exposed by the cmux container image (same as Docker/Firecracker providers)
const CONTAINER_PORTS = {
  exec: 39375,
  worker: 39377,
  vscode: 39378,
  proxy: 39379,
  vnc: 39380,
  devtools: 39381,
  pty: 39383,
} as const;

export interface IncusSandboxResult {
  instance: IncusSandboxInstance;
  containerId: string;
  containerName: string;
  hostPorts: Record<number, string>;
  vscodeUrl: string;
  workerUrl: string;
  urls: {
    vscode: string;
    worker: string;
    proxy: string;
    vnc: string;
    pty: string;
  };
}

/**
 * Start a TCP proxy that listens on 0.0.0.0 (random port) and forwards
 * all connections to targetIp:targetPort inside the Incus container.
 *
 * This is the same userspace proxy approach used by the Firecracker provider,
 * which works regardless of network topology (Tailscale, Docker bridge, etc.).
 */
function startPortProxy(
  targetIp: string,
  targetPort: number,
): Promise<{ hostPort: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((clientSocket) => {
      const targetSocket = net.createConnection(
        { host: targetIp, port: targetPort },
        () => {
          clientSocket.pipe(targetSocket);
          targetSocket.pipe(clientSocket);
        },
      );

      targetSocket.on("error", (err) => {
        console.error(
          `[incus-port-proxy] Connection to ${targetIp}:${targetPort} failed:`,
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
        `[incus-port-proxy] Listening on 0.0.0.0:${hostPort} -> ${targetIp}:${targetPort}`,
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
 * Start an Incus sandbox, either fresh from an image or restored from a snapshot.
 *
 * For snapshot restores, the snapshotId format is "containerName/snapshotName".
 */
export async function startIncusSandbox(options?: {
  snapshotId?: string;
  ttlSeconds?: number;
  metadata?: Record<string, string>;
}): Promise<IncusSandboxResult> {
  const sandboxHost = env.SANDBOX_HOST ?? "localhost";
  const imageName = env.INCUS_IMAGE ?? "cmux-sandbox";

  const containerName = `cmux-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const proxyCleanups: Array<() => void> = [];

  try {
    if (options?.snapshotId) {
      // Snapshot restore: incus copy source/snapshot newContainer && incus start
      const slashIndex = options.snapshotId.indexOf("/");
      if (slashIndex === -1) {
        throw new Error(
          `Invalid snapshotId format: "${options.snapshotId}". Expected "containerName/snapshotName".`,
        );
      }
      const sourceContainer = options.snapshotId.slice(0, slashIndex);
      const snapshotName = options.snapshotId.slice(slashIndex + 1);

      await incusSnapshotCopy(sourceContainer, snapshotName, containerName);
      console.log(
        `[incus-provider] Container ${containerName} restored from snapshot ${options.snapshotId}`,
      );
    } else {
      // Fresh launch
      await incusLaunch(imageName, containerName);
      console.log(
        `[incus-provider] Container ${containerName} launched from image ${imageName}`,
      );
    }

    // Wait for the container to get an IP address
    const containerIp = await waitForContainerIp(containerName);

    // Start TCP proxies for each port
    const hostPorts: Record<number, string> = {};

    for (const [, containerPort] of Object.entries(CONTAINER_PORTS)) {
      const proxy = await startPortProxy(containerIp, containerPort);
      hostPorts[containerPort] = String(proxy.hostPort);
      proxyCleanups.push(proxy.close);
    }

    const makeUrl = (port: number) =>
      `http://${sandboxHost}:${hostPorts[port]}`;

    const instance = new IncusSandboxInstance({
      id: containerName,
      containerName,
    });

    return {
      instance,
      containerId: containerName,
      containerName,
      hostPorts,
      vscodeUrl: makeUrl(CONTAINER_PORTS.vscode),
      workerUrl: makeUrl(CONTAINER_PORTS.worker),
      urls: {
        vscode: makeUrl(CONTAINER_PORTS.vscode),
        worker: makeUrl(CONTAINER_PORTS.worker),
        proxy: makeUrl(CONTAINER_PORTS.proxy),
        vnc: makeUrl(CONTAINER_PORTS.vnc),
        pty: makeUrl(CONTAINER_PORTS.pty),
      },
    };
  } catch (error) {
    // Clean up TCP proxies on failure
    for (const cleanup of proxyCleanups) {
      try {
        cleanup();
      } catch (cleanupError) {
        console.error(
          "[incus-provider] Error closing proxy during cleanup:",
          cleanupError,
        );
      }
    }

    // Attempt to delete the container if it was created
    try {
      await incusDelete(containerName);
    } catch (deleteError) {
      // Container may not have been created yet
      console.error(
        `[incus-provider] Cleanup delete of ${containerName} failed (may not exist):`,
        deleteError,
      );
    }

    throw error;
  }
}

/**
 * List snapshots across all cmux-* Incus containers.
 *
 * Returns snapshot IDs in "containerName/snapshotName" format,
 * matching the format expected by startIncusSandbox's snapshotId option.
 */
export async function listSnapshots(): Promise<string[]> {
  const containers = await incusListContainers("cmux-");
  const snapshots: string[] = [];

  for (const container of containers) {
    if (container.snapshots) {
      for (const snap of container.snapshots) {
        snapshots.push(`${container.name}/${snap.name}`);
      }
    }
  }

  return snapshots;
}

/**
 * Delete a snapshot by its ID.
 *
 * @param snapshotId - Format: "containerName/snapshotName"
 */
export async function deleteSnapshot(snapshotId: string): Promise<void> {
  const slashIndex = snapshotId.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(
      `Invalid snapshotId format: "${snapshotId}". Expected "containerName/snapshotName".`,
    );
  }
  const containerName = snapshotId.slice(0, slashIndex);
  const snapshotName = snapshotId.slice(slashIndex + 1);

  await incusSnapshotDelete(containerName, snapshotName);
  console.log(`[incus-provider] Deleted snapshot ${snapshotId}`);
}
