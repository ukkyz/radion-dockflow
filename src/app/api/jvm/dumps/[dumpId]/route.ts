import { guard } from "@/lib/api";
import { getJvmDump, listJvmDumps, removeJvmDump } from "@/lib/jvm";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ dumpId: string }> }) {
  const { dumpId } = await context.params;
  return guard(async () => {
    const dump = await getJvmDump(dumpId);
    if (!dump) throw new Error("dump not found");
    return dump;
  });
}

export async function DELETE(_request: Request, context: { params: Promise<{ dumpId: string }> }) {
  const { dumpId } = await context.params;
  return guard(async () => {
    await removeJvmDump(dumpId);
    return { removed: dumpId };
  });
}

export async function POST() {
  return guard(async () => ({ dumps: await listJvmDumps() }));
}
