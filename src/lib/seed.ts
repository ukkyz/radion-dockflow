import { db } from "@/db";
import { apmServices, cliTools, dockerHosts, jvmTargets, workflows, type WorkflowGraph } from "@/db/schema";
import { invalidateEndpointCache } from "./docker";

const globalForSeed = globalThis as typeof globalThis & { __workflowConsoleSeeded?: boolean };

/** Reads an env var, treating blank values (common in sandboxes) as unset. */
function envOr(key: string, fallback: string): string {
  const value = process.env[key];
  return value && value.trim() ? value.trim() : fallback;
}

async function seedStep(label: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (error) {
    console.warn(`[seed] ${label} failed:`, error instanceof Error ? error.message : error);
    return false;
  }
}

function buildGraph(steps: { type: string; data: Record<string, unknown>; label?: string }[], branches?: Record<string, { from: number; to: number; label: string }[]>): WorkflowGraph {
  const nodes: WorkflowGraph["nodes"] = steps.map((step, index) => ({
    id: `${step.type}_${index + 1}`,
    type: "wfNode",
    position: { x: 80 + (index % 4) * 300, y: 60 + Math.floor(index / 4) * 150 },
    data: { ...step.data, nodeType: step.type, label: step.label ?? String(step.data.label ?? step.type) },
  }));
  const edges: WorkflowGraph["edges"] = [];
  for (let i = 1; i < steps.length; i += 1) {
    edges.push({ id: `e${i}`, source: nodes[i - 1].id, target: nodes[i].id });
  }
  for (const [key, list] of Object.entries(branches ?? {})) {
    for (const branch of list) {
      edges.push({
        id: `b${key}-${branch.from}-${branch.to}`,
        source: nodes[branch.from].id,
        target: nodes[branch.to].id,
        label: branch.label,
      });
    }
  }
  return { nodes, edges };
}

