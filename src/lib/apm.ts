import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { apmAgents, apmEdges, apmServices, apmSpans } from "@/db/schema";
import { connectEngine, listContainers } from "./docker";
import type {
  ApmLink,
  ApmNode,
  ApmServiceKind,
  ApmSpan,
  ApmTimeseriesPoint,
  ApmTopology,
  ApmTrace,
  ContainerInfo,
  DockerMode,
} from "./types";

const WINDOW_MIN = 10;
const RETENTION_MIN = 20;

export interface DerivedService {
  key: string;
  name: string;
  kind: ApmServiceKind;
  runtime: string;
  container: ContainerInfo | null;
  replicas: number;
  project: string | null;
  cpu: number;
  mem: number;
  tags: string[];
}

const RUNTIME_HINTS: [RegExp, ApmServiceKind, string][] = [
  [/postgres|mysql|mariadb|mongo|clickhouse|mssql/i, "db", "postgres"],
  [/redis|memcached|keydb|valkey/i, "cache", "redis"],
  [/rabbitmq|kafka|nats|redpanda|activemq|mq/i, "queue", "amqp"],
  [/nginx|traefik|envoy|haproxy|caddy|kong|gateway/i, "gateway", "proxy"],
  [/prometheus|grafana|otel|collector|jaeger|zipkin|loki|tempo/i, "external", "observability"],
];

function classify(image: string, name: string): { kind: ApmServiceKind; runtime: string; tags: string[] } {
  const haystack = `${image} ${name}`;
  for (const [re, kind, tag] of RUNTIME_HINTS) {
    if (re.test(haystack)) return { kind, runtime: tag, tags: [tag] };
  }
  const runtime = /node|nest|next/i.test(image)
    ? "node"
    : /python|uvicorn|gunicorn|fastapi|django/i.test(image)
      ? "python"
      : /java|tomcat|spring|jar/i.test(image)
        ? "jvm"
        : /go|golang/i.test(image)
          ? "go"
          : /php|fpm/i.test(image)
            ? "php"
            : "container";
  return { kind: "service", runtime, tags: [runtime] };
}

export async function deriveServices(): Promise<{ mode: DockerMode; services: DerivedService[]; all: ContainerInfo[] }> {
  const conn = await connectEngine();
  const { containers } = await listContainers();
  const groups = new Map<string, ContainerInfo[]>();
  for (const c of containers) {
    const key = c.composeService ?? c.name.replace(/-[0-9a-f]{6,}$/, "");
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const services: DerivedService[] = [];
  for (const [key, list] of groups) {
    const primary = list.find((c) => c.state === "running") ?? list[0];
    const { kind, runtime, tags } = classify(primary.image, key);
    services.push({
      key,
      name: key,
      kind,
      runtime,
      container: primary,
      replicas: list.filter((c) => c.state === "running").length,
      project: primary.composeProject,
      cpu: +list.reduce((s, c) => s + c.cpuPercent, 0).toFixed(1),
      mem: +list.reduce((s, c) => s + c.memUsageMb, 0).toFixed(0),
      tags: [...tags, primary.composeProject ?? "standalone"],
    });
  }
  services.sort((a, b) => {
    const order = { gateway: 0, service: 1, queue: 2, cache: 3, db: 4, external: 5 } as Record<ApmServiceKind, number>;
    return order[a.kind] - order[b.kind] || a.key.localeCompare(b.key);
  });
  return { mode: conn.mode, services, all: containers };
}

/** Fallback call graph derived from container names, networks and roles. */
function deriveLinks(services: DerivedService[]): ApmLink[] {
  const links: ApmLink[] = [];
  const push = (source: string, target: string, protocol: string, async = false) => {
    if (source === target) return;
    const id = `${source}->${target}`;
    if (links.some((l) => l.id === id)) return;
    links.push({
      id,
      source,
      target,
      protocol,
      calls: 0,
      errors: 0,
      avgMs: 0,
      maxMs: 0,
      errorRate: 0,
      async,
    });
  };

  const byKey = new Map(services.map((s) => [s.key, s]));
  const gateways = services.filter((s) => s.kind === "gateway");
  const apps = services.filter((s) => s.kind === "service");
  const dbs = services.filter((s) => s.kind === "db");
  const caches = services.filter((s) => s.kind === "cache");
  const queues = services.filter((s) => s.kind === "queue");
  const externals = services.filter((s) => s.kind === "external");

  const gateway = gateways[0]?.key;
  for (const app of apps) {
    if (gateway) push(gateway, app.key, "HTTP");
  }
  if (!gateway && apps.length > 1) {
    push(apps[0].key, apps[1].key, "HTTP");
    if (apps[2]) push(apps[1].key, apps[2].key, "HTTP");
  }
  const primary = apps[0]?.key;
  for (const db of dbs) if (primary) push(primary, db.key, "SQL");
  for (const cache of caches) if (primary) push(primary, cache.key, "RESP");
  for (const queue of queues) {
    if (primary) push(primary, queue.key, "AMQP", true);
    for (const app of apps.slice(1)) push(app.key, queue.key, "AMQP", true);
  }
  for (const ext of externals) {
    for (const app of apps.slice(0, 3)) push(app.key, ext.key, "gRPC", true);
  }
  if (byKey.size === 0) return links;
  return links;
}

interface SpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  serviceKey: string;
  operation: string;
  kind: string;
  startTime: Date;
  durationMs: number;
  status: string;
  errorMessage: string | null;
  tags: Record<string, unknown>;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return +sorted[index].toFixed(2);
}

