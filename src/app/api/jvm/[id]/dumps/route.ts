import { guard, readJson } from "@/lib/api";
import { captureJvmDump, listJvmDumps } from "@/lib/jvm";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return guard(async () => ({ dumps: await listJvmDumps(decodeURIComponent(id)) }));
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await readJson<{ kind?: string }>(request);
  return guard(async () => {
    const kind = body.kind === "heap" ? "heap" : "thread";
    return { dump: await captureJvmDump(decodeURIComponent(id), kind) };
  }, 201);
}
