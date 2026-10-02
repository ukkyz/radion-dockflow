import { guard, readJson } from "@/lib/api";
import { jvmOperation } from "@/lib/jvm";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await readJson<{ operation?: string; args?: unknown[] }>(request);
  return guard(async () => {
    if (!body.operation) throw new Error("operation is required (gc, resetPeakThreads, clearCache, resetRateLimiter)");
    return jvmOperation(decodeURIComponent(id), body.operation, body.args);
  });
}
