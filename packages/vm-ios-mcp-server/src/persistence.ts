import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const STATE_VERSION = 1;

interface PersistedState<T> {
  version: number;
  allocations: T[];
}

export function getStatePath(): string {
  return (
    process.env.CMUX_VM_IOS_MCP_STATE_PATH ??
    join(homedir(), ".cmux", "runtime", "vm-ios-mcp-server", "allocations.json")
  );
}

export function loadPersistedAllocations<T>(): T[] {
  const statePath = getStatePath();
  if (!existsSync(statePath)) return [];
  try {
    const raw = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedState<T>;
    if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.allocations)) {
      console.warn(
        `[persistence] State file ${statePath} has unexpected shape (version=${parsed.version}), ignoring`,
      );
      return [];
    }
    return parsed.allocations;
  } catch (error) {
    console.error(`[persistence] Failed to load ${statePath}:`, error);
    return [];
  }
}

export function savePersistedAllocations<T>(allocations: T[]): void {
  const statePath = getStatePath();
  const payload: PersistedState<T> = { version: STATE_VERSION, allocations };
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, statePath);
  } catch (error) {
    console.error(`[persistence] Failed to save ${statePath}:`, error);
  }
}
