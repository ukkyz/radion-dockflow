import type {
  ContainerInfo,
  ContainerStats,
  EngineInfo,
  ImageInfo,
  NetworkInfo,
  VolumeInfo,
} from "./types";

/**
 * In-memory Docker engine simulator. Used when no local daemon is reachable so
 * the whole console (hierarchy map, actions, logs, exec, stats, APM) stays live.
 * Every mutation here behaves like the real engine from the UI's perspective.
 */

export interface DemoContainer extends ContainerInfo {
  history: { ts: string; cpu: number; mem: number; net: number }[];
  logCursor: number;
  networkId: string;
}

interface DemoState {
  containers: DemoContainer[];
  images: ImageInfo[];
  volumes: VolumeInfo[];
  networks: NetworkInfo[];
  logs: Record<string, string[]>;
  tick: number;
}

const globalForDemo = globalThis as typeof globalThis & { __dockerDemoState?: DemoState };

const rndHex = (len: number) => {
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < len; i += 1) out += chars[Math.floor(Math.random() * 16)];
  return out;
};

const uuid = () => `${rndHex(8)}-${rndHex(4)}-${rndHex(4)}-${rndHex(4)}-${rndHex(12)}`;

const longId = () => rndHex(64);
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

interface SeedSpec {
  name: string;
  image: string;
  service?: string;
  project?: string;
  state: ContainerInfo["state"];
  health?: ContainerInfo["health"];
  command: string;
  ports?: [number, number][];
  env?: string[];
  cpu: number;
  mem: number;
  memLimit: number;
  restartCount?: number;
  exitCode?: number | null;
  mounts?: { source: string; target: string; type?: string }[];
  networks: { name: string; ip: string }[];
  ageMs: number;
  logs: string[];
  statusText?: string;
}

