import type { Id } from "@cmux/convex/dataModel";
import type {
  ServerToWorkerEvents,
  WorkerToServerEvents,
  WorkerUploadFiles,
} from "@cmux/shared";
import type { Socket } from "@cmux/shared/socket";
import chokidar, { type FSWatcher } from "chokidar";
import ignore, { type Ignore } from "ignore";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { serverLogger } from "./utils/fileLogger";
import { workerUploadFiles } from "./utils/workerUploadFiles";
import { VSCodeInstance } from "./vscode/VSCodeInstance";

type WorkerSocket = Socket<WorkerToServerEvents, ServerToWorkerEvents>;
type SyncAction = "write" | "delete";

type PendingChange = {
  action: SyncAction;
  absolutePath: string;
  relativePath: string;
};

const DEFAULT_IGNORES = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  "out/",
  ".cache/",
  ".turbo/",
  ".parcel-cache/",
  ".idea/",
  ".vscode/",
  "**/*.log",
];

const MAX_BATCH_FILES = 200;
const MAX_BATCH_BYTES = 6 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 50 * 1024 * 1024;

function normalizeRelativePath(relPath: string): string {
  return relPath.replace(/\\/g, "/");
}

async function buildIgnoreMatcher(workspacePath: string): Promise<Ignore> {
  const ig = ignore();
  try {
    const giPath = path.join(workspacePath, ".gitignore");
    const contents = await fs.readFile(giPath, "utf8");
    ig.add(contents.split("\n"));
  } catch (error) {
    console.error("[localCloudSync] Failed to read .gitignore", error);
  }
  ig.add(DEFAULT_IGNORES);
  return ig;
}

