import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema/index";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

let _db: DbClient | undefined;
let _sqlite: Database | undefined;

function getDbPath(): string {
  if (process.env.CMUX_DB_PATH) {
    return process.env.CMUX_DB_PATH;
  }
  const dir = path.join(os.homedir(), ".cmux");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "cmux.db");
}

/**
 * Get the singleton database connection.
 * Configures WAL mode, busy timeout, and foreign keys on first call.
 */
export function getDb(): DbClient {
  if (_db) return _db;

  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _sqlite = new Database(dbPath, { create: true });
  _sqlite.exec("PRAGMA journal_mode = WAL");
  _sqlite.exec("PRAGMA busy_timeout = 5000");
  _sqlite.exec("PRAGMA foreign_keys = ON");

  _db = drizzle(_sqlite, { schema });
  return _db;
}

/**
 * Get the underlying bun:sqlite instance (for raw SQL or migrations).
 */
export function getSqlite(): Database {
  if (!_sqlite) {
    getDb(); // initializes _sqlite as side effect
  }
  return _sqlite!;
}

/**
 * Close the database connection. Useful for graceful shutdown.
 */
export function closeDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = undefined;
    _db = undefined;
  }
}
