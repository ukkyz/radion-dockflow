import { guard, readJson } from "@/lib/api";
import { simulateTraffic } from "@/lib/apm";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const body = await readJson<{ batch?: number }>(request);
  return guard(async () => {
    const batch = Math.min(25, Math.max(1, Number(body.batch ?? 3) || 3));
    const result = await simulateTraffic(batch);
    return { ...result, note: "synthetic traffic generated into the local telemetry store" };
  });
}
