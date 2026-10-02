/**
 * Idempotent DDL applied on first database access, so a fresh sandbox works with
 * zero migration steps. Keep this in sync with src/db/schema.ts
 * (`npx drizzle-kit push` produces the same shape).
 */
export const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS docker_hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'unix',
  address TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unknown',
  server_version TEXT,
  last_error TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS docker_hosts_address_uq ON docker_hosts (address);

CREATE TABLE IF NOT EXISTS cli_tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  binary TEXT NOT NULL,
  base_args TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL DEFAULT '.',
  env_vars TEXT NOT NULL DEFAULT '{}',
  category TEXT NOT NULL DEFAULT 'general',
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  graph TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  trigger TEXT NOT NULL DEFAULT 'manual',
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER,
  steps TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS workflow_runs_workflow_idx ON workflow_runs (workflow_id, started_at);

CREATE TABLE IF NOT EXISTS apm_services (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'service',
  runtime TEXT NOT NULL DEFAULT 'unknown',
  team TEXT NOT NULL DEFAULT 'platform',
  sla_latency_ms INTEGER NOT NULL DEFAULT 300,
  sla_latency_p95_ms INTEGER NOT NULL DEFAULT 800,
  sla_error_pct REAL NOT NULL DEFAULT 1,
  container_id TEXT,
  last_seen_at INTEGER NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS apm_services_key_uq ON apm_services (key);

CREATE TABLE IF NOT EXISTS apm_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  service_key TEXT NOT NULL,
  host TEXT NOT NULL DEFAULT 'localhost',
  version TEXT NOT NULL DEFAULT '1.0.0',
  last_heartbeat_at INTEGER NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS apm_agents_uq ON apm_agents (name, service_key);

CREATE TABLE IF NOT EXISTS apm_spans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  service_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'internal',
  start_time INTEGER NOT NULL,
  duration_ms REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  error_message TEXT,
  tags TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS apm_spans_trace_idx ON apm_spans (trace_id);
CREATE INDEX IF NOT EXISTS apm_spans_service_time_idx ON apm_spans (service_key, start_time);
CREATE INDEX IF NOT EXISTS apm_spans_start_idx ON apm_spans (start_time);

CREATE TABLE IF NOT EXISTS jvm_targets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'simulated',
  url TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT 'localhost',
  app TEXT NOT NULL DEFAULT '',
  container_id TEXT,
  project TEXT,
  auto_discovered INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unknown',
  jvm_version TEXT,
  java_vendor TEXT,
  last_error TEXT,
  last_seen_at INTEGER,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS jvm_targets_name_uq ON jvm_targets (name);

CREATE TABLE IF NOT EXISTS jvm_dumps (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  target_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  size_kb INTEGER NOT NULL DEFAULT 0,
  path TEXT,
  summary TEXT NOT NULL DEFAULT '{}',
  content TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jvm_dumps_target_idx ON jvm_dumps (target_id, created_at);

CREATE TABLE IF NOT EXISTS apm_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL,
  target_key TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'HTTP',
  calls INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  total_duration_ms REAL NOT NULL DEFAULT 0,
  max_duration_ms REAL NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS apm_edges_uq ON apm_edges (source_key, target_key, protocol);
`;