const SEED: SeedSpec[] = [
  {
    name: "vega-gateway",
    image: "nginx:1.27-alpine",
    service: "gateway",
    project: "vega-shop",
    state: "running",
    health: "healthy",
    command: 'nginx -g "daemon off;"',
    ports: [[8080, 80]],
    cpu: 3.4,
    mem: 42,
    memLimit: 512,
    networks: [{ name: "vega-shop_default", ip: "172.22.0.10" }],
    ageMs: 1000 * 60 * 240,
    logs: [
      '172.22.0.1 - - "GET /api/cart HTTP/1.1" 200 512',
      '172.22.0.1 - - "POST /api/checkout HTTP/1.1" 201 340',
      'upstream timed out (110: Connection timed out) while reading response header, client: 172.22.0.1',
    ],
  },
  {
    name: "vega-api",
    image: "vega/api:2.14.3",
    service: "api",
    project: "vega-shop",
    state: "running",
    health: "healthy",
    command: "node dist/server.js",
    ports: [[3001, 3000]],
    env: ["NODE_ENV=production", "OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318"],
    cpu: 21.6,
    mem: 384,
    memLimit: 1024,
    networks: [{ name: "vega-shop_default", ip: "172.22.0.11" }],
    ageMs: 1000 * 60 * 239,
    logs: [
      "[INFO] http server listening on :3000",
      "[INFO] trace export ok spanCount=18",
      "[WARN] downstream slow: order-service 812ms",
    ],
  },
  {
    name: "vega-auth",
    image: "vega/auth:1.9.0",
    service: "auth",
    project: "vega-shop",
    state: "running",
    health: "healthy",
    command: "python -m uvicorn main:app --host 0.0.0.0",
    ports: [[3002, 8000]],
    cpu: 6.1,
    mem: 210,
    memLimit: 768,
    networks: [{ name: "vega-shop_default", ip: "172.22.0.12" }],
    ageMs: 1000 * 60 * 238,
    logs: ["INFO: 172.22.0.11:44322 - POST /token 200 OK", "INFO: jwks cache refreshed"],
  },
  {
    name: "vega-catalog",
    image: "vega/catalog:3.2.1",
    service: "catalog",
    project: "vega-shop",
    state: "running",
    health: "healthy",
    command: "java -jar /app/catalog.jar",
    ports: [[3003, 8080]],
    cpu: 38.9,
    mem: 912,
    memLimit: 2048,
    networks: [{ name: "vega-shop_default", ip: "172.22.0.13" }],
    ageMs: 1000 * 60 * 237,
    logs: [
      "INFO o.s.b.w.embedded.tomcat.TomcatWebServer - Tomcat started on port 8080",
      "WARN c.v.catalog.CacheWarmer - redis miss ratio 0.31",
    ],
  },
  {
    name: "vega-orders",
    image: "vega/orders:0.8.7",
    service: "orders",
    project: "vega-shop",
    state: "restarting",
    health: "unhealthy",
    command: "node dist/orders.js",
    ports: [[3004, 3000]],
    cpu: 4.2,
    mem: 128,
    memLimit: 512,
    restartCount: 7,
    exitCode: 137,
    networks: [{ name: "vega-shop_default", ip: "172.22.0.14" }],
    ageMs: 1000 * 60 * 96,
    logs: [
      "[ERROR] connect ECONNREFUSED 172.22.0.20:6379 (redis)",
      "fatal error: out of memory: heap allocation failed",
      "container exited with code 137, restarting (7)",
    ],
  },
  {
    name: "vega-jobs",
    image: "vega/jobs:0.8.7",
    service: "jobs",
    project: "vega-shop",
    state: "running",
    health: null,
    command: "node dist/worker.js",
    cpu: 11.3,
    mem: 186,
    memLimit: 768,
    networks: [{ name: "vega-shop_default", ip: "172.22.0.15" }],
    ageMs: 1000 * 60 * 236,
    logs: ["[INFO] queue payments consume=4 concurrency=8", "[INFO] job 88f2a done in 214ms"],
  },
  {
    name: "vega-postgres",
    image: "postgres:16.4-alpine",
    service: "db",
    project: "vega-shop",
    state: "running",
    health: "healthy",
    command: "postgres -c max_connections=200",
    ports: [[5432, 5432]],
    cpu: 18.4,
    mem: 640,
    memLimit: 2048,
    mounts: [{ source: "vega_pgdata", target: "/var/lib/postgresql/data" }],
    networks: [{ name: "vega-shop_default", ip: "172.22.0.30" }],
    ageMs: 1000 * 60 * 244,
    logs: ["LOG: checkpoint complete: wrote 412 buffers (2.5%)", "LOG: duration: 84.221 ms  statement: SELECT ..."],
  },
  {
    name: "vega-redis",
    image: "redis:7.4-alpine",
    service: "cache",
    project: "vega-shop",
    state: "running",
    health: "healthy",
    command: "redis-server --appendonly yes",
    ports: [[6379, 6379]],
    cpu: 4.8,
    mem: 96,
    memLimit: 512,
    mounts: [{ source: "vega_redisdata", target: "/data" }],
    networks: [{ name: "vega-shop_default", ip: "172.22.0.31" }],
    ageMs: 1000 * 60 * 243,
    logs: ["1:M 12:04:11.123 * Background saving terminated with success"],
  },
  {
    name: "vega-rabbitmq",
    image: "rabbitmq:3.13-management",
    service: "broker",
    project: "vega-shop",
    state: "running",
    health: "starting",
    command: "rabbitmq-server",
    ports: [[5672, 5672], [15672, 15672]],
    cpu: 2.7,
    mem: 154,
    memLimit: 640,
    networks: [{ name: "vega-shop_default", ip: "172.22.0.32" }],
    ageMs: 1000 * 60 * 242,
    logs: ["accepting AMQP connection 172.22.0.15:53120", "Statistics database started."],
  },
  {
    name: "obs-prometheus",
    image: "prom/prometheus:v2.54.1",
    service: "prometheus",
    project: "observability",
    state: "running",
    health: null,
    command: "--config.file=/etc/prometheus/prometheus.yml",
    ports: [[9090, 9090]],
    mounts: [{ source: "obs_promdata", target: "/prometheus" }],
    cpu: 7.9,
    mem: 322,
    memLimit: 1024,
    networks: [{ name: "observability_default", ip: "172.23.0.10" }],
    ageMs: 1000 * 60 * 310,
    logs: ['level=info msg="Scrape target vega-api up"', 'level=info msg="Compacting blocks"'],
  },
  {
    name: "obs-grafana",
    image: "grafana/grafana:11.2.0",
    service: "grafana",
    project: "observability",
    state: "running",
    health: null,
    command: "/run.sh",
    ports: [[3000, 3000]],
    mounts: [{ source: "obs_grafanadata", target: "/var/lib/grafana" }],
    cpu: 1.6,
    mem: 128,
    memLimit: 512,
    networks: [{ name: "observability_default", ip: "172.23.0.11" }],
    ageMs: 1000 * 60 * 309,
    logs: ["logger=ngalert.scheduler msg=Starting scheduler", "logger=plugin.loader msg=Plugin registered"],
  },
  {
    name: "obs-otel-collector",
    image: "otel/opentelemetry-collector-contrib:0.109.0",
    service: "otel-collector",
    project: "observability",
    state: "running",
    health: null,
    command: "--config=/etc/otel/config.yaml",
    ports: [[4317, 4317], [4318, 4318]],
    cpu: 5.5,
    mem: 174,
    memLimit: 512,
    networks: [{ name: "observability_default", ip: "172.23.0.12" }],
    ageMs: 1000 * 60 * 308,
    logs: ["TracesExporter  {\"kind\":\"exporter\",\"data_type\":\"traces\",\"sent_spans\": 42}"],
  },
  {
    name: "legacy-reporting",
    image: "vega/reporting:0.4.2",
    state: "exited",
    command: "python reporting.py --once",
    exitCode: 0,
    cpu: 0,
    mem: 0,
    memLimit: 512,
    networks: [{ name: "bridge", ip: "172.17.0.4" }],
    ageMs: 1000 * 60 * 60 * 30,
    logs: ["report written to /out/report-2026-01.csv", "shutdown complete"],
    statusText: "Exited (0) 30 hours ago",
  },
  {
    name: "search-indexer",
    image: "vega/search:1.1.0",
    state: "exited",
    health: null,
    command: "java -jar search.jar --reindex",
    exitCode: 1,
    cpu: 0,
    mem: 0,
    memLimit: 1024,
    networks: [{ name: "bridge", ip: "172.17.0.5" }],
    ageMs: 1000 * 60 * 60 * 6,
    logs: ["Exception in thread \"main\" java.lang.OutOfMemoryError: Java heap space", "index build aborted"],
    statusText: "Exited (1) 6 hours ago",
  },
];

