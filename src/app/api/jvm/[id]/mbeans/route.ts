import { guard } from "@/lib/api";
import { jvmMBeans } from "@/lib/jvm";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const mbean = new URL(request.url).searchParams.get("mbean") ?? undefined;
  return guard(async () => jvmMBeans(decodeURIComponent(id), mbean ?? undefined));
}