export async function ensureSeed(): Promise<void> {
  if (globalForSeed.__workflowConsoleSeeded) return;
  globalForSeed.__workflowConsoleSeeded = true;
  let clean = true;

  try {
    clean =
      (await seedStep("docker hosts", async () => {
        const hosts = await db.select().from(dockerHosts).limit(1);
        if (hosts.length) return;
        await db
          .insert(dockerHosts)
          .values([
            {
              name: "Local Docker (unix socket)",
              kind: "unix",
              address: envOr("DOCKER_SOCKET", "unix:///var/run/docker.sock"),
              isDefault: true,
              status: "unknown",
            },
            {
              name: "Local Docker Desktop (tcp)",
              kind: "tcp",
              address: envOr("DOCKER_TCP_ENDPOINT", "tcp://127.0.0.1:2375"),
              isDefault: false,
              status: "unknown",
            },
          ])
          .onConflictDoNothing();
        invalidateEndpointCache();
      })) && clean;

    const tools = await db.select().from(cliTools).limit(1);
    if (!tools.length) {
      await db.insert(cliTools).values([
        { name: "Docker version", description: "Client + server version", binary: "docker", baseArgs: "version", category: "docker", favorite: true },
        { name: "Docker ps (json)", description: "List containers as JSON", binary: "docker", baseArgs: "ps -a --format json", category: "docker", favorite: true },
        { name: "Docker images", description: "List local images", binary: "docker", baseArgs: "images", category: "docker" },
        { name: "Docker system df", description: "Disk usage summary", binary: "docker", baseArgs: "system df", category: "docker" },
        { name: "Compose ps", description: "Compose project status", binary: "docker", baseArgs: "compose ls", category: "compose", favorite: true },
        { name: "Compose up -d", description: "Start the current compose stack", binary: "docker", baseArgs: "compose up -d", category: "compose" },
        { name: "Node version", description: "Node runtime in this workspace", binary: "node", baseArgs: "-v", category: "runtime", favorite: true },
        { name: "NPM ls", description: "Installed packages", binary: "npm", baseArgs: "ls --depth=0", category: "runtime" },
        { name: "Git status", description: "Working tree status", binary: "git", baseArgs: "status --short --branch", category: "vcs" },
        { name: "Kubectl cluster-info", description: "Any Kubernetes context on PATH", binary: "kubectl", baseArgs: "cluster-info", category: "k8s" },
        { name: "Curl health", description: "Hit this console's health endpoint", binary: "curl", baseArgs: "-s -i http://127.0.0.1:3000/api/health", category: "http" },
      ]);
    }

    const existingWorkflows = await db.select().from(workflows).limit(1);
    if (!existingWorkflows.length) {
      clean =
        (await seedStep("workflows", async () => {
          await db.insert(workflows).values([
        {
          name: "Rolling restart with health gate",
          description: "Restarts the API container, waits for it to come back, gates on the health endpoint and notifies.",
          graph: buildGraph(
            [
              { type: "trigger", label: "manual deploy", data: { label: "manual deploy", payload: '{"container":"vega-api"}' } },
              { type: "dockerAction", label: "restart api", data: { target: "{{container}}", action: "restart", waitHealthy: "yes" } },
              { type: "delay", label: "settle", data: { seconds: 1, milliseconds: 0 } },
              { type: "healthcheck", label: "api health", data: { url: "http://127.0.0.1:3000/api/health", expectStatus: 200, retries: 3, intervalMs: 1000 } },
              { type: "condition", label: "healthy?", data: { expression: "{{healthcheck_4.status}} == 200", description: "only notify when the endpoint answered" } },
              { type: "notify", label: "announce", data: { message: "{{trigger.container}} restarted and healthy", level: "info" } },
            ],
            { a: [{ from: 4, to: 5, label: "true" }] },
          ),
        },
        {
          name: "Container triage checklist",
          description: "Inspects a container: engine CLI snapshot, log pattern gate, exec smoke test.",
          graph: buildGraph([
            { type: "trigger", label: "triage", data: { label: "triage", payload: '{"container":"vega-orders"}' } },
            { type: "cli", label: "docker ps", data: { binary: "docker", args: "ps -a --format json", cwd: ".", timeoutMs: 15000 } },
            { type: "dockerLogs", label: "log gate", data: { target: "{{container}}", tail: 150, mustContain: "", mustNotContain: "panic" } },
            { type: "dockerExec", label: "exec smoke", data: { target: "{{container}}", command: "ls", failOnNonZero: "yes" } },
            { type: "notify", label: "summary", data: { message: "triage finished for {{container}}", level: "warn" } },
          ]),
        },
        {
          name: "Spin up sidecar and verify",
          description: "Runs a fresh nginx container on a spare port, waits, probes it, then reports.",
          graph: buildGraph([
            { type: "trigger", label: "sidecar run", data: { label: "sidecar run", payload: '{"port":"8081"}' } },
            { type: "dockerRun", label: "run nginx", data: { image: "nginx:1.27-alpine", name: "wf-sidecar", ports: "8081:80", command: "nginx -g 'daemon off;'" } },
            { type: "healthcheck", label: "probe sidecar", data: { url: "http://127.0.0.1:8081/", expectStatus: 200, retries: 2, intervalMs: 800 } },
            { type: "notify", label: "result", data: { message: "sidecar state: {{healthcheck_3.status}}", level: "info" } },
          ]),
        },
          ]);
        })) && clean;
    }

    const existingJvms = await db.select().from(jvmTargets).limit(1);
    if (!existingJvms.length) {
      clean =
        (await seedStep("jvm targets", async () => {
          await db.insert(jvmTargets).values([
            {
              name: "catalog-service (simulated JVM)",
              kind: "simulated",
              url: "",
              host: "localhost",
              app: "catalog-service",
              status: "simulated",
              jvmVersion: "21.0.4+7-LTS",
              javaVendor: "Eclipse Adoptium",
              source: "manual",
              autoDiscovered: false,
            },
            {
              name: "orders-service JMX bridge",
              kind: "jolokia",
              url: "http://127.0.0.1:8778/jolokia",
              host: "127.0.0.1",
              app: "orders-service",
              status: "offline",
              source: "manual",
              autoDiscovered: false,
            },
            {
              name: "api actuator",
              kind: "actuator",
              url: "http://127.0.0.1:8080/actuator",
              host: "127.0.0.1",
              app: "api",
              status: "offline",
              source: "manual",
              autoDiscovered: false,
            },
          ]);
        })) && clean;
    }

    const services = await db.select().from(apmServices).limit(1);
    if (!services.length) {
      clean =
        (await seedStep("apm services", async () => {
          await db.insert(apmServices).values([
        { key: "gateway", name: "gateway", kind: "gateway", runtime: "nginx", team: "edge", slaLatencyMs: 120, slaErrorPct: 0.3 },
        { key: "api", name: "api", kind: "service", runtime: "node", team: "commerce", slaLatencyMs: 250, slaErrorPct: 1 },
        { key: "auth", name: "auth", kind: "service", runtime: "python", team: "identity", slaLatencyMs: 180, slaErrorPct: 0.5 },
        { key: "catalog", name: "catalog", kind: "service", runtime: "jvm", team: "commerce", slaLatencyMs: 320, slaErrorPct: 1.5 },
        { key: "orders", name: "orders", kind: "service", runtime: "node", team: "checkout", slaLatencyMs: 300, slaErrorPct: 1 },
        { key: "jobs", name: "jobs", kind: "service", runtime: "node", team: "checkout", slaLatencyMs: 500, slaErrorPct: 2 },
        { key: "db", name: "db", kind: "db", runtime: "postgres", team: "data", slaLatencyMs: 60, slaErrorPct: 0.2 },
        { key: "cache", name: "cache", kind: "cache", runtime: "redis", team: "data", slaLatencyMs: 25, slaErrorPct: 0.1 },
        { key: "broker", name: "broker", kind: "queue", runtime: "amqp", team: "platform", slaLatencyMs: 90, slaErrorPct: 0.4 },
        { key: "otel-collector", name: "otel-collector", kind: "external", runtime: "otel", team: "observability", slaLatencyMs: 200, slaErrorPct: 0.5 },
        { key: "prometheus", name: "prometheus", kind: "external", runtime: "observability", team: "observability", slaLatencyMs: 400, slaErrorPct: 0.5 },
          ]);
        })) && clean;
    }
  } catch (error) {
    clean = false;
    console.warn("[seed] unexpected failure:", error instanceof Error ? error.message : error);
  }

  if (!clean) globalForSeed.__workflowConsoleSeeded = false;
}