export async function getTopology(): Promise<ApmTopology> {
  const { mode, services } = await deriveServices();
  const since = new Date(Date.now() - WINDOW_MIN * 60_000);

  const [spanRows, edgeRows, registered, agents] = await Promise.all([
    db
      .select()
      .from(apmSpans)
      .where(gte(apmSpans.startTime, since))
      .orderBy(desc(apmSpans.startTime))
      .limit(6000),
    db.select().from(apmEdges).where(gte(apmEdges.windowStart, new Date(Date.now() - 60 * 60_000))),
    db.select().from(apmServices),
    db.select().from(apmAgents),
  ]);

  const servicesByName = new Map(services.map((s) => [s.key, s]));
  const registry = new Map(registered.map((r) => [r.key, r]));

  // Services that only exist in telemetry (external agents, remote apps).
  for (const row of registered) {
    if (servicesByName.has(row.key)) continue;
    servicesByName.set(row.key, {
      key: row.key,
      name: row.name,
      kind: (row.kind as ApmServiceKind) ?? "service",
      runtime: row.runtime,
      container: null,
      replicas: 0,
      project: null,
      cpu: 0,
      mem: 0,
      tags: ["agent"],
    });
  }

  const spansByService = new Map<string, SpanRow[]>();
  const linkAgg = new Map<string, { calls: number; errors: number; total: number; max: number; protocol: string }>();
  const spanByTrace = new Map<string, SpanRow[]>();
  for (const raw of spanRows) {
    const span: SpanRow = {
      traceId: raw.traceId,
      spanId: raw.spanId,
      parentSpanId: raw.parentSpanId,
      serviceKey: raw.serviceKey,
      operation: raw.operation,
      kind: raw.kind,
      startTime: raw.startTime,
      durationMs: raw.durationMs,
      status: raw.status,
      errorMessage: raw.errorMessage,
      tags: raw.tags,
    };
    spansByService.set(span.serviceKey, [...(spansByService.get(span.serviceKey) ?? []), span]);
    spanByTrace.set(span.traceId, [...(spanByTrace.get(span.traceId) ?? []), span]);
  }

  for (const group of spanByTrace.values()) {
    const roots = group.filter((s) => !s.parentSpanId);
    const clients = group.filter((s) => s.kind === "client");
    for (const client of clients) {
      const target = group.find((s) => s.parentSpanId === client.spanId && s.serviceKey !== client.serviceKey);
      if (!target) continue;
      const id = `${client.serviceKey}->${target.serviceKey}`;
      const agg = linkAgg.get(id) ?? { calls: 0, errors: 0, total: 0, max: 0, protocol: String(client.tags?.protocol ?? "HTTP") };
      agg.calls += 1;
      agg.errors += client.status === "error" ? 1 : 0;
      agg.total += client.durationMs;
      agg.max = Math.max(agg.max, client.durationMs);
      linkAgg.set(id, agg);
    }
    // fall back to parent/child relationships between services
    for (const span of roots) {
      for (const child of group) {
        if (child.parentSpanId !== span.spanId || child.serviceKey === span.serviceKey) continue;
        const id = `${span.serviceKey}->${child.serviceKey}`;
        if (linkAgg.has(id)) continue;
        linkAgg.set(id, {
          calls: 1,
          errors: child.status === "error" ? 1 : 0,
          total: child.durationMs,
          max: child.durationMs,
          protocol: "HTTP",
        });
      }
    }
  }

  for (const edge of edgeRows) {
    const id = `${edge.sourceKey}->${edge.targetKey}`;
    if (linkAgg.has(id)) continue;
    linkAgg.set(id, {
      calls: edge.calls,
      errors: edge.errors,
      total: edge.totalDurationMs,
      max: edge.maxDurationMs,
      protocol: edge.protocol,
    });
  }

  const baseLinks = deriveLinks([...servicesByName.values()].map((s) => ({
    key: s.key,
    name: s.name,
    kind: s.kind,
    runtime: s.runtime,
    container: s.container,
    replicas: s.replicas,
    project: s.project,
    cpu: s.cpu,
    mem: s.mem,
    tags: s.tags,
  })));

  const allLinks = new Map<string, ApmLink>();
  for (const link of [...baseLinks, ...[...linkAgg.entries()].map(([id, agg]) => {
    const [source, target] = id.split("->");
    return {
      id,
      source,
      target,
      protocol: agg.protocol,
      calls: agg.calls,
      errors: agg.errors,
      avgMs: +(agg.total / Math.max(1, agg.calls)).toFixed(2),
      maxMs: +agg.max.toFixed(2),
      errorRate: +((agg.errors / Math.max(1, agg.calls)) * 100).toFixed(2),
      async: false,
    } satisfies ApmLink;
  })]) {
    const existing = allLinks.get(link.id);
    if (!existing) {
      allLinks.set(link.id, link);
      continue;
    }
    const calls = existing.calls + link.calls;
    allLinks.set(link.id, {
      ...existing,
      calls,
      errors: existing.errors + link.errors,
      avgMs: calls > 0 ? +((existing.avgMs * existing.calls + link.avgMs * link.calls) / calls).toFixed(2) : 0,
      maxMs: Math.max(existing.maxMs, link.maxMs),
      errorRate: +(((existing.errors + link.errors) / Math.max(1, calls)) * 100).toFixed(2),
    });
  }

  const dataLinks = [...linkAgg.keys()];
  const links = [...allLinks.values()].filter((l) => dataLinks.includes(l.id) || l.calls === 0);

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const link of links) {
    outgoing.set(link.source, (outgoing.get(link.source) ?? 0) + 1);
    incoming.set(link.target, (incoming.get(link.target) ?? 0) + 1);
  }
  for (const key of linkAgg.keys()) {
    const [source, target] = key.split("->");
    if (!links.some((l) => l.id === key)) {
      outgoing.set(source, (outgoing.get(source) ?? 0) + 1);
      incoming.set(target, (incoming.get(target) ?? 0) + 1);
    }
  }

  const nodes: ApmNode[] = [...servicesByName.values()].map((service) => {
    const spans = spansByService.get(service.key) ?? [];
    const durations = spans.map((s) => s.durationMs);
    const errors = spans.filter((s) => s.status === "error").length;
    const reg = registry.get(service.key);
    const agent = agents.find((a) => a.serviceKey === service.key) ?? null;
    const avgMs = durations.length ? +(durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(2) : 0;
    const sla = reg?.slaLatencyMs ?? 300;
    const satisfied = durations.filter((d) => d <= sla).length;
    const tolerating = durations.filter((d) => d > sla && d <= sla * 4).length;
    const apdex = durations.length ? +((satisfied + tolerating / 2) / durations.length).toFixed(3) : 1;
    const errorRate = spans.length ? +((errors / spans.length) * 100).toFixed(2) : 0;

    const containerState = service.container?.state;
    const status: ApmNode["status"] =
      containerState && !["running", "paused"].includes(containerState)
        ? "down"
        : service.container?.health === "unhealthy" || (containerState === "restarting")
          ? "warn"
          : errorRate > 5
            ? "warn"
            : spans.length || service.container
              ? "up"
              : "unknown";

    return {
      key: service.key,
      name: reg?.name ?? service.name,
      kind: service.kind,
      runtime: reg?.runtime ?? service.runtime,
      team: reg?.team ?? "platform",
      status,
      mode,
      containerId: service.container?.id ?? reg?.containerId ?? null,
      containerName: service.container?.name ?? null,
      project: service.project,
      replicas: service.replicas,
      cpu: service.cpu,
      mem: service.mem,
      requests: spans.length,
      errors,
      avgMs,
      p95Ms: percentile(durations, 95),
      maxMs: durations.length ? +Math.max(...durations).toFixed(2) : 0,
      errorRate,
      apdex,
      slaLatencyMs: sla,
      slaErrorPct: reg?.slaErrorPct ?? 1,
      incoming: incoming.get(service.key) ?? 0,
      outgoing: outgoing.get(service.key) ?? 0,
      agent: agent ? { name: agent.name, version: agent.version, lastHeartbeatAt: agent.lastHeartbeatAt.toISOString() } : null,
      tags: service.tags,
    };
  });

  const buckets = new Map<number, { requests: number; errors: number; total: number }>();
  const bucketMs = 60_000;
  for (const span of spanRows) {
    const bucket = Math.floor(span.startTime.getTime() / bucketMs) * bucketMs;
    const current = buckets.get(bucket) ?? { requests: 0, errors: 0, total: 0 };
    current.requests += 1;
    current.errors += span.status === "error" ? 1 : 0;
    current.total += span.durationMs;
    buckets.set(bucket, current);
  }
  const timeseries: ApmTimeseriesPoint[] = [];
  const nowBucket = Math.floor(Date.now() / bucketMs) * bucketMs;
  for (let i = 29; i >= 0; i -= 1) {
    const ts = nowBucket - i * bucketMs;
    const bucket = buckets.get(ts);
    timeseries.push({
      ts: new Date(ts).toISOString(),
      requests: bucket?.requests ?? 0,
      errors: bucket?.errors ?? 0,
      avgMs: bucket ? +(bucket.total / bucket.requests).toFixed(1) : 0,
    });
  }

  const totalRequests = spanRows.length;
  const totalErrors = spanRows.filter((s) => s.status === "error").length;
  const totalDurations = spanRows.map((s) => s.durationMs);
  const uniqueTraces = new Set(spanRows.map((s) => s.traceId)).size;
  const windowMs = WINDOW_MIN * 60_000;
  const avgMs = totalDurations.length ? +(totalDurations.reduce((a, b) => a + b, 0) / totalDurations.length).toFixed(1) : 0;
  const slaLatency = 300;
  const apdex =
    totalDurations.length > 0
      ? +((totalDurations.filter((d) => d <= slaLatency).length + totalDurations.filter((d) => d > slaLatency && d <= slaLatency * 4).length / 2) / totalDurations.length).toFixed(3)
      : 1;

  return {
    mode,
    generatedAt: new Date().toISOString(),
    nodes,
    links,
    timeseries,
    totals: {
      services: nodes.length,
      unhealthy: nodes.filter((n) => n.status === "down" || n.status === "warn").length,
      callsPerMin: Math.round((totalRequests / windowMs) * 60_000 * 60) / 60,
      errorRate: totalRequests ? +((totalErrors / totalRequests) * 100).toFixed(2) : 0,
      avgMs,
      p95Ms: percentile(totalDurations, 95),
      apdex,
      agents: agents.length,
      tracesPerMin: Math.round((uniqueTraces / WINDOW_MIN) * 100) / 100,
    },
  };
}

