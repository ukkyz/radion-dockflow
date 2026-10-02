import { guard, readJson } from "@/lib/api";
import { prune } from "@/lib/docker";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await readJson<{ kind?: string }>(request);
  return guard(async () => {
    const kind = body.kind ?? "containers";
    if (!["images", "volumes", "networks", "containers"].includes(kind)) {
      throw new Error("kind must be one of images, volumes, networks, containers");
    }
    return prune(kind as "images" | "volumes" | "networks" | "containers");
  });
}
