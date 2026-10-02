import { pgTable, bigserial, integer, uuid, serial, varchar, text, smallint, boolean, jsonb, timestamp, real, primaryKey, unique } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const apmAgents = pgTable("apm_agents", {
	id: uuid().defaultRandom().primaryKey(),
	name: text().notNull(),
	serviceKey: text("service_key").notNull(),
	host: text().default("localhost").notNull(),
	version: text().default("1.0.0").notNull(),
	lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).default(sql`now()`).notNull(),
	meta: jsonb().default({}).notNull(),
});

export const apmEdges = pgTable("apm_edges", {
	id: serial().primaryKey(),
	sourceKey: text("source_key").notNull(),
	targetKey: text("target_key").notNull(),
	protocol: text().default("HTTP").notNull(),
	calls: integer().default(0).notNull(),
	errors: integer().default(0).notNull(),
	totalDurationMs: real("total_duration_ms").default(0).notNull(),
	maxDurationMs: real("max_duration_ms").default(0).notNull(),
	windowStart: timestamp("window_start", { withTimezone: true }).default(sql`now()`).notNull(),
});

export const apmServices = pgTable("apm_services", {
	id: uuid().defaultRandom().primaryKey(),
	key: text().notNull(),
	name: text().notNull(),
	kind: text().default("service").notNull(),
	runtime: text().default("unknown").notNull(),
	team: text().default("platform").notNull(),
	slaLatencyMs: integer("sla_latency_ms").default(300).notNull(),
	slaLatencyP95Ms: integer("sla_latency_p95_ms").default(800).notNull(),
	slaErrorPct: real("sla_error_pct").default(1).notNull(),
	containerId: text("container_id"),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).default(sql`now()`).notNull(),
	meta: jsonb().default({}).notNull(),
});

export const apmSpans = pgTable("apm_spans", {
	id: serial().primaryKey(),
	traceId: text("trace_id").notNull(),
	spanId: text("span_id").notNull(),
	parentSpanId: text("parent_span_id"),
	serviceKey: text("service_key").notNull(),
	operation: text().notNull(),
	kind: text().default("internal").notNull(),
	startTime: timestamp("start_time", { withTimezone: true }).notNull(),
	durationMs: real("duration_ms").default(0).notNull(),
	status: text().default("ok").notNull(),
	errorMessage: text("error_message"),
	tags: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
});

export const cliTools = pgTable("cli_tools", {
	id: uuid().defaultRandom().primaryKey(),
	name: text().notNull(),
	description: text().default("").notNull(),
	binary: text().notNull(),
	baseArgs: text("base_args").default("").notNull(),
	cwd: text().default(".").notNull(),
	envVars: jsonb("env_vars").default({}).notNull(),
	category: text().default("general").notNull(),
	favorite: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
});

export const dockerHosts = pgTable("docker_hosts", {
	id: uuid().defaultRandom().primaryKey(),
	name: text().notNull(),
	kind: text().default("unix").notNull(),
	address: text().notNull(),
	isDefault: boolean("is_default").default(false).notNull(),
	status: text().default("unknown").notNull(),
	serverVersion: text("server_version"),
	lastError: text("last_error"),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
});

export const executionLogs = pgTable("execution_logs", {
	id: serial().primaryKey(),
	executionId: text("execution_id").notNull(),
	nodeId: text("node_id").notNull(),
	nodeType: text("node_type").notNull(),
	status: text().notNull(),
	inputData: jsonb("input_data").default(null),
	outputData: jsonb("output_data").default(null),
	errorMessage: text("error_message"),
	durationMs: integer("duration_ms"),
	startedAt: timestamp("started_at"),
	completedAt: timestamp("completed_at"),
	createdAt: timestamp("created_at").default(sql`now()`).notNull(),
	updatedAt: timestamp("updated_at"),
});

export const executionRecords = pgTable("execution_records", {
	id: serial().primaryKey(),
	workflowId: integer("workflow_id").notNull(),
	executionId: text("execution_id").notNull(),
	status: text().default("pending").notNull(),
	workflowSnapshot: jsonb("workflow_snapshot").notNull(),
	inputData: jsonb("input_data").default(null),
	outputData: jsonb("output_data").default(null),
	errorMessage: text("error_message"),
	totalNodes: integer("total_nodes").default(0).notNull(),
	completedNodes: integer("completed_nodes").default(0).notNull(),
	durationMs: integer("duration_ms"),
	startedAt: timestamp("started_at"),
	completedAt: timestamp("completed_at"),
	createdAt: timestamp("created_at").default(sql`now()`).notNull(),
	updatedAt: timestamp("updated_at"),
});

export const failedJobs = pgTable("failed_jobs", {
	id: bigserial({ mode: 'number' }).primaryKey(),
	uuid: varchar({ length: 255 }).notNull(),
	connection: varchar({ length: 255 }).notNull(),
	queue: varchar({ length: 255 }).notNull(),
	payload: text().notNull(),
	exception: text().notNull(),
	failedAt: timestamp("failed_at", { precision: 0 }).default(sql`now()`).notNull(),
}, (table) => [
	unique("failed_jobs_uuid_unique").on(table.uuid),]);

export const jobBatches = pgTable("job_batches", {
	id: varchar({ length: 255 }).primaryKey(),
	name: varchar({ length: 255 }).notNull(),
	totalJobs: integer("total_jobs").notNull(),
	pendingJobs: integer("pending_jobs").notNull(),
	failedJobs: integer("failed_jobs").notNull(),
	failedJobIds: text("failed_job_ids").notNull(),
	options: text(),
	cancelledAt: integer("cancelled_at"),
	createdAt: integer("created_at").notNull(),
	finishedAt: integer("finished_at"),
	updatedAt: timestamp("updated_at"),
});

export const jobs = pgTable("jobs", {
	id: bigserial({ mode: 'number' }).primaryKey(),
	queue: varchar({ length: 255 }).notNull(),
	payload: text().notNull(),
	attempts: smallint().notNull(),
	reservedAt: integer("reserved_at"),
	availableAt: integer("available_at").notNull(),
	createdAt: integer("created_at").notNull(),
	updatedAt: timestamp("updated_at"),
});

export const workflowDefinitions = pgTable("workflow_definitions", {
	id: serial().primaryKey(),
	name: text().notNull(),
	label: text().notNull(),
	description: text(),
	version: integer().default(1).notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	definition: jsonb().notNull(),
	metadata: jsonb().default({}),
	createdBy: serial("created_by").notNull(),
	createdByName: text("created_by_name").default("SYSTEM").notNull(),
	createdAt: timestamp("created_at").default(sql`now()`).notNull(),
	updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
});

export const workflowRuns = pgTable("workflow_runs", {
	id: uuid().defaultRandom().primaryKey(),
	workflowId: text("workflow_id").notNull(),
	workflowName: text("workflow_name").default("").notNull(),
	status: text().default("running").notNull(),
	trigger: text().default("manual").notNull(),
	startedAt: timestamp("started_at", { withTimezone: true }).default(sql`now()`).notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true }),
	durationMs: integer("duration_ms"),
	steps: jsonb().default([]).notNull(),
});

export const workflows = pgTable("workflows", {
	id: integer().primaryKey(),
	name: text().notNull(),
	description: text().notNull(),
	nodes: jsonb().default([]).notNull(),
	label: text(),
	graph: jsonb(),
	sessionId: text("session_id"),
	framework: text(),
	connections: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`now()`).notNull(),
});
