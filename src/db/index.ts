import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { BOOTSTRAP_SQL } from "./bootstrap";
import * as schema from "./schema";

/**
 * SQLite storage: a single file on disk, no external database service.
 * Override with SQLITE_PATH / SQLITE_DB_PATH if you want the file elsewhere.
 */
function resolveDatabasePath(): string {
  const configured = process.env.SQLITE_PATH ?? process.env.SQLITE_DB_PATH;
  const file = configured && configured.trim() ? configured.trim().replace(/^file:/, "") : path.join(process.cwd(), "data", "dockflow.db");
  const dir = path.dirname(file);
  if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return file;
}

const globalForDb = globalThis as typeof globalThis & {
  __dockflowSqlite?: Database.Database;
  __dockflowDb?: ReturnType<typeof createDb>;
};

function createDb(client: Database.Database) {
  // Schema is applied on boot so a fresh sandbox/database file needs no migration step.
  client.pragma("journal_mode = WAL");
  client.pragma("foreign_keys = ON");
  client.pragma("busy_timeout = 5000");
  client.exec(BOOTSTRAP_SQL);
  return drizzle(client, { schema });
}

export const databasePath: string = resolveDatabasePath();

export const sqlite: Database.Database = globalForDb.__dockflowSqlite ?? new Database(databasePath);
globalForDb.__dockflowSqlite = sqlite;

export const db: ReturnType<typeof createDb> = globalForDb.__dockflowDb ?? createDb(sqlite);
globalForDb.__dockflowDb = db;

export function databaseStats(): { path: string; sizeKb: number; tables: number } {
  let sizeKb = 0;
  try {
    sizeKb = Math.round(fs.statSync(databasePath).size / 1024);
  } catch {
    sizeKb = 0;
  }
  let tables = 0;
  try {
    const row = sqlite.prepare("select count(*) as count from sqlite_master where type = 'table'").get() as { count: number } | undefined;
    tables = row?.count ?? 0;
  } catch {
    tables = 0;
  }
  return { path: databasePath, sizeKb, tables };
}

export { schema };
