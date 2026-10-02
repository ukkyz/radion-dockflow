import { guard, readJson } from "@/lib/api";
import { addJvmTarget, listJvmTargets, removeJvmTarget } from "@/lib/jvm";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => {
    await ensureSeed();
    const targets = await listJvmTargets();
    return {
      targets,
      counts: {
        total: targets.length,
        online: targets.filter((t) => t.status === "online").length,
        offline: targets.filter((t) => t.status === "offline").length,
        simulated: targets.filter((t) => t.status === "simulated").length,
        discovered: targets.filter((t) => t.autoDiscovered).length,
      },
      hint:
        "Attach a real JVM with either a Jolokia JMX bridge (java -javaagent:jolokia-jvm.jar=port=8778 -> http://host:8778/jolokia) or a Spring Boot Actuator base url (http://host:8080/actuator).",
    };
  });
}

export async function POST(request: Request) {
  const body = await readJson<{ name?: string; kind?: string; url?: string; app?: string }>(request);
  return guard(async () => {
    await ensureSeed();
    return { target: await addJvmTarget(body) };
  }, 201);
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  return guard(async () => {
    if (!id) throw new Error("id query parameter is required");
    await removeJvmTarget(id);
    return { removed: id };
  });
}
