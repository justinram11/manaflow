import * as net from "node:net";
import { incusAddProxyDevice } from "./cli.ts";

// Ports exposed by the cmux container image (same as Docker/Firecracker providers)
export const CONTAINER_PORTS = {
  exec: 39375,
  worker: 39377,
  vscode: 39378,
  proxy: 39379,
  vnc: 39380,
  devtools: 39381,
  pty: 39383,
  androidVnc: 39384,
  iosRsyncd: 39376,
} as const;

/**
 * Find a free port by binding to port 0 and immediately closing.
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "0.0.0.0", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to allocate free port"));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/**
 * Set up Incus proxy devices for port forwarding.
 *
 * Must be sequential — Incus uses ETags for optimistic concurrency control
 * on container config, so parallel `config device add` calls race and fail.
 *
 * Returns a map from container port → host port number.
 */
export async function setupProxyDevices(
  containerName: string,
  options?: { wantsAndroid?: boolean; wantsIos?: boolean },
): Promise<Record<number, number>> {
  const wantsAndroid = options?.wantsAndroid ?? false;
  const wantsIos = options?.wantsIos ?? false;
  const hostPorts: Record<number, number> = {};

  // iOS ports only when requested
  const iosPortNames = new Set(["iosRsyncd"]);
  // Determine which ports to forward — androidVnc only when requested, iOS ports only when requested
  const portsToForward = Object.entries(CONTAINER_PORTS).filter(
    ([name]) =>
      (name !== "androidVnc" || wantsAndroid) &&
      (!iosPortNames.has(name) || wantsIos),
  );

  for (const [name, containerPort] of portsToForward) {
    const hostPort = await findFreePort();
    await incusAddProxyDevice(
      containerName,
      `cmux-${name}`,
      hostPort,
      containerPort,
    );
    hostPorts[containerPort] = hostPort;
    console.log(
      `[incus-provider] Proxy: host:${hostPort} -> container:${containerPort} (${name})`,
    );
  }

  return hostPorts;
}
