import { guard, readJson } from "@/lib/api";
import { cancelRun, getRun } from "@/lib/workflow";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return guard(async () => {
    const run = await getRun(id);
    if (!run) throw new Error("run not found");
    return { run };
  });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await readJson<{ action?: string }>(request);
  return guard(async () => {
    if ((body.action ?? "cancel") === "cancel") {
      cancelRun(id);
      return { cancelled: id };
    }
    throw new Error("unsupported action");
  });
}
