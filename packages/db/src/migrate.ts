import { getDb, closeDb } from "./connection";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "..", "migrations");

console.log("Running migrations...");
const db = getDb();

// Use the appropriate migrator based on the runtime
if (typeof globalThis.Bun !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { migrate } = require("drizzle-orm/bun-sqlite/migrator");
  migrate(db, { migrationsFolder });
} else {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { migrate } = require("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder });
}

console.log("Migrations complete.");
closeDb();
