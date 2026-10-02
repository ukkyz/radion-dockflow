import { guard, readJson } from "@/lib/api";
import { projectAction } from "@/lib/docker";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await readJson<{ project?: string; action?: string }>(request);
  return guard(async () => {
    if (!body.project) throw new Error("project is required");
    const action = body.action ?? "restart";
    if (!["start", "stop", "restart"].includes(action)) throw new Error("action must be start, stop or restart");
    return projectAction(body.project, action as "start" | "stop" | "restart");
  });
}
