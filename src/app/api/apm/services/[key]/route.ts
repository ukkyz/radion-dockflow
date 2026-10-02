import { guard } from "@/lib/api";
import { serviceDetail } from "@/lib/apm";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  return guard(async () => serviceDetail(decodeURIComponent(key)));
}
