import { guard } from "@/lib/api";
import { buildHierarchy } from "@/lib/docker";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => {
    await ensureSeed();
    return buildHierarchy();
  });
}
