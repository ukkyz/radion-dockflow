import { eq } from "drizzle-orm";
import { db } from "@/db";
import { workflows, type WorkflowGraph } from "@/db/schema";
import { guard, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return guard(async () => {
    const rows = await db.select().from(workflows).where(eq(workflows.id, id)).limit(1);
    if (!rows.length) throw new Error("workflow not found");
    const row = rows[0];
    return {
      workflow: {
        id: row.id,
        name: row.name,
        description: row.description,
        graph: row.graph as WorkflowGraph,
        updatedAt: row.updatedAt.toISOString(),
      },
    };
  });
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await readJson<{ name?: string; description?: string; graph?: WorkflowGraph }>(request);
  return guard(async () => {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.graph !== undefined) patch.graph = body.graph;
    await db.update(workflows).set(patch).where(eq(workflows.id, id));
    return { updated: id };
  });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return guard(async () => {
    await db.delete(workflows).where(eq(workflows.id, id));
    return { deleted: id };
  });
}
