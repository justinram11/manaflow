import * as http from "node:http";
import * as net from "node:net";

/**
 * Firecracker REST API client that communicates over a Unix domain socket.
 *
 * The Firecracker API is a REST API exposed on a Unix socket. We use raw
 * http.request() to communicate over the socket since fetch() doesn't support
 * Unix sockets natively.
 */

interface FirecrackerApiResponse {
  statusCode: number;
  body: string;
}

/**
 * Make an HTTP request to the Firecracker API over a Unix socket.
 */
function firecrackerRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<FirecrackerApiResponse> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;

    const options: http.RequestOptions = {
      socketPath,
      path,
      method,
      headers: {
        Accept: "application/json",
        ...(payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : {}),
      },
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      });
    });

    req.on("error", reject);

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Wait for the Firecracker API socket to become available.
 */
export async function waitForSocket(
  socketPath: string,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ path: socketPath }, () => {
          socket.destroy();
          resolve();
        });
        socket.on("error", (err) => {
          socket.destroy();
          reject(err);
        });
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(
    `Firecracker API socket not available after ${timeoutMs}ms: ${socketPath}`,
  );
}

export interface FirecrackerBootSource {
  kernel_image_path: string;
  boot_args: string;
}

export interface FirecrackerDrive {
  drive_id: string;
  path_on_host: string;
  is_root_device: boolean;
  is_read_only: boolean;
}

export interface FirecrackerMachineConfig {
  vcpu_count: number;
  mem_size_mib: number;
}

export interface FirecrackerNetworkInterface {
  iface_id: string;
  guest_mac: string;
  host_dev_name: string;
}

export interface FirecrackerVmConfig {
  bootSource: FirecrackerBootSource;
  drives: FirecrackerDrive[];
  machineConfig: FirecrackerMachineConfig;
  networkInterfaces: FirecrackerNetworkInterface[];
}

/**
 * Configure and boot a Firecracker microVM.
 *
 * This sets up the boot source, drives, machine config, network interfaces,
 * and then starts the VM.
 */
export async function configureAndBoot(
  socketPath: string,
  config: FirecrackerVmConfig,
): Promise<void> {
  // Set boot source
  const bootRes = await firecrackerRequest(socketPath, "PUT", "/boot-source", {
    kernel_image_path: config.bootSource.kernel_image_path,
    boot_args: config.bootSource.boot_args,
  });
  if (bootRes.statusCode !== 204 && bootRes.statusCode !== 200) {
    throw new Error(
      `Failed to set boot source: ${bootRes.statusCode} ${bootRes.body}`,
    );
  }

  // Set drives
  for (const drive of config.drives) {
    const driveRes = await firecrackerRequest(
      socketPath,
      "PUT",
      `/drives/${drive.drive_id}`,
      {
        drive_id: drive.drive_id,
        path_on_host: drive.path_on_host,
        is_root_device: drive.is_root_device,
        is_read_only: drive.is_read_only,
      },
    );
    if (driveRes.statusCode !== 204 && driveRes.statusCode !== 200) {
      throw new Error(
        `Failed to set drive ${drive.drive_id}: ${driveRes.statusCode} ${driveRes.body}`,
      );
    }
  }

  // Set machine config
  const machRes = await firecrackerRequest(
    socketPath,
    "PUT",
    "/machine-config",
    {
      vcpu_count: config.machineConfig.vcpu_count,
      mem_size_mib: config.machineConfig.mem_size_mib,
    },
  );
  if (machRes.statusCode !== 204 && machRes.statusCode !== 200) {
    throw new Error(
      `Failed to set machine config: ${machRes.statusCode} ${machRes.body}`,
    );
  }

  // Set network interfaces
  for (const iface of config.networkInterfaces) {
    const ifaceRes = await firecrackerRequest(
      socketPath,
      "PUT",
      `/network-interfaces/${iface.iface_id}`,
      {
        iface_id: iface.iface_id,
        guest_mac: iface.guest_mac,
        host_dev_name: iface.host_dev_name,
      },
    );
    if (ifaceRes.statusCode !== 204 && ifaceRes.statusCode !== 200) {
      throw new Error(
        `Failed to set network interface ${iface.iface_id}: ${ifaceRes.statusCode} ${ifaceRes.body}`,
      );
    }
  }

  // Start the VM
  const startRes = await firecrackerRequest(
    socketPath,
    "PUT",
    "/actions",
    { action_type: "InstanceStart" },
  );
  if (startRes.statusCode !== 204 && startRes.statusCode !== 200) {
    throw new Error(
      `Failed to start VM: ${startRes.statusCode} ${startRes.body}`,
    );
  }
}

