import { guard, readJson } from "@/lib/api";
import { listContainers, runNewContainer } from "@/lib/docker";

export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => {
    const { mode, containers } = await listContainers();
    return {
      mode,
      containers,
      stats: {
        total: containers.length,
        running: containers.filter((c) => c.state === "running").length,
        stopped: containers.filter((c) => ["exited", "created", "dead"].includes(c.state)).length,
        unhealthy: containers.filter((c) => c.health === "unhealthy" || c.state === "restarting").length,
        cpuPercent: +containers.reduce((s, c) => s + c.cpuPercent, 0).toFixed(1),
        memMb: +containers.reduce((s, c) => s + c.memUsageMb, 0).toFixed(0),
        projects: [...new Set(containers.map((c) => c.composeProject ?? "standalone"))],
      },
    };
  });
}

export async function POST(request: Request) {
  const body = await readJson<{
    image?: string;
    name?: string;
    ports?: string;
    env?: string;
    command?: string;
  }>(request);
  return guard(async () => {
    if (!body.image) throw new Error("image is required");
    const ports = (body.ports ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((pair) => {
        const [host, container] = pair.split(":");
        return { host: Number(host), container: Number(container ?? host), protocol: "tcp" };
      });
    const env = (body.env ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    return runNewContainer({
      image: body.image,
      name: body.name || undefined,
      ports,
      env,
      command: body.command || undefined,
    });
  }, 201);
}
