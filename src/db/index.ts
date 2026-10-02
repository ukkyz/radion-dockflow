import fs from "node:fs";
import path from "node:path";
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { BOOTSTRAP_SQL } from "./bootstrap";
import * as schema from "./schema";

/**
 * Use a local libsql file by default, or configure a remote Turso/libsql URL.
 */
function resolveDatabaseLocation(): { url: string; path: string | null } {
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return { url: "file::memory:", path: null };
  }

  const configured = process.env.TURSO_DATABASE_URL
    ?? process.env.SQLITE_PATH
    ?? process.env.SQLITE_DB_PATH
    ?? process.env.DB_FILE_NAME;

  if (configured?.trim() && /^(libsql|https?):\/\//.test(configured.trim())) {
    return { url: configured.trim(), path: null };
  }

  const configuredPath = configured?.trim().replace(/^file:/, "");
  const filePath = path.resolve(configuredPath || path.join(process.cwd(), "data", "dockflow.db"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return { url: `file:${filePath}`, path: filePath };
}

const location = resolveDatabaseLocation();
export const databasePath = location.path ?? location.url;
export const sqlite = createClient({
  url: location.url,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

if (process.env.NEXT_PHASE !== "phase-production-build") {
  await sqlite.executeMultiple(BOOTSTRAP_SQL);
}
export const db = drizzle({ client: sqlite });

export async function databaseStats(): Promise<{ path: string; sizeKb: number; tables: number }> {
  let sizeKb = 0;
  if (location.path) {
    try {
      sizeKb = Math.round(fs.statSync(location.path).size / 1024);
    } catch {
      sizeKb = 0;
    }
  }
  let tables = 0;
  try {
    const result = await sqlite.execute("select count(*) as count from sqlite_master where type = 'table'");
    tables = Number(result.rows[0]?.count ?? 0);
  } catch {
    tables = 0;
  }
  return { path: databasePath, sizeKb, tables };
}

export { schema };
