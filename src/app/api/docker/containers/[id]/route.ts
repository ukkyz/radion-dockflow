import { guard, readJson } from "@/lib/api";
import { containerAction, getContainer, type ContainerAction } from "@/lib/docker";

export const dynamic = "force-dynamic";

const ACTIONS: ContainerAction[] = ["start", "stop", "restart", "pause", "unpause", "kill", "remove"];

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return guard(async () => {
    const container = await getContainer(id);
    if (!container) throw new Error(`container ${id} not found`);
    return { container };
  });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await readJson<{ action?: string }>(request);
  return guard(async () => {
    const action = (body.action ?? "restart") as ContainerAction;
    if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(", ")}`);
    return containerAction(id, action);
  });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return guard(async () => containerAction(id, "remove"));
}
