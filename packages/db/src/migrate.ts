import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb, closeDb } from "./connection";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "..", "migrations");

console.log("Running migrations...");
const db = getDb();
migrate(db, { migrationsFolder });
console.log("Migrations complete.");
closeDb();
