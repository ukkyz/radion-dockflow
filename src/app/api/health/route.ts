import { databaseStats, databaseTarget, ensureDb } from "@/db";
import { pingDocker } from "@/lib/docker";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  let database = "down";
  let stats = {
    path: databaseTarget.databasePath ?? databaseTarget.url,
    engine: "libsql" as const,
    kind: databaseTarget.kind,
    authToken: databaseTarget.authToken,
    replicaOf: databaseTarget.replicaOf,
    sizeKb: null as number | null,
    tables: 0,
    journalled: false,
  };
  let dbError: string | null = null;
  try {
    await ensureDb();
    await ensureSeed();
    stats = await databaseStats();
    database = "up";
  } catch (error) {
    database = "down";
    dbError = error instanceof Error ? error.message : String(error);
    stats = await databaseStats().catch(() => stats);
  }
  try {
    const engine = await pingDocker(false);
    return Response.json({
      ok: true,
      status: "healthy",
      database,
      databaseEngine: "libsql",
      sqlite: stats,
      dbError,
      engine: {
        mode: engine.mode,
        endpoint: engine.endpoint.address,
        serverVersion: engine.engine.serverVersion,
        error: engine.error,
      },
      latencyMs: Date.now() - startedAt,
      at: new Date().toISOString(),
    });
  } catch (error) {
    return Response.json({
      ok: true,
      status: "degraded",
      database,
      databaseEngine: "libsql",
      sqlite: stats,
      dbError,
      engine: { mode: "demo", endpoint: "unknown", serverVersion: "unknown", error: String(error) },
      latencyMs: Date.now() - startedAt,
      at: new Date().toISOString(),
    });
  }
}