const IMAGE_SEED: [string, string, number, string][] = [
  ["nginx:1.27-alpine", "sha256:9f2c1a", 48.2, "nginx"],
  ["postgres:16.4-alpine", "sha256:4bd7e2", 274.6, "postgres"],
  ["redis:7.4-alpine", "sha256:2ac9f1", 41.3, "redis"],
  ["rabbitmq:3.13-management", "sha256:71bd44", 214.9, "rabbitmq"],
  ["prom/prometheus:v2.54.1", "sha256:aa31c0", 289.4, "prometheus"],
  ["grafana/grafana:11.2.0", "sha256:c40e77", 512.1, "grafana"],
  ["otel/opentelemetry-collector-contrib:0.109.0", "sha256:1ef809", 186.7, "otel"],
  ["vega/api:2.14.3", "sha256:77ac21", 341.8, "vega"],
  ["vega/auth:1.9.0", "sha256:65b120", 198.4, "vega"],
  ["vega/catalog:3.2.1", "sha256:3d9e11", 428.6, "vega"],
  ["vega/orders:0.8.7", "sha256:80ffab", 356.2, "vega"],
  ["vega/jobs:0.8.7", "sha256:80ffac", 349.9, "vega"],
  ["alpine:3.20", "sha256:beef01", 7.8, "<none>"],
];