/* ------------------------------------------------------------------ */
/* ingestion + simulation                                              */
/* ------------------------------------------------------------------ */

export interface IngestSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  serviceKey: string;
  operation: string;
  kind?: string;
  startTime: string | number | Date;
  durationMs: number;
  status?: string;
  errorMessage?: string | null;
  tags?: Record<string, unknown>;
}

export async function ingestSpans(
  spans: IngestSpan[],
  meta: { serviceName?: string; kind?: string; runtime?: string; agentName?: string; host?: string } = {},
): Promise<{ inserted: number; services: number; traces: number }> {
  if (!spans.length) return { inserted: 0, services: 0, traces: 0 };
  const rows = spans.slice(0, 2000).map((s) => ({
    traceId: s.traceId,
    spanId: s.spanId,
    parentSpanId: s.parentSpanId ?? null,
    serviceKey: s.serviceKey,
    operation: s.operation,
    kind: s.kind ?? "internal",
    startTime: new Date(s.startTime),
    durationMs: Number(s.durationMs) || 0,
    status: s.status ?? "ok",
    errorMessage: s.errorMessage ?? null,
    tags: s.tags ?? {},
  }));
  await db.insert(apmSpans).values(rows);

  const serviceKeys = [...new Set(rows.map((r) => r.serviceKey))];
  for (const key of serviceKeys) {
    const existing = await db.select().from(apmServices).where(eq(apmServices.key, key)).limit(1);
    if (existing.length) {
      await db.update(apmServices).set({ lastSeenAt: new Date() }).where(eq(apmServices.key, key));
    } else {
      await db.insert(apmServices).values({
        key,
        name: meta.serviceName ?? key,
        kind: meta.kind ?? "service",
        runtime: meta.runtime ?? "agent",
        meta: { discoveredVia: "ingest" },
      });
    }
  }

  if (meta.agentName) {
    const existingAgent = await db.select().from(apmAgents).where(eq(apmAgents.name, meta.agentName)).limit(1);
    if (existingAgent.length) {
      await db
        .update(apmAgents)
        .set({ lastHeartbeatAt: new Date(), serviceKey: serviceKeys[0] ?? existingAgent[0].serviceKey })
        .where(eq(apmAgents.id, existingAgent[0].id));
    } else {
      await db.insert(apmAgents).values({
        name: meta.agentName,
        serviceKey: serviceKeys[0] ?? meta.serviceName ?? "unknown",
        host: meta.host ?? "localhost",
        meta: {},
      });
    }
  }

  // Rollup call edges from client spans.
  const byTrace = new Map<string, typeof rows>();
  for (const row of rows) byTrace.set(row.traceId, [...(byTrace.get(row.traceId) ?? []), row]);
  const rollups = new Map<string, { calls: number; errors: number; total: number; max: number; protocol: string }>();
  for (const group of byTrace.values()) {
    for (const client of group.filter((g) => g.kind === "client")) {
      const target = group.find((g) => g.parentSpanId === client.spanId && g.serviceKey !== client.serviceKey);
      if (!target) continue;
      const id = `${client.serviceKey}->${target.serviceKey}`;
      const agg = rollups.get(id) ?? { calls: 0, errors: 0, total: 0, max: 0, protocol: String(client.tags?.protocol ?? "HTTP") };
      agg.calls += 1;
      agg.errors += client.status === "error" ? 1 : 0;
      agg.total += client.durationMs;
      agg.max = Math.max(agg.max, client.durationMs);
      rollups.set(id, agg);
    }
  }
  for (const [id, agg] of rollups) {
    const [source, target] = id.split("->");
    await db
      .insert(apmEdges)
      .values({
        sourceKey: source,
        targetKey: target,
        protocol: agg.protocol,
        calls: agg.calls,
        errors: agg.errors,
        totalDurationMs: agg.total,
        maxDurationMs: agg.max,
        windowStart: new Date(),
      })
      .onConflictDoUpdate({
        target: [apmEdges.sourceKey, apmEdges.targetKey, apmEdges.protocol],
        set: {
          calls: sql`${apmEdges.calls} + ${agg.calls}`,
          errors: sql`${apmEdges.errors} + ${agg.errors}`,
          totalDurationMs: sql`${apmEdges.totalDurationMs} + ${agg.total}`,
          maxDurationMs: sql`max(${apmEdges.maxDurationMs}, ${agg.max})`,
          windowStart: new Date(),
        },
      });
  }

  return { inserted: rows.length, services: serviceKeys.length, traces: byTrace.size };
}

