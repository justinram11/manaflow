import * as schema from "./schema/index";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Use a union type that covers both sync (bun-sqlite) and async (libsql) drizzle instances.
// In practice, only one branch executes per runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbClient = any;

let _db: DbClient | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _underlying: any | undefined;
let _isBun: boolean | undefined;

function getDbPath(): string {
  if (process.env.CMUX_DB_PATH) {
    return process.env.CMUX_DB_PATH;
  }
  const dir = path.join(os.homedir(), ".cmux");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "cmux.db");
}

function detectBun(): boolean {
  if (_isBun !== undefined) return _isBun;
  _isBun = typeof globalThis.Bun !== "undefined";
  return _isBun;
}

/**
 * Get the singleton database connection.
 * Uses bun:sqlite in Bun runtime, @libsql/client in Node.js.
 * Both are synchronous for local SQLite files.
 */
export function getDb(): DbClient {
  if (_db) return _db;

  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (detectBun()) {
    // Bun runtime: use bun:sqlite (synchronous)
    // Dynamic require to avoid Node.js parse errors
    const { Database } = require("bun:sqlite");
    const sqlite = new Database(dbPath, { create: true });
    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA busy_timeout = 5000");
    sqlite.exec("PRAGMA foreign_keys = ON");
    _underlying = sqlite;

    const { drizzle } = require("drizzle-orm/bun-sqlite");
    _db = drizzle(sqlite, { schema });
  } else {
    // Node.js runtime: use better-sqlite3 (synchronous)
    const BetterSqlite3 = require("better-sqlite3");
    const sqlite = new BetterSqlite3(dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("busy_timeout = 5000");
    sqlite.pragma("foreign_keys = ON");
    _underlying = sqlite;

    const { drizzle } = require("drizzle-orm/better-sqlite3");
    _db = drizzle(sqlite, { schema });
  }

  return _db;
}

/**
 * Get the underlying SQLite instance (bun:sqlite Database or better-sqlite3 instance).
 */
export function getSqlite() {
  if (!_underlying) {
    getDb(); // initializes _underlying as side effect
  }
  return _underlying;
}

/**
 * Close the database connection. Useful for graceful shutdown.
 */
export function closeDb(): void {
  if (_underlying) {
    _underlying.close();
    _underlying = undefined;
    _db = undefined;
  }
}
