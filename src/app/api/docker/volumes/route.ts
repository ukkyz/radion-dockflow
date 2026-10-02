import { guard } from "@/lib/api";
import { listVolumes, removeResource } from "@/lib/docker";

export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => listVolumes());
}

export async function DELETE(request: Request) {
  const name = new URL(request.url).searchParams.get("name");
  return guard(async () => {
    if (!name) throw new Error("name query parameter is required");
    return removeResource("volume", name);
  });
}
