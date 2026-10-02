import { guard, readJson } from "@/lib/api";
import { execInContainer } from "@/lib/docker";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await readJson<{ command?: string; cmd?: string[] }>(request);
  return guard(async () => {
    const cmd = body.cmd?.length
      ? body.cmd
      : (body.command ?? "").trim()
        ? ["/bin/sh", "-lc", String(body.command)]
        : ["/bin/sh", "-lc", "echo 'no command given'"];
    return execInContainer(id, cmd);
  });
}
