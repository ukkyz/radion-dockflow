import { guard } from "@/lib/api";
import { getContainerLogs } from "@/lib/docker";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const tail = Number(new URL(request.url).searchParams.get("tail") ?? 200) || 200;
  return guard(async () => {
    const result = await getContainerLogs(id, Math.min(2000, tail));
    return { ...result, lines: result.logs.split("\n").filter(Boolean) };
  });
}