async function collectWorkspaceFiles(
  workspacePath: string,
  ig: Ignore
): Promise<string[]> {
  const files: string[] = [];
  const stack: string[] = [workspacePath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: Array<{
      name: string;
      isFile: () => boolean;
      isDirectory: () => boolean;
      isSymbolicLink: () => boolean;
    }> = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      console.error(
        `[localCloudSync] Failed to read directory ${current}`,
        error
      );
      continue;
    }

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const rel = path.relative(workspacePath, absolutePath);
      if (!rel || rel.startsWith("..")) {
        continue;
      }
      const normalizedRel = normalizeRelativePath(rel);
      const ignorePath = entry.isDirectory()
        ? `${normalizedRel}/`
        : normalizedRel;
      if (ig.ignores(ignorePath)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  return files;
}

class LocalCloudSyncSession {
  private readonly localPath: string;
  private readonly cloudTaskRunId: Id<"taskRuns">;
  private readonly pending = new Map<string, PendingChange>();
  private readonly ignoreMatcher: Ignore;
  private watcher: FSWatcher | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private syncing = false;
  private needsFlush = false;
  private disposed = false;
  private instance: VSCodeInstance | null = null;
  private initialSyncQueued = false;
  private readonly onWorkerConnected = () => {
    this.scheduleFlush(250);
  };
  private readonly onWorkerDisconnected = () => {
    this.scheduleFlush(2000);
  };

  constructor({
    localPath,
    cloudTaskRunId,
    ignoreMatcher,
  }: {
    localPath: string;
    cloudTaskRunId: Id<"taskRuns">;
    ignoreMatcher: Ignore;
  }) {
    this.localPath = localPath;
    this.cloudTaskRunId = cloudTaskRunId;
    this.ignoreMatcher = ignoreMatcher;
  }

  async start(): Promise<void> {
    if (this.disposed) {
      return;
    }

    const ignoredFn = (p: string): boolean => {
      const rel = path.relative(this.localPath, p);
      if (rel.startsWith("..")) return true;
      if (rel === "") return false;
      const normalizedRel = normalizeRelativePath(rel);
      return this.ignoreMatcher.ignores(normalizedRel);
    };

    this.watcher = chokidar.watch(this.localPath, {
      ignored: ignoredFn,
      persistent: true,
      ignoreInitial: true,
      depth: 8,
      usePolling: false,
      awaitWriteFinish: {
        stabilityThreshold: 400,
        pollInterval: 100,
      },
      followSymlinks: false,
      atomic: false,
    });

    this.watcher.on("error", (error) => {
      console.error("[localCloudSync] File watcher error", error);
      serverLogger.error("[localCloudSync] File watcher error", error);
    });

    this.watcher.on("add", (filePath) => {
      this.recordChange(filePath, "write");
    });

    this.watcher.on("change", (filePath) => {
      this.recordChange(filePath, "write");
    });

    this.watcher.on("unlink", (filePath) => {
      this.recordChange(filePath, "delete");
    });

    this.watcher.on("unlinkDir", (dirPath) => {
      this.recordChange(dirPath, "delete");
    });

    await this.queueInitialSync();
  }

  stop(): void {
    this.disposed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.detachInstance();
    this.pending.clear();
  }

  private recordChange(filePath: string, action: SyncAction): void {
    if (this.disposed) {
      return;
    }
    const rel = path.relative(this.localPath, filePath);
    if (!rel || rel.startsWith("..")) {
      return;
    }
    const normalizedRel = normalizeRelativePath(rel);
    const absolutePath = path.join(this.localPath, rel);
    this.pending.set(normalizedRel, {
      action,
      absolutePath,
      relativePath: normalizedRel,
    });
    this.scheduleFlush(500);
  }

  private async queueInitialSync(): Promise<void> {
    if (this.initialSyncQueued) {
      return;
    }
    this.initialSyncQueued = true;
    try {
      const files = await collectWorkspaceFiles(
        this.localPath,
        this.ignoreMatcher
      );
      for (const absolutePath of files) {
        const rel = path.relative(this.localPath, absolutePath);
        if (!rel || rel.startsWith("..")) {
          continue;
        }
        const normalizedRel = normalizeRelativePath(rel);
        this.pending.set(normalizedRel, {
          action: "write",
          absolutePath,
          relativePath: normalizedRel,
        });
      }
      this.scheduleFlush(0);
    } catch (error) {
      console.error("[localCloudSync] Failed to queue initial sync", error);
      serverLogger.error("[localCloudSync] Failed to queue initial sync", error);
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer || this.disposed) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delayMs);
  }

  private async flush(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.syncing) {
      this.needsFlush = true;
      return;
    }
    if (this.pending.size === 0) {
      return;
    }

    this.syncing = true;
    this.needsFlush = false;

    const workerSocket = this.getWorkerSocket();
    if (!workerSocket) {
      this.syncing = false;
      this.scheduleFlush(2000);
      return;
    }

    const entries = Array.from(this.pending.values());
    this.pending.clear();

    try {
      await this.applyChanges(workerSocket, entries);
    } catch (error) {
      console.error("[localCloudSync] Failed to sync changes", error);
      serverLogger.error("[localCloudSync] Failed to sync changes", error);
      for (const entry of entries) {
        this.pending.set(entry.relativePath, entry);
      }
      this.scheduleFlush(2000);
    } finally {
      this.syncing = false;
      if (this.needsFlush && this.pending.size > 0) {
        this.scheduleFlush(250);
      }
    }
  }

  private getWorkerSocket(): WorkerSocket | null {
    if (!this.instance) {
      const instance = VSCodeInstance.getInstance(this.cloudTaskRunId);
      if (instance) {
        this.attachInstance(instance);
      }
    }

    if (!this.instance || !this.instance.isWorkerConnected()) {
      return null;
    }

    try {
      return this.instance.getWorkerSocket();
    } catch (error) {
      console.error("[localCloudSync] Failed to access worker socket", error);
      return null;
    }
  }

  private attachInstance(instance: VSCodeInstance): void {
    if (this.instance === instance) {
      return;
    }
    this.detachInstance();
    this.instance = instance;
    instance.on("worker-connected", this.onWorkerConnected);
    instance.on("worker-disconnected", this.onWorkerDisconnected);
  }

  private detachInstance(): void {
    if (!this.instance) {
      return;
    }
    this.instance.off("worker-connected", this.onWorkerConnected);
    this.instance.off("worker-disconnected", this.onWorkerDisconnected);
    this.instance = null;
  }

  private async applyChanges(
    workerSocket: WorkerSocket,
    entries: PendingChange[]
  ): Promise<void> {
    let batch: WorkerUploadFiles["files"] = [];
    let batchBytes = 0;

    const flushBatch = async (): Promise<void> => {
      if (batch.length === 0) {
        return;
      }
      const payload: WorkerUploadFiles = {
        files: batch,
      };
      await workerUploadFiles({ workerSocket, payload });
      batch = [];
      batchBytes = 0;
    };

    for (const entry of entries) {
      const action = entry.action;
      if (action === "delete") {
        const payload: WorkerUploadFiles["files"][number] = {
          destinationPath: entry.relativePath,
          action: "delete",
        };
        batch.push(payload);
        if (batch.length >= MAX_BATCH_FILES) {
          await flushBatch();
        }
        continue;
      }

      let stats;
      try {
        stats = await fs.lstat(entry.absolutePath);
      } catch (error) {
        console.error(
          `[localCloudSync] Failed to stat ${entry.absolutePath}`,
          error
        );
        const payload: WorkerUploadFiles["files"][number] = {
          destinationPath: entry.relativePath,
          action: "delete",
        };
        batch.push(payload);
        if (batch.length >= MAX_BATCH_FILES) {
          await flushBatch();
        }
        continue;
      }

      if (stats.isSymbolicLink() || !stats.isFile()) {
        continue;
      }

      if (stats.size > MAX_SINGLE_FILE_BYTES) {
        console.error(
          `[localCloudSync] Skipping large file (${stats.size} bytes): ${entry.absolutePath}`
        );
        continue;
      }

      const content = await fs.readFile(entry.absolutePath);
      const estimatedSize = stats.size;
      if (
        batch.length > 0 &&
        (batch.length >= MAX_BATCH_FILES ||
          batchBytes + estimatedSize > MAX_BATCH_BYTES)
      ) {
        await flushBatch();
      }

      batch.push({
        sourcePath: entry.absolutePath,
        destinationPath: entry.relativePath,
        action: "write",
        contentBase64: content.toString("base64"),
        mode: (stats.mode & 0o777).toString(8),
      });
      batchBytes += estimatedSize;
    }

    await flushBatch();
  }
}

