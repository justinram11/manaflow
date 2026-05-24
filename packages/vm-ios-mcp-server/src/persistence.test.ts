import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getStatePath,
  loadPersistedAllocations,
  savePersistedAllocations,
} from "./persistence";

interface TestAllocation {
  allocationId: string;
  buildDir: string;
  rsyncEndpoint?: string;
}

describe("persistence (iOS)", () => {
  let tmpDir: string;
  let statePath: string;
  const originalEnv = process.env.CMUX_VM_IOS_MCP_STATE_PATH;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cmux-vm-ios-mcp-test-"));
    statePath = join(tmpDir, "nested", "allocations.json");
    process.env.CMUX_VM_IOS_MCP_STATE_PATH = statePath;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv === undefined) {
      delete process.env.CMUX_VM_IOS_MCP_STATE_PATH;
    } else {
      process.env.CMUX_VM_IOS_MCP_STATE_PATH = originalEnv;
    }
  });

  it("honors CMUX_VM_IOS_MCP_STATE_PATH env override", () => {
    expect(getStatePath()).toBe(statePath);
  });

  it("returns empty when state file does not exist", () => {
    expect(loadPersistedAllocations<TestAllocation>()).toEqual([]);
  });

  it("creates parent directory on save", () => {
    savePersistedAllocations<TestAllocation>([{ allocationId: "a", buildDir: "/b" }]);
    expect(existsSync(statePath)).toBe(true);
  });

  it("round-trips allocations through save and load", () => {
    const allocations: TestAllocation[] = [
      { allocationId: "alloc-1", buildDir: "/tmp/build-1" },
      { allocationId: "alloc-2", buildDir: "/tmp/build-2", rsyncEndpoint: "rsync://host" },
    ];
    savePersistedAllocations<TestAllocation>(allocations);
    expect(loadPersistedAllocations<TestAllocation>()).toEqual(allocations);
  });

  it("ignores state files with the wrong version", () => {
    savePersistedAllocations<TestAllocation>([{ allocationId: "a", buildDir: "/b" }]);
    writeFileSync(
      statePath,
      JSON.stringify({ version: 999, allocations: [{ allocationId: "a", buildDir: "/b" }] }),
    );
    expect(loadPersistedAllocations<TestAllocation>()).toEqual([]);
  });

  it("ignores malformed JSON without throwing", () => {
    savePersistedAllocations<TestAllocation>([]); // ensures parent dir exists
    writeFileSync(statePath, "{not json");
    expect(loadPersistedAllocations<TestAllocation>()).toEqual([]);
  });

  it("final state after many sequential writes is the last one (atomic rename)", () => {
    for (let i = 0; i < 20; i++) {
      savePersistedAllocations<TestAllocation>([
        { allocationId: `alloc-${i}`, buildDir: `/tmp/build-${i}` },
      ]);
    }
    expect(loadPersistedAllocations<TestAllocation>()).toEqual([
      { allocationId: "alloc-19", buildDir: "/tmp/build-19" },
    ]);
  });
});
