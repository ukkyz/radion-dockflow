import { randomUUID } from "node:crypto";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * SQLite schema (better-sqlite3 + drizzle-orm/sqlite-core).
 * Timestamps are stored as unix seconds, JSON payloads as TEXT, ids as TEXT uuid4.
 */

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID());

const createdAt = () =>
  integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date());

const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

/** Docker engine endpoints (unix socket, tcp://localhost:2375, npipe). */
export const dockerHosts = sqliteTable(
  "docker_hosts",
  {
    id: id(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("unix"), // unix | tcp | npipe
    address: text("address").notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull().default("unknown"),
    serverVersion: text("server_version"),
    lastError: text("last_error"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("docker_hosts_address_uq").on(t.address)],
);

/** Any CLI-capable application the operator wants to drive from the UI. */
export const cliTools = sqliteTable("cli_tools", {
  id: id(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  binary: text("binary").notNull(),
  baseArgs: text("base_args").notNull().default(""),
  cwd: text("cwd").notNull().default("."),
  envVars: json<Record<string, string>>("env_vars").notNull().default({}),
  category: text("category").notNull().default("general"),
  favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

export const workflows = sqliteTable("workflows", {
  id: id(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  graph: json<WorkflowGraph>("graph").notNull(),
  createdAt: createdAt(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const workflowRuns = sqliteTable("workflow_runs", {
  id: id(),
  workflowId: text("workflow_id").notNull(),
  workflowName: text("workflow_name").notNull().default(""),
  status: text("status").notNull().default("running"), // running | success | failed
  trigger: text("trigger").notNull().default("manual"),
  startedAt: integer("started_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
  durationMs: integer("duration_ms"),
  steps: json<RunStep[]>("steps").notNull().default([]),
});

/** Service nodes discovered by the APM agent registry / ingestion API. */
export const apmServices = sqliteTable(
  "apm_services",
  {
    id: id(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("service"), // service | db | cache | queue | external | gateway
    runtime: text("runtime").notNull().default("unknown"),
    team: text("team").notNull().default("platform"),
    slaLatencyMs: integer("sla_latency_ms").notNull().default(300),
    slaLatencyP95Ms: integer("sla_latency_p95_ms").notNull().default(800),
    slaErrorPct: real("sla_error_pct").notNull().default(1),
    containerId: text("container_id"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    meta: json<Record<string, unknown>>("meta").notNull().default({}),
  },
  (t) => [uniqueIndex("apm_services_key_uq").on(t.key)],
);

export const apmAgents = sqliteTable(
  "apm_agents",
  {
    id: id(),
    name: text("name").notNull(),
    serviceKey: text("service_key").notNull(),
    host: text("host").notNull().default("localhost"),
    version: text("version").notNull().default("1.0.0"),
    lastHeartbeatAt: integer("last_heartbeat_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    meta: json<Record<string, unknown>>("meta").notNull().default({}),
  },
  (t) => [uniqueIndex("apm_agents_uq").on(t.name, t.serviceKey)],
);

/** Raw spans pushed by agents (or synthesised in demo mode). */
export const apmSpans = sqliteTable("apm_spans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  traceId: text("trace_id").notNull(),
  spanId: text("span_id").notNull(),
  parentSpanId: text("parent_span_id"),
  serviceKey: text("service_key").notNull(),
  operation: text("operation").notNull(),
  kind: text("kind").notNull().default("internal"),
  startTime: integer("start_time", { mode: "timestamp" }).notNull(),
  durationMs: real("duration_ms").notNull().default(0),
  status: text("status").notNull().default("ok"),
  errorMessage: text("error_message"),
  tags: json<Record<string, unknown>>("tags").notNull().default({}),
  createdAt: createdAt(),
});

/** Aggregated call edges between services (rollup so the map stays fast). */
export const apmEdges = sqliteTable(
  "apm_edges",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceKey: text("source_key").notNull(),
    targetKey: text("target_key").notNull(),
    protocol: text("protocol").notNull().default("HTTP"),
    calls: integer("calls").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    totalDurationMs: real("total_duration_ms").notNull().default(0),
    maxDurationMs: real("max_duration_ms").notNull().default(0),
    windowStart: integer("window_start", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("apm_edges_uq").on(t.sourceKey, t.targetKey, t.protocol)],
);

/** JVM / JMX monitoring targets (remote JMX via Jolokia, Spring Actuator, or simulated). */
export const jvmTargets = sqliteTable(
  "jvm_targets",
  {
    id: id(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("simulated"), // jolokia | actuator | simulated
    url: text("url").notNull().default(""),
    host: text("host").notNull().default("localhost"),
    app: text("app").notNull().default(""),
    containerId: text("container_id"),
    project: text("project"),
    autoDiscovered: integer("auto_discovered", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull().default("unknown"), // online | offline | simulated | unknown
    jvmVersion: text("jvm_version"),
    javaVendor: text("java_vendor"),
    lastError: text("last_error"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
    source: text("source").notNull().default("manual"), // manual | engine
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("jvm_targets_name_uq").on(t.name)],
);

/** Captured thread dumps, heap dumps and saved profile snapshots. */
export const jvmDumps = sqliteTable(
  "jvm_dumps",
  {
    id: id(),
    targetId: text("target_id").notNull(),
    targetName: text("target_name").notNull().default(""),
    kind: text("kind").notNull(), // thread | heap | profile
    sizeKb: integer("size_kb").notNull().default(0),
    path: text("path"),
    summary: json<Record<string, unknown>>("summary").notNull().default({}),
    content: text("content").notNull().default(""),
    createdAt: createdAt(),
  },
  // two dumps can share the same second, so this must not be unique
  (t) => [index("jvm_dumps_target_idx").on(t.targetId, t.createdAt)],
);

/** Saved/loaded configuration sources: compose files, terraform modules, GitHub repos. */
export const configSources = sqliteTable("config_sources", {
  id: id(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("compose"), // compose | terraform | github
  target: text("target").notNull().default(""), // file path or owner/name
  content: text("content").notNull().default(""),
  summary: json<Record<string, unknown>>("summary").notNull().default({}),
  status: text("status").notNull().default("ready"), // ready | error
  lastError: text("last_error"),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  lastLoadedAt: integer("last_loaded_at", { mode: "timestamp" }),
});

export interface WorkflowGraph {
  nodes: {
    id: string;
    type: string;
    position: { x: number; y: number };
    data: Record<string, unknown>;
    parentId?: string;
    extent?: "parent";
  }[];
  edges: { id: string; source: string; target: string; label?: string }[];
}

export interface RunStep {
  nodeId: string;
  label: string;
  type: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  output: string;
  exitCode?: number | null;
}
