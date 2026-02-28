import type { LaunchResult } from "./provider.ts";

/**
 * In-memory instance registry tracking launched containers.
 *
 * Maps instance id → status, ports, metadata, and creation time.
 */

interface RegistryEntry {
  id: string;
  status: string;
  paused: boolean;
  ports: LaunchResult["ports"];
  host: string;
  metadata?: Record<string, string>;
  createdAt: number;
}

class InstanceRegistry {
  private entries = new Map<string, RegistryEntry>();

  register(id: string, result: LaunchResult, metadata?: Record<string, string>): void {
    this.entries.set(id, {
      id,
      status: "running",
      paused: false,
      ports: result.ports,
      host: result.host,
      metadata,
      createdAt: Date.now(),
    });
  }

  get(id: string): RegistryEntry | undefined {
    return this.entries.get(id);
  }

  setPaused(id: string, paused: boolean): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.paused = paused;
    }
  }

  setStatus(id: string, status: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.status = status;
    }
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  list(): RegistryEntry[] {
    return [...this.entries.values()];
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }
}

export const registry = new InstanceRegistry();
