import type {
  ComputeProvider,
  ExecResult,
  InstanceInfo,
  InstanceStatus,
  LaunchOptions,
  LaunchResult,
  SnapshotInfo,
} from "../provider.ts";
import { registry } from "../registry.ts";
import { env } from "../env.ts";
import {
  incusLaunch,
  incusSnapshotCopy,
  incusContainerExec,
  incusStop,
  incusPause,
  incusResume,
  incusDelete,
  incusSnapshotCreate,
  incusSnapshotDelete,
  incusListContainers,
  incusAddDevice,
} from "./cli.ts";
import { configureContainerNetwork } from "./networking.ts";
import { enableGraphicalServices, enableSimulatorDisplays } from "./graphical.ts";
import { CONTAINER_PORTS, setupProxyDevices } from "./port-allocation.ts";

/**
 * IncusProvider implements ComputeProvider using Incus system containers (LXC).
 */
export class IncusProvider implements ComputeProvider {
  async launch(opts: LaunchOptions): Promise<LaunchResult> {
    const sandboxHost = env.SANDBOX_HOST ?? "localhost";
    const imageName = opts.image ?? env.INCUS_IMAGE ?? "cmux-sandbox";
    const containerName = `cmux-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      let launchedFromSnapshot = false;
      if (opts.snapshotId) {
        // Snapshot restore: incus copy source/snapshot newContainer && incus start
        const slashIndex = opts.snapshotId.indexOf("/");
        if (slashIndex === -1) {
          console.warn(
            `[incus-provider] Invalid snapshotId format: "${opts.snapshotId}". Expected "containerName/snapshotName". Falling back to fresh image.`,
          );
        } else {
          const sourceContainer = opts.snapshotId.slice(0, slashIndex);
          const snapshotName = opts.snapshotId.slice(slashIndex + 1);

          try {
            await incusSnapshotCopy(sourceContainer, snapshotName, containerName);
            console.log(
              `[incus-provider] Container ${containerName} restored from snapshot ${opts.snapshotId}`,
            );
            launchedFromSnapshot = true;
          } catch (snapshotErr) {
            console.warn(
              `[incus-provider] Snapshot restore failed for "${opts.snapshotId}", falling back to fresh image:`,
              snapshotErr,
            );
          }
        }
      }
      if (!launchedFromSnapshot) {
        // Fresh launch
        await incusLaunch(imageName, containerName);
        console.log(
          `[incus-provider] Container ${containerName} launched from image ${imageName}`,
        );
      }

      // Configure IPv4 networking
      await configureContainerNetwork(containerName);

      // Add TUN device for Tailscale networking (harmless if unused)
      try {
        await incusAddDevice(containerName, "tun", "unix-char", {
          source: "/dev/net/tun",
          path: "/dev/net/tun",
        });
      } catch (tunError) {
        console.error(`[incus-provider] Failed to add TUN device to ${containerName}:`, tunError);
      }

      // Ensure localhost resolves (Docker build can't write /etc/hosts)
      await incusContainerExec(containerName, [
        "sh", "-c", "printf '127.0.0.1 localhost\\n::1 localhost\\n' > /etc/hosts",
      ]);

      // Enable graphical environment
      await enableGraphicalServices(containerName);

      // Conditionally enable Android display services and KVM passthrough
      const wantsAndroid = opts.displays?.includes("android") ?? false;
      if (wantsAndroid) {
        await incusAddDevice(containerName, "kvm", "unix-char", {
          source: "/dev/kvm",
          path: "/dev/kvm",
        });
        await enableSimulatorDisplays(containerName);
      }

      // Set up proxy devices for port forwarding
      const wantsIos = opts.wantsIos ?? false;
      const hostPortMap = await setupProxyDevices(containerName, { wantsAndroid, wantsIos });

      const ports: LaunchResult["ports"] = {
        exec: hostPortMap[CONTAINER_PORTS.exec]!,
        worker: hostPortMap[CONTAINER_PORTS.worker]!,
        vscode: hostPortMap[CONTAINER_PORTS.vscode]!,
        proxy: hostPortMap[CONTAINER_PORTS.proxy]!,
        vnc: hostPortMap[CONTAINER_PORTS.vnc]!,
        devtools: hostPortMap[CONTAINER_PORTS.devtools]!,
        pty: hostPortMap[CONTAINER_PORTS.pty]!,
        ...(wantsAndroid && hostPortMap[CONTAINER_PORTS.androidVnc] !== undefined
          ? { androidVnc: hostPortMap[CONTAINER_PORTS.androidVnc] }
          : {}),
        ...(wantsIos && hostPortMap[CONTAINER_PORTS.iosMcp] !== undefined
          ? { iosMcp: hostPortMap[CONTAINER_PORTS.iosMcp] }
          : {}),
        ...(wantsIos && hostPortMap[CONTAINER_PORTS.iosVncIn] !== undefined
          ? { iosVncIn: hostPortMap[CONTAINER_PORTS.iosVncIn] }
          : {}),
        ...(wantsIos && hostPortMap[CONTAINER_PORTS.iosVnc] !== undefined
          ? { iosVnc: hostPortMap[CONTAINER_PORTS.iosVnc] }
          : {}),
        ...(wantsIos && hostPortMap[CONTAINER_PORTS.iosRsyncd] !== undefined
          ? { iosRsyncd: hostPortMap[CONTAINER_PORTS.iosRsyncd] }
          : {}),
      };

      const result: LaunchResult = {
        id: containerName,
        status: "running",
        ports,
        host: sandboxHost,
      };

      // Register in the in-memory registry
      const ttlMs = opts.ttlSeconds ? opts.ttlSeconds * 1000 : undefined;
      registry.register(containerName, result, opts.metadata, ttlMs);

      return result;
    } catch (error) {
      // Attempt to delete the container if it was created
      try {
        await incusDelete(containerName);
      } catch (deleteError) {
        console.error(
          `[incus-provider] Cleanup delete of ${containerName} failed (may not exist):`,
          deleteError,
        );
      }
      throw error;
    }
  }

  async exec(id: string, command: string): Promise<ExecResult> {
    const result = await incusContainerExec(id, ["bash", "-lc", command]);
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async stop(id: string): Promise<void> {
    await incusStop(id);
    registry.setStatus(id, "stopped");
  }

  async pause(id: string): Promise<void> {
    await incusPause(id);
    registry.setPaused(id, true);
  }

  async resume(id: string): Promise<void> {
    await incusResume(id);
    registry.setPaused(id, false);
  }

  async destroy(id: string): Promise<void> {
    // Attempt graceful stop first, then force-delete
    try {
      await incusStop(id);
    } catch (error) {
      console.error(
        `[incus-provider] Graceful stop failed for ${id}, will force-delete:`,
        error,
      );
    }
    await incusDelete(id);
    registry.remove(id);
  }

  async getStatus(id: string): Promise<InstanceStatus | null> {
    const entry = registry.get(id);
    if (!entry) {
      return null;
    }
    return {
      id: entry.id,
      status: entry.status,
      paused: entry.paused,
      ports: entry.ports,
      metadata: entry.metadata,
      createdAt: entry.createdAt,
    };
  }

  async listInstances(): Promise<InstanceInfo[]> {
    return registry.list().map((entry) => ({
      id: entry.id,
      status: entry.status,
      paused: entry.paused,
      ports: entry.ports,
      metadata: entry.metadata,
      createdAt: entry.createdAt,
    }));
  }

  async createSnapshot(id: string, name: string): Promise<string> {
    // Pause → snapshot → resume cycle
    await incusPause(id);
    registry.setPaused(id, true);
    try {
      await incusSnapshotCreate(id, name);
    } finally {
      await incusResume(id);
      registry.setPaused(id, false);
    }
    return `${id}/${name}`;
  }

  async listSnapshots(): Promise<SnapshotInfo[]> {
    const containers = await incusListContainers("cmux-");
    const snapshots: SnapshotInfo[] = [];

    for (const container of containers) {
      if (container.snapshots) {
        for (const snap of container.snapshots) {
          snapshots.push({
            id: `${container.name}/${snap.name}`,
            containerName: container.name,
            snapshotName: snap.name,
            createdAt: snap.created_at,
            stateful: snap.stateful,
          });
        }
      }
    }

    return snapshots;
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    const slashIndex = snapshotId.indexOf("/");
    if (slashIndex === -1) {
      throw new Error(
        `Invalid snapshotId format: "${snapshotId}". Expected "containerName/snapshotName".`,
      );
    }
    const containerName = snapshotId.slice(0, slashIndex);
    const snapshotName = snapshotId.slice(slashIndex + 1);
    await incusSnapshotDelete(containerName, snapshotName);
  }
}
