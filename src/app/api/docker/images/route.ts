import { guard } from "@/lib/api";
import { listImages, removeResource } from "@/lib/docker";

export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => listImages());
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  return guard(async () => {
    if (!id) throw new Error("id query parameter is required");
    return removeResource("image", id);
  });
}
