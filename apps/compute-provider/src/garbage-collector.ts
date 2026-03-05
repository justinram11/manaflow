import type { ComputeProvider } from "./provider.ts";
import { registry } from "./registry.ts";
import { incusListContainers } from "./incus/cli.ts";
import { env } from "./env.ts";

const DEFAULT_TTL_MS = 3_600_000; // 1 hour
const DEFAULT_INTERVAL_MS = 60_000; // 1 minute
const ORPHAN_TTL_MS = 300_000; // 5 minutes — short TTL for orphaned containers

/**
 * Reconcile running Incus containers against the in-memory registry.
 *
 * Any cmux- container found running that isn't tracked in the registry
 * (e.g., after a server restart) gets registered with a short TTL so the
 * GC will clean it up unless a client reclaims it.
 */
export async function reconcileOrphans(): Promise<void> {
  const containers = await incusListContainers("cmux-");
  let orphanCount = 0;

  for (const container of containers) {
    if (container.status !== "Running") continue;
    if (registry.has(container.name)) continue;

    // Never garbage-collect containers that hold snapshots — they are
    // snapshot sources referenced by environments and must be preserved.
    if (container.snapshots && container.snapshots.length > 0) {
      console.log(
        `[gc] Skipping orphan ${container.name} — has ${container.snapshots.length} snapshot(s)`,
      );
      continue;
    }

    const defaultTtlMs = env.CMUX_GC_DEFAULT_TTL_MS ?? DEFAULT_TTL_MS;
    const ttlMs = Math.min(ORPHAN_TTL_MS, defaultTtlMs);

    // Register orphan with dummy ports — we only need the TTL for GC
    registry.register(
      container.name,
      {
        id: container.name,
        status: "running",
        ports: { exec: 0, worker: 0, vscode: 0, proxy: 0, vnc: 0, devtools: 0, pty: 0 },
        host: "localhost",
      },
      { orphan: "true" },
      ttlMs,
    );
    orphanCount++;
    console.log(
      `[gc] Registered orphan container ${container.name} with ${ttlMs}ms TTL`,
    );
  }

  if (orphanCount > 0) {
    console.log(`[gc] Reconciled ${orphanCount} orphan container(s)`);
  }
}

/**
 * Run a single GC sweep: find expired registry entries and destroy them.
 */
async function sweep(provider: ComputeProvider): Promise<void> {
  const expired = registry.getExpired(Date.now());
  if (expired.length === 0) return;

  console.log(`[gc] Found ${expired.length} expired container(s), cleaning up...`);

  for (const entry of expired) {
    try {
      await provider.destroy(entry.id);
      console.log(`[gc] Destroyed expired container ${entry.id}`);
    } catch (error) {
      console.error(`[gc] Failed to destroy container ${entry.id}:`, error);
      // Remove from registry anyway so we don't retry forever
      registry.remove(entry.id);
    }
  }
}

/**
 * Start the garbage collector interval loop.
 *
 * Returns a cleanup function that stops the loop.
 */
export function startGarbageCollector(
  provider: ComputeProvider,
): () => void {
  const intervalMs = env.CMUX_GC_INTERVAL_MS ?? DEFAULT_INTERVAL_MS;

  console.log(`[gc] Starting garbage collector (interval: ${intervalMs}ms)`);

  const timer = setInterval(() => {
    sweep(provider).catch((error) => {
      console.error("[gc] Sweep failed:", error);
    });
  }, intervalMs);

  return () => {
    clearInterval(timer);
    console.log("[gc] Garbage collector stopped");
  };
}
