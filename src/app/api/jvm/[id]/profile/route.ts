import { guard, readJson } from "@/lib/api";
import { jvmProfileAction } from "@/lib/jvm";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return guard(async () => jvmProfileAction(decodeURIComponent(id), "status"));
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await readJson<{ action?: string; durationMs?: number; intervalMs?: number }>(request);
  return guard(async () => {
    const action = (body.action ?? "start") as "start" | "stop" | "status" | "save";
    if (!["start", "stop", "status", "save"].includes(action)) throw new Error("action must be start, stop, status or save");
    return jvmProfileAction(decodeURIComponent(id), action, { durationMs: body.durationMs, intervalMs: body.intervalMs });
  });
}