const randId = () => Math.random().toString(16).slice(2).padEnd(16, "0").slice(0, 16);

const OPERATIONS: Record<string, string[]> = {
  gateway: ["GET /api/cart", "POST /api/checkout", "GET /api/catalog", "GET /healthz"],
  service: ["GET /api/v1/items", "POST /api/v1/orders", "PUT /api/v1/cart", "GET /api/v1/session"],
  db: ["SELECT orders", "INSERT order_items", "UPDATE inventory", "SELECT products"],
  cache: ["GET cart:{}", "SET session:{}", "MGET catalog:{}"],
  queue: ["publish order.created", "consume payment.settled"],
  external: ["POST /v1/traces", "scrape /metrics"],
};

export async function simulateTraffic(batch = 2): Promise<{ traces: number; spans: number; mode: DockerMode }> {
  const { mode, services } = await deriveServices();
  if (!services.length) return { traces: 0, spans: 0, mode };
  const links = deriveLinks(services).filter((l) => l.source !== l.target);
  const byKey = new Map(services.map((s) => [s.key, s]));
  const entry = services.find((s) => s.kind === "gateway")?.key ?? services[0].key;
  const allSpans: IngestSpan[] = [];

  for (let i = 0; i < batch; i += 1) {
    const traceId = randId();
    const traceStart = Date.now() - Math.floor(Math.random() * 3000);
    const errorRoll = Math.random();
    const failing = errorRoll > 0.9;
    const slow = errorRoll > 0.72 && errorRoll <= 0.9;

    const rootService = byKey.get(entry) ?? services[0];
    const rootSpanId = randId();
    const rootDuration = slow ? 420 + Math.random() * 900 : 40 + Math.random() * 180;
    allSpans.push({
      traceId,
      spanId: rootSpanId,
      parentSpanId: null,
      serviceKey: rootService.key,
      operation: pick(OPERATIONS[rootService.kind] ?? OPERATIONS.service),
      kind: "server",
      startTime: new Date(traceStart),
      durationMs: +rootDuration.toFixed(1),
      status: failing ? "error" : "ok",
      errorMessage: failing ? "upstream returned 502" : null,
      tags: { "http.method": "POST", protocol: "HTTP", "http.status_code": failing ? 502 : 200 },
    });

    // Walk the derived call graph from the entry point.
    const queue: { service: string; parentSpanId: string; startOffset: number; depth: number }[] = [
      { service: rootService.key, parentSpanId: rootSpanId, startOffset: 2, depth: 0 },
    ];
    let guard = 0;
    while (queue.length && guard < 24) {
      guard += 1;
      const current = queue.shift()!;
      if (current.depth > 3) continue;
      const callees = links.filter((l) => l.source === current.service);
      for (const link of callees) {
        if (Math.random() > (current.depth === 0 ? 0.85 : 0.5)) continue;
        const target = byKey.get(link.target);
        if (!target) continue;
        const isError = failing && Math.random() > 0.4;
        const duration = isError
          ? 900 + Math.random() * 1500
          : slow
            ? 180 + Math.random() * 500
            : 8 + Math.random() * 90;
        const clientSpanId = randId();
        const serverSpanId = randId();
        allSpans.push({
          traceId,
          spanId: clientSpanId,
          parentSpanId: current.parentSpanId,
          serviceKey: current.service,
          operation: `call ${target.key}`,
          kind: "client",
          startTime: new Date(traceStart + current.startOffset),
          durationMs: +duration.toFixed(1),
          status: isError ? "error" : "ok",
          errorMessage: isError ? `connection reset by ${target.key}` : null,
          tags: { protocol: link.protocol, "peer.service": target.key, "net.peer.ip": "172.22.0.1" },
        });
        allSpans.push({
          traceId,
          spanId: serverSpanId,
          parentSpanId: clientSpanId,
          serviceKey: target.key,
          operation: pick(OPERATIONS[target.kind] ?? OPERATIONS.service),
          kind: "server",
          startTime: new Date(traceStart + current.startOffset + 1),
          durationMs: +Math.max(1, duration - 2).toFixed(1),
          status: isError ? "error" : "ok",
          errorMessage: isError ? "handler failed" : null,
          tags: { protocol: link.protocol, "db.system": target.kind === "db" ? "postgres" : undefined },
        });
        if (target.kind === "db" || target.kind === "cache") {
          allSpans.push({
            traceId,
            spanId: randId(),
            parentSpanId: serverSpanId,
            serviceKey: target.key,
            operation: pick(OPERATIONS[target.kind] ?? OPERATIONS.service),
            kind: "internal",
            startTime: new Date(traceStart + current.startOffset + 2),
            durationMs: +Math.max(1, duration * 0.6).toFixed(1),
            status: isError ? "error" : "ok",
            errorMessage: isError ? "deadlock detected" : null,
            tags: { protocol: link.protocol },
          });
        }
        queue.push({ service: target.key, parentSpanId: serverSpanId, startOffset: current.startOffset + Math.floor(duration), depth: current.depth + 1 });
      }
    }
  }

  await ingestSpans(allSpans, { agentName: "otel-collector", host: "localhost", runtime: "otel" });
  await db.delete(apmSpans).where(lt(apmSpans.startTime, new Date(Date.now() - RETENTION_MIN * 60_000)));
  return { traces: batch, spans: allSpans.length, mode };
}

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/* ------------------------------------------------------------------ */
/* trace APIs                                                          */
/* ------------------------------------------------------------------ */

