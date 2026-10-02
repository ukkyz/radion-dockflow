import { guard } from "@/lib/api";
import { listTraces } from "@/lib/apm";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return guard(async () => {
    const result = await listTraces({
      service: params.get("service") ?? undefined,
      status: params.get("status") ?? undefined,
      minDurationMs: params.get("minDurationMs") ? Number(params.get("minDurationMs")) : undefined,
      limit: params.get("limit") ? Number(params.get("limit")) : 40,
    });
    return { ...result, traces: result.traces.map((trace) => ({ ...trace, spans: [] })), full: result.traces };
  });
}
