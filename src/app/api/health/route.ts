import { databaseStats, databasePath, sqlite } from "@/db";
import { pingDocker } from "@/lib/docker";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  let database = "down";
  let stats = { path: databasePath, sizeKb: 0, tables: 0 };
  try {
    await ensureSeed();
    sqlite.prepare("select 1 as ok").get();
    stats = databaseStats();
    database = "up";
  } catch {
    database = "down";
  }
  try {
    const engine = await pingDocker(false);
    return Response.json({
      ok: true,
      status: "healthy",
      database,
      databaseEngine: "sqlite",
      sqlite: stats,
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
      databaseEngine: "sqlite",
      sqlite: stats,
      engine: { mode: "demo", endpoint: "unknown", serverVersion: "unknown", error: String(error) },
      latencyMs: Date.now() - startedAt,
      at: new Date().toISOString(),
    });
  }
}