export async function listTraces(options: {
  service?: string;
  status?: string;
  minDurationMs?: number;
  limit?: number;
}): Promise<{ traces: ApmTrace[]; mode: DockerMode }> {
  const { mode } = await connectEngine();
  const since = new Date(Date.now() - WINDOW_MIN * 60_000);
  const limit = Math.min(200, options.limit ?? 40);

  const conditions = options.service ? [gte(apmSpans.startTime, since), eq(apmSpans.serviceKey, options.service)] : [gte(apmSpans.startTime, since)];
  const rows = await db
    .select()
    .from(apmSpans)
    .where(and(...conditions))
    .orderBy(desc(apmSpans.startTime))
    .limit(8000);

  const grouped = new Map<string, SpanRow[]>();
  for (const row of rows) {
    const span: SpanRow = {
      traceId: row.traceId,
      spanId: row.spanId,
      parentSpanId: row.parentSpanId,
      serviceKey: row.serviceKey,
      operation: row.operation,
      kind: row.kind,
      startTime: row.startTime,
      durationMs: row.durationMs,
      status: row.status,
      errorMessage: row.errorMessage,
      tags: row.tags,
    };
    grouped.set(span.traceId, [...(grouped.get(span.traceId) ?? []), span]);
  }

  const registered = await db.select().from(apmServices);
  const names = new Map(registered.map((r) => [r.key, r.name]));

  const traces: ApmTrace[] = [];
  for (const [traceId, spans] of grouped) {
    const root = spans.find((s) => !s.parentSpanId) ?? spans[0];
    const start = Math.min(...spans.map((s) => s.startTime.getTime()));
    const end = Math.max(...spans.map((s) => s.startTime.getTime() + s.durationMs));
    const errorCount = spans.filter((s) => s.status === "error").length;
    const durationMs = +(end - start).toFixed(1);
    if (options.minDurationMs && durationMs < options.minDurationMs) continue;
    if (options.status === "error" && errorCount === 0) continue;
    if (options.status === "ok" && errorCount > 0) continue;
    traces.push({
      traceId,
      rootService: root.serviceKey,
      rootServiceName: names.get(root.serviceKey) ?? root.serviceKey,
      operation: root.operation,
      startTime: new Date(start).toISOString(),
      durationMs,
      status: errorCount > 0 ? "error" : "ok",
      spanCount: spans.length,
      errorCount,
      spans: spans
        .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
        .map((s) => ({
          traceId: s.traceId,
          spanId: s.spanId,
          parentSpanId: s.parentSpanId,
          serviceKey: s.serviceKey,
          serviceName: names.get(s.serviceKey) ?? s.serviceKey,
          operation: s.operation,
          kind: s.kind,
          startTime: s.startTime.toISOString(),
          durationMs: +s.durationMs.toFixed(1),
          status: s.status,
          errorMessage: s.errorMessage,
          tags: s.tags,
        })),
    });
  }
  traces.sort((a, b) => (a.startTime < b.startTime ? 1 : -1));
  return { traces: traces.slice(0, limit), mode };
}