function buildContainer(spec: SeedSpec, index: number): DemoContainer {
  const id = longId();
  const running = spec.state === "running" || spec.state === "restarting";
  const ports = (spec.ports ?? []).map(([host, container]) => ({
    host,
    container,
    protocol: "tcp",
    hostIp: "0.0.0.0",
  }));
  const networks = spec.networks.map((n) => ({ name: n.name, ip: n.ip, aliases: [spec.service ?? spec.name] }));
  const mounts = (spec.mounts ?? []).map((m) => ({
    type: m.type ?? (m.source.includes("/") ? "bind" : "volume"),
    source: m.source,
    target: m.target,
    mode: "rw",
    sizeMb: 128,
  }));
  return {
    id,
    shortId: id.slice(0, 12),
    name: spec.name,
    image: spec.image,
    imageId: `sha256:${rndHex(12)}`,
    command: spec.command,
    platform: "linux/amd64",
    state: spec.state,
    status: spec.statusText ?? (running ? "Up 4 hours" : "Exited (0)"),
    health: spec.health ?? null,
    createdAt: iso(spec.ageMs + 1000 * 60),
    startedAt: running ? iso(spec.ageMs - 1000 * 60) : iso(spec.ageMs),
    finishedAt: running ? null : iso(spec.ageMs),
    restartCount: spec.restartCount ?? 0,
    exitCode: running ? null : spec.exitCode ?? 0,
    labels: {
      "com.docker.compose.project": spec.project ?? "",
      "com.docker.compose.service": spec.service ?? spec.name,
      "com.docker.compose.version": "2.29.7",
      "org.opencontainers.image.source": `https://github.com/vega/${spec.service ?? spec.name}`,
    },
    composeProject: spec.project ?? null,
    composeService: spec.service ?? spec.name,
    ports,
    networks,
    mounts,
    cpuPercent: running ? spec.cpu : 0,
    memUsageMb: running ? spec.mem : 0,
    memLimitMb: spec.memLimit,
    memPercent: running ? +((spec.mem / spec.memLimit) * 100).toFixed(1) : 0,
    netRxMb: running ? 12 + index * 3.5 : 0,
    netTxMb: running ? 8 + index * 2.1 : 0,
    blockReadMb: running ? 24 + index * 4.2 : 0,
    blockWriteMb: running ? 6 + index * 1.3 : 0,
    pids: running ? 8 + index : 0,
    history: Array.from({ length: 30 }, (_, i) => ({
      ts: iso((30 - i) * 10_000),
      cpu: running ? Math.max(0.2, spec.cpu + (Math.random() - 0.5) * spec.cpu * 0.5) : 0,
      mem: running ? Math.max(4, spec.mem + (Math.random() - 0.5) * spec.mem * 0.2) : 0,
      net: running ? 0.6 + Math.random() : 0,
    })),
    logCursor: 0,
    networkId: rndHex(64),
  };
}

