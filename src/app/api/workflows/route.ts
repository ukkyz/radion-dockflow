import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { workflows, type WorkflowGraph } from "@/db/schema";
import { guard, readJson } from "@/lib/api";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";

function summarize(graph: WorkflowGraph) {
  const steps = graph.nodes.map((node) => ({ id: node.id, type: String((node.data as Record<string, unknown>)?.nodeType ?? node.type), label: String((node.data as Record<string, unknown>)?.label ?? "") }));
  return { nodeCount: graph.nodes.length, edgeCount: graph.edges.length, steps };
}

export async function GET() {
  return guard(async () => {
    await ensureSeed();
    const rows = await db.select().from(workflows).orderBy(desc(workflows.updatedAt));
    return {
      workflows: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        updatedAt: row.updatedAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        ...summarize(row.graph as WorkflowGraph),
      })),
    };
  });
}

export async function POST(request: Request) {
  const body = await readJson<{ name?: string; description?: string; graph?: WorkflowGraph; cloneOf?: string }>(request);
  return guard(async () => {
    let graph = body.graph;
    let name = body.name;
    let description = body.description ?? "";
    if (body.cloneOf) {
      const source = await db.select().from(workflows).where(eq(workflows.id, body.cloneOf)).limit(1);
      if (!source.length) throw new Error("workflow to clone not found");
      graph = source[0].graph as WorkflowGraph;
      name = name ?? `${source[0].name} (copy)`;
      description = description || source[0].description;
    }
    if (!name) throw new Error("name is required");
    const inserted = await db
      .insert(workflows)
      .values({
        name,
        description,
        graph: graph ?? { nodes: [], edges: [] },
      })
      .returning();
    return { workflow: { id: inserted[0].id, name: inserted[0].name } };
  }, 201);
}