export async function getTrace(traceId: string): Promise<ApmTrace | null> {
  const rows = await db.select().from(apmSpans).where(eq(apmSpans.traceId, traceId));
  if (!rows.length) return null;
  const registered = await db.select().from(apmServices);
  const names = new Map(registered.map((r) => [r.key, r.name]));
  const spans = rows
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
    .map((row) => ({
      traceId: row.traceId,
      spanId: row.spanId,
      parentSpanId: row.parentSpanId,
      serviceKey: row.serviceKey,
      serviceName: names.get(row.serviceKey) ?? row.serviceKey,
      operation: row.operation,
      kind: row.kind,
      startTime: row.startTime.toISOString(),
      durationMs: +row.durationMs.toFixed(1),
      status: row.status,
      errorMessage: row.errorMessage,
      tags: row.tags,
    }));
  const root = spans.find((s) => !s.parentSpanId) ?? spans[0];
  const errorCount = spans.filter((s) => s.status === "error").length;
  return {
    traceId,
    rootService: root.serviceKey,
    rootServiceName: names.get(root.serviceKey) ?? root.serviceKey,
    operation: root.operation,
    startTime: spans[0].startTime,
    durationMs: Math.max(...spans.map((s) => s.durationMs)),
    status: errorCount ? "error" : "ok",
    spanCount: spans.length,
    errorCount,
    spans,
  };
}