function seedState(): DemoState {
  const containers = SEED.map(buildContainer);
  const tagsFor = (image: string) => IMAGE_SEED.find(([tag]) => tag === image);

  const images: ImageInfo[] = IMAGE_SEED.map(([tag, id, size, repo], i) => ({
    id,
    shortId: id.replace("sha256:", "").slice(0, 12),
    tags: [tag],
    sizeMb: size,
    createdAt: iso(1000 * 60 * 60 * (24 + i * 6)),
    containers: containers.filter((c) => c.image === tag).length,
    labels: { "org.opencontainers.image.ref.name": tag, repo },
  }));
  for (const c of containers) {
    if (!tagsFor(c.image)) {
      images.push({
        id: c.imageId,
        shortId: c.imageId.replace("sha256:", "").slice(0, 12),
        tags: [c.image],
        sizeMb: 210.5,
        createdAt: iso(1000 * 60 * 60 * 40),
        containers: 1,
        labels: {},
      });
    }
  }

  const volumeNames = new Map<string, { id: string; name: string }[]>();
  for (const c of containers) {
    for (const m of c.mounts) {
      if (m.type !== "volume") continue;
      const list = volumeNames.get(m.source) ?? [];
      list.push({ id: c.id, name: c.name });
      volumeNames.set(m.source, list);
    }
  }
  const volumes: VolumeInfo[] = [
    ...volumeNames.entries(),
  ].map(([name, attach], i) => ({
    name,
    driver: "local",
    mountpoint: `/var/lib/docker/volumes/${name}/_data`,
    createdAt: iso(1000 * 60 * 60 * (36 + i * 12)),
    containers: attach,
    sizeMb: 96 + i * 210,
  }));

  const networkNames = new Map<string, { id: string; name: string; ip?: string }[]>();
  for (const c of containers) {
    for (const n of c.networks) {
      const list = networkNames.get(n.name) ?? [];
      list.push({ id: c.id, name: c.name, ip: n.ip });
      networkNames.set(n.name, list);
    }
  }
  const baseNetworks = ["bridge", "host", "none"];
  for (const n of baseNetworks) if (!networkNames.has(n)) networkNames.set(n, []);
  const networks: NetworkInfo[] = [...networkNames.entries()].map(([name, attached]) => ({
    id: rndHex(64),
    name,
    driver: name === "host" || name === "none" || name === "bridge" ? "bridge" : "bridge",
    scope: "local",
    internal: false,
    attachable: name !== "host",
    subnet: name.startsWith("vega")
      ? "172.22.0.0/16"
      : name.startsWith("observability")
        ? "172.23.0.0/16"
        : name === "bridge"
          ? "172.17.0.0/16"
          : null,
    containers: attached,
    labels: (name.startsWith("vega")
      ? { "com.docker.compose.project": "vega-shop", "com.docker.compose.network": name.split("_").pop() ?? "" }
      : name.startsWith("observability")
        ? { "com.docker.compose.project": "observability" }
        : {}) as Record<string, string>,
  }));

  const logs: Record<string, string[]> = {};
  for (const c of containers) {
    const lines: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      const template = SEED.find((s) => s.name === c.name)?.logs ?? ["heartbeat ok"];
      lines.push(`${iso((14 - i) * 4200)} ${c.state === "exited" ? "" : "[stdout] "}${template[i % template.length]}`);
    }
    logs[c.id] = lines;
  }

  return { containers, images, volumes, networks, logs, tick: 0 };
}

export function demoState(): DemoState {
  if (!globalForDemo.__dockerDemoState) globalForDemo.__dockerDemoState = seedState();
  return globalForDemo.__dockerDemoState;
}

const jitter = (value: number, pct: number) => Math.max(0, value * (1 + (Math.random() - 0.5) * pct));

export function demoTick(containerId?: string): void {
  const state = demoState();
  state.tick += 1;
  for (const c of state.containers) {
    if (containerId && c.id !== containerId) continue;
    const running = c.state === "running" || c.state === "restarting";
    if (!running) continue;
    c.cpuPercent = +jitter(c.cpuPercent || 4, 0.35).toFixed(1);
    c.memUsageMb = +jitter(c.memUsageMb || 64, 0.12).toFixed(1);
    c.memPercent = +((c.memUsageMb / c.memLimitMb) * 100).toFixed(1);
    c.netRxMb = +(c.netRxMb + Math.random() * 1.4).toFixed(2);
    c.netTxMb = +(c.netTxMb + Math.random() * 0.8).toFixed(2);
    c.blockReadMb = +(c.blockReadMb + Math.random() * 0.6).toFixed(2);
    c.blockWriteMb = +(c.blockWriteMb + Math.random() * 0.3).toFixed(2);
    c.pids = 8 + Math.floor(Math.random() * 12);
    c.history.push({
      ts: new Date().toISOString(),
      cpu: c.cpuPercent,
      mem: c.memUsageMb,
      net: +(Math.random() * 2 + 0.4).toFixed(2),
    });
    if (c.history.length > 60) c.history.shift();
    if (state.tick % 2 === 0) {
      const template = SEED.find((s) => s.name === c.name)?.logs ?? ["heartbeat ok"];
      const line = template[Math.floor(Math.random() * template.length)];
      const all = state.logs[c.id] ?? (state.logs[c.id] = []);
      all.push(`${new Date().toISOString()} [stdout] ${line}`);
      if (all.length > 400) all.splice(0, all.length - 400);
    }
  }
}

