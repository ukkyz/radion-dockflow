import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dockerHosts } from "@/db/schema";
import { guard, readJson } from "@/lib/api";
import { connectEngine, invalidateEndpointCache, listEndpoints, parseEndpointAddress } from "@/lib/docker";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  return guard(async () => {
    await ensureSeed();
    const conn = await connectEngine(force);
    const endpoints = await listEndpoints();
    return {
      mode: conn.mode,
      error: conn.error,
      engine: conn.engine,
      active: conn.endpoint,
      endpoints,
      instruction:
        conn.mode === "demo"
          ? "No Docker daemon answered. Demo mode is active - add an endpoint below (unix:///var/run/docker.sock, tcp://host.docker.internal:2375) and click Reconnect."
          : null,
    };
  });
}

export async function POST(request: Request) {
  const body = await readJson<{ name?: string; address?: string; makeDefault?: boolean }>(request);
  return guard(async () => {
    const parsed = parseEndpointAddress(body.address ?? "");
    if (!parsed) throw new Error("address is required (unix:///path, tcp://host:port)");
    const existing = await db.select().from(dockerHosts).where(eq(dockerHosts.address, parsed.address)).limit(1);
    if (existing.length) {
      await db.update(dockerHosts).set({ name: body.name ?? existing[0].name, isDefault: body.makeDefault ?? true }).where(eq(dockerHosts.id, existing[0].id));
    } else {
      await db.insert(dockerHosts).values({
        name: body.name ?? parsed.name,
        kind: parsed.kind,
        address: parsed.address,
        isDefault: body.makeDefault ?? true,
        status: "unknown",
      });
    }
    invalidateEndpointCache();
    const conn = await connectEngine(true);
    return { mode: conn.mode, error: conn.error, engine: conn.engine, active: conn.endpoint };
  });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  return guard(async () => {
    if (!id) throw new Error("id query parameter is required");
    await db.delete(dockerHosts).where(eq(dockerHosts.id, id));
    invalidateEndpointCache();
    const conn = await connectEngine(true);
    return { removed: id, mode: conn.mode, active: conn.endpoint };
  });
}
