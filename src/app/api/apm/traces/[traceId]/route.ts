import { guard } from "@/lib/api";
import { getTrace } from "@/lib/apm";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await context.params;
  return guard(async () => {
    const trace = await getTrace(traceId);
    if (!trace) throw new Error("trace not found");
    return { trace };
  });
}
