import fs from "node:fs";
import path from "node:path";
import { createClient, type Client, type Config } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { BOOTSTRAP_SQL } from "./bootstrap";

//
//Database layer: libsql (@libsql/client) + drizzle-orm v1 (libsql driver).
//
//`url` resolution order:
//  1. LIBSQL_URL / TURSO_DATABASE_URL
//  2. DATABASE_URL (ignored when it is a postgres:// URL from an older template)
//  3. local file: <cwd>/data/dockflow.db
//
//Supported targets:
//  - local SQLite file        file:./data/dockflow.db
//  - Turso / sqld over HTTP   libsql://my-db.turso.io      (+ LIBSQL_AUTH_TOKEN)
//  - sqld over websockets     ws://127.0.0.1:8080
//  - embedded replica         LIBSQL_SYNC_URL=<remote> with a local file url
//

const globalForDb = globalThis as typeof globalThis & {
  __dockflowLibsql?: Client;
  __dockflowDb?: ReturnType<typeof createDrizzle>;
  __dockflowBootstrap?: Promise<void>;
};

export interface DatabaseTarget {
  url: string;
  kind: "file" | "remote";
  authToken: boolean;
  replicaOf: string | null;
  databasePath: string | null;
}

function envFirst(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function isSupportedUrl(url: string): boolean {
  return /^(file:|libsql:|https?:|wss?:|ws:)/i.test(url);
}

function isPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:/i.test(url);
}

export function resolveTarget(): DatabaseTarget {
  const candidate = envFirst(["LIBSQL_URL", "TURSO_DATABASE_URL", "DATABASE_URL"]);
  const syncUrl = envFirst(["LIBSQL_SYNC_URL", "TURSO_SYNC_URL"]);
  const authToken = Boolean(envFirst(["LIBSQL_AUTH_TOKEN", "TURSO_AUTH_TOKEN", "DATABASE_AUTH_TOKEN"]));

  const fallbackFile = path.join(process.cwd(), "data", "dockflow.db");

  if (candidate && isSupportedUrl(candidate) && !isPostgresUrl(candidate)) {
    if (candidate.startsWith("file:")) {
      const filePath = path.isAbsolute(candidate.slice(5)) ? candidate : path.join(process.cwd(), candidate.replace(/^file:(\/\/)?/, ""));
      const url = `file:${filePath}`;
      return { url, kind: "file", authToken: false, replicaOf: syncUrl ?? null, databasePath: filePath };
    }
    return { url: candidate, kind: "remote", authToken, replicaOf: null, databasePath: null };
  }

  return { url: `file:${fallbackFile}`, kind: "file", authToken: false, replicaOf: syncUrl ?? null, databasePath: fallbackFile };
}

function ensureDirectory(target: DatabaseTarget): void {
  if (!target.databasePath) return;
  const dir = path.dirname(target.databasePath);
  if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export const databaseTarget: DatabaseTarget = resolveTarget();

function createClientInstance(): Client {
  ensureDirectory(databaseTarget);
  const authToken = envFirst(["LIBSQL_AUTH_TOKEN", "TURSO_AUTH_TOKEN", "DATABASE_AUTH_TOKEN"]);
  const config: Config = { url: databaseTarget.url };
  if (authToken) config.authToken = authToken;
  if (databaseTarget.replicaOf) {
    // embedded replica: local file for reads/writes, remote for syncing
    config.syncUrl = databaseTarget.replicaOf;
    config.syncInterval = 60_000;
  }
  return createClient(config);
}

export const client: Client = globalForDb.__dockflowLibsql ?? createClientInstance();
globalForDb.__dockflowLibsql = client;

function createDrizzle(target: Client) {
  return drizzle({ client: target });
}

export const db: ReturnType<typeof createDrizzle> = globalForDb.__dockflowDb ?? createDrizzle(client);
globalForDb.__dockflowDb = db;

// Splits a DDL script into individual statements (fallback when executeMultiple is unavailable). */
function splitStatements(script: string): string[] {
  return script
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0 && !statement.startsWith("--"));
}

//
//Idempotent schema bootstrap. Memoised so concurrent requests share one run;
//a failure clears the memo so the next request can retry.
//
export function ensureDb(): Promise<void> {
  if (!globalForDb.__dockflowBootstrap) {
    globalForDb.__dockflowBootstrap = (async () => {
      const pragmas = ["PRAGMA journal_mode = WAL", "PRAGMA busy_timeout = 5000", "PRAGMA foreign_keys = ON"];
      for (const pragma of pragmas) {
        try {
          await client.execute(pragma);
        } catch {
          // remote libsql targets may reject pragmas — harmless
        }
      }
      const anyClient = client as unknown as { executeMultiple?: (sql: string) => Promise<unknown> };
      if (typeof anyClient.executeMultiple === "function") {
        await anyClient.executeMultiple(BOOTSTRAP_SQL);
      } else {
        for (const statement of splitStatements(BOOTSTRAP_SQL)) {
          await client.execute(statement);
        }
      }
      await client.execute("select 1 as ok");
    })().catch((error) => {
      globalForDb.__dockflowBootstrap = undefined;
      throw error;
    });
  }
  return globalForDb.__dockflowBootstrap;
}

// Kick the bootstrap off at module load so the first request is usually warm.
void ensureDb().catch((error) => {
  console.warn("[db] bootstrap deferred:", error instanceof Error ? error.message : error);
});

export interface DatabaseStats {
  path: string;
  engine: "libsql";
  kind: DatabaseTarget["kind"];
  authToken: boolean;
  replicaOf: string | null;
  sizeKb: number | null;
  tables: number;
  journalled: boolean;
}

export async function databaseStats(): Promise<DatabaseStats> {
  let sizeKb: number | null = null;
  if (databaseTarget.databasePath) {
    try {
      sizeKb = Math.round(fs.statSync(databaseTarget.databasePath).size / 1024);
    } catch {
      sizeKb = 0;
    }
  }
  let tables = 0;
  try {
    const result = await client.execute("select count(*) as count from sqlite_master where type = 'table'");
    tables = Number((result.rows[0] as unknown as { count: number | bigint })?.count ?? 0);
  } catch {
    tables = 0;
  }
  return {
    path: databaseTarget.databasePath ?? databaseTarget.url,
    engine: "libsql",
    kind: databaseTarget.kind,
    authToken: databaseTarget.authToken,
    replicaOf: databaseTarget.replicaOf,
    sizeKb,
    tables,
    journalled: Boolean(sizeKb),
  };
}

export * as schema from "./schema";