export async function serviceDetail(key: string): Promise<{
  node: ApmNode | null;
  operations: { operation: string; calls: number; avgMs: number; errors: number; p95Ms: number }[];
  slowest: ApmSpan[];
  errors: { operation: string; message: string; count: number }[];
}> {
  const topology = await getTopology();
  const node = topology.nodes.find((n) => n.key === key) ?? null;
  const since = new Date(Date.now() - WINDOW_MIN * 60_000);
  const rows = await db
    .select()
    .from(apmSpans)
    .where(and(gte(apmSpans.startTime, since), eq(apmSpans.serviceKey, key)))
    .orderBy(desc(apmSpans.durationMs))
    .limit(500);

  const byOperation = new Map<string, { calls: number; total: number; errors: number; durations: number[] }>();
  for (const row of rows) {
    const agg = byOperation.get(row.operation) ?? { calls: 0, total: 0, errors: 0, durations: [] };
    agg.calls += 1;
    agg.total += row.durationMs;
    agg.errors += row.status === "error" ? 1 : 0;
    agg.durations.push(row.durationMs);
    byOperation.set(row.operation, agg);
  }
  const errorsByName = new Map<string, { operation: string; message: string; count: number }>();
  for (const row of rows.filter((r) => r.errorMessage)) {
    const current = errorsByName.get(row.errorMessage!) ?? { operation: row.operation, message: row.errorMessage!, count: 0 };
    current.count += 1;
    errorsByName.set(row.errorMessage!, current);
  }

  return {
    node,
    operations: [...byOperation.entries()]
      .map(([operation, agg]) => ({
        operation,
        calls: agg.calls,
        avgMs: +(agg.total / agg.calls).toFixed(2),
        errors: agg.errors,
        p95Ms: percentile(agg.durations, 95),
      }))
      .sort((a, b) => b.calls - a.calls),
    slowest: rows.slice(0, 12).map((row) => ({
      traceId: row.traceId,
      spanId: row.spanId,
      parentSpanId: row.parentSpanId,
      serviceKey: row.serviceKey,
      serviceName: node?.name ?? key,
      operation: row.operation,
      kind: row.kind,
      startTime: row.startTime.toISOString(),
      durationMs: +row.durationMs.toFixed(1),
      status: row.status,
      errorMessage: row.errorMessage,
      tags: row.tags,
    })),
    errors: [...errorsByName.values()].sort((a, b) => b.count - a.count).slice(0, 6),
  };
}

