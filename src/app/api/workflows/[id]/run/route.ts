import { guard, readJson } from "@/lib/api";
import { createRun } from "@/lib/workflow";
import { connectEngine } from "@/lib/docker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await readJson<{ trigger?: string; payload?: Record<string, unknown> }>(request);
  return guard(async () => {
    const conn = await connectEngine();
    const result = await createRun(id, body.trigger ?? "manual", { ...(body.payload ?? {}), engineMode: conn.mode });
    return { ...result, engineMode: conn.mode };
  }, 202);
}