/**
 * Configure a drive on a Firecracker VM.
 *
 * Called after loadSnapshot(resume=false) to override the rootfs path
 * baked into the snapshot with the new VM-specific copy.
 */
export async function configureDrive(
  socketPath: string,
  drive: FirecrackerDrive,
): Promise<void> {
  const res = await firecrackerRequest(
    socketPath,
    "PUT",
    `/drives/${drive.drive_id}`,
    {
      drive_id: drive.drive_id,
      path_on_host: drive.path_on_host,
      is_root_device: drive.is_root_device,
      is_read_only: drive.is_read_only,
    },
  );
  if (res.statusCode !== 204 && res.statusCode !== 200) {
    throw new Error(
      `Failed to set drive ${drive.drive_id}: ${res.statusCode} ${res.body}`,
    );
  }
}

/**
 * Configure a network interface on a Firecracker VM.
 *
 * Called after loadSnapshot(resume=false) to override the TAP device
 * baked into the snapshot with the newly allocated one.
 */
export async function configureNetworkInterface(
  socketPath: string,
  iface: FirecrackerNetworkInterface,
): Promise<void> {
  const res = await firecrackerRequest(
    socketPath,
    "PUT",
    `/network-interfaces/${iface.iface_id}`,
    {
      iface_id: iface.iface_id,
      guest_mac: iface.guest_mac,
      host_dev_name: iface.host_dev_name,
    },
  );
  if (res.statusCode !== 204 && res.statusCode !== 200) {
    throw new Error(
      `Failed to set network interface ${iface.iface_id}: ${res.statusCode} ${res.body}`,
    );
  }
}

/**
 * Pause a running Firecracker VM.
 */
export async function pauseVM(socketPath: string): Promise<void> {
  const res = await firecrackerRequest(socketPath, "PATCH", "/vm", {
    state: "Paused",
  });
  if (res.statusCode !== 204 && res.statusCode !== 200) {
    throw new Error(`Failed to pause VM: ${res.statusCode} ${res.body}`);
  }
}

/**
 * Resume a paused Firecracker VM.
 */
export async function resumeVM(socketPath: string): Promise<void> {
  const res = await firecrackerRequest(socketPath, "PATCH", "/vm", {
    state: "Resumed",
  });
  if (res.statusCode !== 204 && res.statusCode !== 200) {
    throw new Error(`Failed to resume VM: ${res.statusCode} ${res.body}`);
  }
}

/**
 * Create a full VM snapshot (memory + state).
 */
export async function createSnapshot(
  socketPath: string,
  snapshotPath: string,
  memPath: string,
): Promise<void> {
  const res = await firecrackerRequest(
    socketPath,
    "PUT",
    "/snapshot/create",
    {
      snapshot_type: "Full",
      snapshot_path: snapshotPath,
      mem_file_path: memPath,
    },
  );
  if (res.statusCode !== 204 && res.statusCode !== 200) {
    throw new Error(
      `Failed to create snapshot: ${res.statusCode} ${res.body}`,
    );
  }
}

/**
 * Load a VM snapshot and optionally resume.
 */
export async function loadSnapshot(
  socketPath: string,
  snapshotPath: string,
  memPath: string,
  resumeAfterLoad = true,
): Promise<void> {
  const res = await firecrackerRequest(
    socketPath,
    "PUT",
    "/snapshot/load",
    {
      snapshot_path: snapshotPath,
      mem_backend: {
        backend_type: "File",
        backend_path: memPath,
      },
      resume_vm: resumeAfterLoad,
    },
  );
  if (res.statusCode !== 204 && res.statusCode !== 200) {
    throw new Error(
      `Failed to load snapshot: ${res.statusCode} ${res.body}`,
    );
  }
}