export class LocalCloudSyncManager {
  private sessions = new Map<string, LocalCloudSyncSession>();

  async startSync({
    localWorkspacePath,
    cloudTaskRunId,
  }: {
    localWorkspacePath: string;
    cloudTaskRunId: Id<"taskRuns">;
  }): Promise<void> {
    const resolvedPath = path.resolve(localWorkspacePath);
    if (this.sessions.has(resolvedPath)) {
      return;
    }

    let ignoreMatcher: Ignore;
    try {
      ignoreMatcher = await buildIgnoreMatcher(resolvedPath);
    } catch (error) {
      console.error(
        "[localCloudSync] Failed to initialize ignore matcher",
        error
      );
      ignoreMatcher = ignore();
      ignoreMatcher.add(DEFAULT_IGNORES);
    }

    const session = new LocalCloudSyncSession({
      localPath: resolvedPath,
      cloudTaskRunId,
      ignoreMatcher,
    });
    this.sessions.set(resolvedPath, session);

    try {
      await session.start();
      serverLogger.info(
        `[localCloudSync] Started sync from ${resolvedPath} -> ${cloudTaskRunId}`
      );
    } catch (error) {
      console.error("[localCloudSync] Failed to start sync", error);
      serverLogger.error("[localCloudSync] Failed to start sync", error);
      session.stop();
      this.sessions.delete(resolvedPath);
    }
  }

  stopSync(localWorkspacePath: string): void {
    const resolvedPath = path.resolve(localWorkspacePath);
    const session = this.sessions.get(resolvedPath);
    if (session) {
      session.stop();
      this.sessions.delete(resolvedPath);
      serverLogger.info(
        `[localCloudSync] Stopped sync for ${resolvedPath}`
      );
    }
  }
}
