import type { Config } from "drizzle-kit";

/**
 * drizzle-kit v1 configuration (libsql / SQLite).
 * `npx drizzle-kit push` applies the same shape that src/db/bootstrap.ts creates
 * on boot, so a fresh workspace works with or without running kit first.
 */
// kit 1.0 accepts only { url } for the sqlite dialect; the runtime app additionally
// reads LIBSQL_AUTH_TOKEN / TURSO_AUTH_TOKEN for authenticating against Turso.
const url = process.env.LIBSQL_URL ?? process.env.TURSO_DATABASE_URL ?? "file:./data/dockflow.db";

export default {
  dialect: "sqlite",
  // no `driver` field: plain SQLite/libsql file + HTTP targets use the default.
  // (kit 1.0 only accepts driver for d1-http | expo | durable-sqlite | sqlite-cloud)
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
  verbose: true,
  strict: false,
} satisfies Config;
