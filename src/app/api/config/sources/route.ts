import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { configSources } from "@/db/schema";
import { guard, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => {
    const rows = await db.select().from(configSources).orderBy(desc(configSources.lastLoadedAt)).limit(60);
    return {
      sources: rows.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        target: row.target,
        status: row.status,
        lastError: row.lastError,
        pinned: row.pinned,
        summary: row.summary,
        sizeKb: Math.round(row.content.length / 1024),
        createdAt: row.createdAt.toISOString(),
        lastLoadedAt: row.lastLoadedAt ? row.lastLoadedAt.toISOString() : null,
      })),
    };
  });
}

export async function POST(request: Request) {
  const body = await readJson<{
    name?: string;
    kind?: string;
    target?: string;
    content?: string;
    summary?: Record<string, unknown>;
    status?: string;
    lastError?: string | null;
    pinned?: boolean;
  }>(request);
  return guard(async () => {
    if (!body.name) throw new Error("name is required");
    const kind = body.kind ?? "compose";
    const existing = await db.select().from(configSources).where(eq(configSources.name, body.name)).limit(1);
    const values = {
      name: body.name,
      kind,
      target: body.target ?? "",
      content: body.content ?? "",
      summary: body.summary ?? {},
      status: body.status ?? "ready",
      lastError: body.lastError ?? null,
      pinned: body.pinned ?? false,
      lastLoadedAt: new Date(),
    };
    if (existing.length) {
      await db.update(configSources).set(values).where(eq(configSources.id, existing[0].id));
      return { source: { id: existing[0].id, ...values, lastLoadedAt: values.lastLoadedAt.toISOString() }, updated: true };
    }
    const inserted = await db.insert(configSources).values(values).returning();
    return { source: { id: inserted[0].id, ...values, lastLoadedAt: values.lastLoadedAt.toISOString() }, updated: false };
  }, 201);
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  return guard(async () => {
    if (!id) throw new Error("id query parameter is required");
    await db.delete(configSources).where(eq(configSources.id, id));
    return { removed: id };
  });
}
