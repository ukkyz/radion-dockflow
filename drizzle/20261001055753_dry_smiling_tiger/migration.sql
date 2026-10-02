-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TABLE "apm_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"service_key" text NOT NULL,
	"host" text DEFAULT 'localhost' NOT NULL,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"meta" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apm_edges" (
	"id" serial PRIMARY KEY,
	"source_key" text NOT NULL,
	"target_key" text NOT NULL,
	"protocol" text DEFAULT 'HTTP' NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"total_duration_ms" real DEFAULT 0 NOT NULL,
	"max_duration_ms" real DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apm_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'service' NOT NULL,
	"runtime" text DEFAULT 'unknown' NOT NULL,
	"team" text DEFAULT 'platform' NOT NULL,
	"sla_latency_ms" integer DEFAULT 300 NOT NULL,
	"sla_latency_p95_ms" integer DEFAULT 800 NOT NULL,
	"sla_error_pct" real DEFAULT 1 NOT NULL,
	"container_id" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"meta" jsonb DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apm_spans" (
	"id" serial PRIMARY KEY,
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"parent_span_id" text,
	"service_key" text NOT NULL,
	"operation" text NOT NULL,
	"kind" text DEFAULT 'internal' NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"duration_ms" real DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"error_message" text,
	"tags" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cli_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"binary" text NOT NULL,
	"base_args" text DEFAULT '' NOT NULL,
	"cwd" text DEFAULT '.' NOT NULL,
	"env_vars" jsonb DEFAULT '{}' NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"favorite" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docker_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"kind" text DEFAULT 'unix' NOT NULL,
	"address" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"server_version" text,
	"last_error" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_logs" (
	"id" serial PRIMARY KEY,
	"execution_id" text NOT NULL,
	"node_id" text NOT NULL,
	"node_type" text NOT NULL,
	"status" text NOT NULL,
	"input_data" jsonb DEFAULT 'null',
	"output_data" jsonb DEFAULT 'null',
	"error_message" text,
	"duration_ms" integer,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "execution_records" (
	"id" serial PRIMARY KEY,
	"workflow_id" integer NOT NULL,
	"execution_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"workflow_snapshot" jsonb NOT NULL,
	"input_data" jsonb DEFAULT 'null',
	"output_data" jsonb DEFAULT 'null',
	"error_message" text,
	"total_nodes" integer DEFAULT 0 NOT NULL,
	"completed_nodes" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "failed_jobs" (
	"id" bigserial PRIMARY KEY,
	"uuid" varchar(255) NOT NULL CONSTRAINT "failed_jobs_uuid_unique" UNIQUE,
	"connection" varchar(255) NOT NULL,
	"queue" varchar(255) NOT NULL,
	"payload" text NOT NULL,
	"exception" text NOT NULL,
	"failed_at" timestamp(0) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_batches" (
	"id" varchar(255) PRIMARY KEY,
	"name" varchar(255) NOT NULL,
	"total_jobs" integer NOT NULL,
	"pending_jobs" integer NOT NULL,
	"failed_jobs" integer NOT NULL,
	"failed_job_ids" text NOT NULL,
	"options" text,
	"cancelled_at" integer,
	"created_at" integer NOT NULL,
	"finished_at" integer,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY,
	"queue" varchar(255) NOT NULL,
	"payload" text NOT NULL,
	"attempts" smallint NOT NULL,
	"reserved_at" integer,
	"available_at" integer NOT NULL,
	"created_at" integer NOT NULL,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "workflow_definitions" (
	"id" serial PRIMARY KEY,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"definition" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}',
	"created_by" serial,
	"created_by_name" text DEFAULT 'SYSTEM' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workflow_id" text NOT NULL,
	"workflow_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"steps" jsonb DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" integer PRIMARY KEY,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"nodes" jsonb DEFAULT '[]' NOT NULL,
	"label" text,
	"graph" jsonb,
	"session_id" text,
	"framework" text,
	"connections" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

*/