export function demoEngine(): EngineInfo {
  return {
    serverVersion: "27.3.1",
    apiVersion: "1.47",
    os: "Linux (Docker Desktop simulator)",
    arch: "x86_64",
    kernelVersion: "6.10.4-linuxkit",
    cpus: 8,
    totalMemoryMb: 7936,
    driver: "overlay2",
    runtime: "runc",
    name: "sandbox-local",
    warnings: ["Demo mode: no local Docker daemon detected on this sandbox host."],
  };
}

export function demoContainerById(id: string): DemoContainer | undefined {
  const state = demoState();
  return state.containers.find((c) => c.id.startsWith(id) || c.name === id);
}

export function demoStats(id: string): ContainerStats {
  const c = demoContainerById(id);
  if (!c) throw new Error(`container ${id} not found`);
  demoTick(c.id);
  return {
    id: c.id,
    cpuPercent: c.cpuPercent,
    memUsageMb: c.memUsageMb,
    memLimitMb: c.memLimitMb,
    memPercent: c.memPercent,
    netRxMb: c.netRxMb,
    netTxMb: c.netTxMb,
    blockReadMb: c.blockReadMb,
    blockWriteMb: c.blockWriteMb,
    pids: c.pids,
    history: c.history.slice(-40),
  };
}

export function demoLogs(id: string, tail = 200): string {
  const state = demoState();
  const c = demoContainerById(id);
  if (!c) return "";
  demoTick(c.id);
  const all = state.logs[c.id] ?? [];
  return all.slice(-tail).join("\n");
}

export function demoContainerAction(id: string, action: string): string {
  const state = demoState();
  const c = demoContainerById(id);
  if (!c) throw new Error(`container ${id} not found`);
  switch (action) {
    case "start":
      c.state = "running";
      c.status = "Up 1 second";
      c.startedAt = new Date().toISOString();
      c.exitCode = null;
      c.health = "starting";
      break;
    case "stop":
    case "kill":
      c.state = "exited";
      c.status = `Exited (${action === "kill" ? 137 : 0}) 1 second ago`;
      c.exitCode = action === "kill" ? 137 : 0;
      c.finishedAt = new Date().toISOString();
      c.health = null;
      c.cpuPercent = 0;
      break;
    case "restart":
      c.state = "running";
      c.status = "Up 1 second";
      c.restartCount += 1;
      c.health = "starting";
      c.startedAt = new Date().toISOString();
      break;
    case "pause":
      c.state = "paused";
      c.status = "Up 4 hours (Paused)";
      break;
    case "unpause":
      c.state = "running";
      c.status = "Up 4 hours";
      break;
    case "remove":
      state.containers = state.containers.filter((x) => x.id !== c.id);
      delete state.logs[c.id];
      return `container ${c.name} removed`;
    default:
      return `unknown action ${action}`;
  }
  const all = state.logs[c.id] ?? (state.logs[c.id] = []);
  all.push(`${new Date().toISOString()} [engine] ${action} ${c.name}`);
  return `${action} ${c.name}: ok`;
}

export function demoExec(id: string, cmd: string[]): string {
  const c = demoContainerById(id);
  const joined = cmd.join(" ");
  const header = `# exec ${c?.name ?? id} :: ${joined}\n`;
  if (/^(sh|bash|zsh)$/.test(cmd[0] ?? "")) return header + "shell attached (demo mode)\n";
  if (joined.startsWith("ls")) return header + "bin\netc\napp\ndist\npackage.json\nnode_modules\n";
  if (joined.startsWith("ps")) return header + "PID   USER   COMMAND\n1  root  " + (c?.command ?? "init") + "\n";
  if (joined.startsWith("cat")) return header + "demo mode: file contents are simulated\n";
  if (joined.startsWith("env")) return header + Object.entries(c?.labels ?? {}).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  if (joined.includes("version")) return header + "demo-engine 27.3.1 (simulated)\n";
  if (joined.includes("ping")) return header + "PONG\n";
  if (joined.includes("curl")) return header + '{"status":"ok","mode":"demo"}\n';
  return header + `executed: ${joined}\nexit code 0 (simulated)\n`;
}
