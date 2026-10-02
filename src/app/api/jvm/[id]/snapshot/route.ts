import { guard } from "@/lib/api";
import { jvmSnapshot } from "@/lib/jvm";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return guard(async () => jvmSnapshot(decodeURIComponent(id)));
}