export async function listAgents(): Promise<{ id: string; name: string; serviceKey: string; host: string; version: string; lastHeartbeatAt: string }[]> {
  const rows = await db.select().from(apmAgents).orderBy(desc(apmAgents.lastHeartbeatAt)).limit(50);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    serviceKey: row.serviceKey,
    host: row.host,
    version: row.version,
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
  }));
}

export async function resetTelemetry(): Promise<void> {
  await db.delete(apmSpans);
  await db.delete(apmEdges);
}

export async function registerService(input: {
  key: string;
  name?: string;
  kind?: string;
  runtime?: string;
  team?: string;
  containerId?: string;
}): Promise<void> {
  const existing = await db.select().from(apmServices).where(inArray(apmServices.key, [input.key])).limit(1);
  if (existing.length) {
    await db
      .update(apmServices)
      .set({ name: input.name ?? existing[0].name, lastSeenAt: new Date(), containerId: input.containerId ?? existing[0].containerId })
      .where(eq(apmServices.key, input.key));
    return;
  }
  await db.insert(apmServices).values({
    key: input.key,
    name: input.name ?? input.key,
    kind: input.kind ?? "service",
    runtime: input.runtime ?? "agent",
    team: input.team ?? "platform",
    containerId: input.containerId ?? null,
  });
}
