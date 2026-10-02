import { guard } from "@/lib/api";
import { jvmThreads } from "@/lib/jvm";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return guard(async () => jvmThreads(decodeURIComponent(id)));
}
