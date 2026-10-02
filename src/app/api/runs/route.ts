import { guard } from "@/lib/api";
import { listRuns } from "@/lib/workflow";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const workflowId = params.get("workflowId") ?? undefined;
  const limit = Number(params.get("limit") ?? 25) || 25;
  return guard(async () => ({ runs: await listRuns(workflowId, limit) }));
}
