import { guard } from "@/lib/api";
import { getTopology } from "@/lib/apm";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => {
    await ensureSeed();
    return getTopology();
  });
}
