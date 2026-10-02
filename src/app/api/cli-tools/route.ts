import { eq } from "drizzle-orm";
import { db } from "@/db";
import { cliTools } from "@/db/schema";
import { guard, readJson } from "@/lib/api";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => {
    await ensureSeed();
    const rows = await db.select().from(cliTools).orderBy(cliTools.category, cliTools.name);
    return {
      tools: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    };
  });
}

export async function POST(request: Request) {
  const body = await readJson<{
    name?: string;
    description?: string;
    binary?: string;
    baseArgs?: string;
    cwd?: string;
    category?: string;
    envVars?: Record<string, string>;
  }>(request);
  return guard(async () => {
    if (!body.name || !body.binary) throw new Error("name and binary are required");
    const inserted = await db
      .insert(cliTools)
      .values({
        name: body.name,
        description: body.description ?? "",
        binary: body.binary,
        baseArgs: body.baseArgs ?? "",
        cwd: body.cwd ?? ".",
        category: body.category ?? "custom",
        envVars: body.envVars ?? {},
      })
      .returning();
    return { tool: { ...inserted[0], createdAt: inserted[0].createdAt.toISOString() } };
  }, 201);
}

export async function PATCH(request: Request) {
  const body = await readJson<{ id?: string; favorite?: boolean; baseArgs?: string; name?: string }>(request);
  return guard(async () => {
    if (!body.id) throw new Error("id is required");
    const patch: Record<string, unknown> = {};
    if (typeof body.favorite === "boolean") patch.favorite = body.favorite;
    if (typeof body.baseArgs === "string") patch.baseArgs = body.baseArgs;
    if (typeof body.name === "string") patch.name = body.name;
    await db.update(cliTools).set(patch).where(eq(cliTools.id, body.id));
    return { updated: body.id };
  });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  return guard(async () => {
    if (!id) throw new Error("id query parameter is required");
    await db.delete(cliTools).where(eq(cliTools.id, id));
    return { deleted: id };
  });
}
