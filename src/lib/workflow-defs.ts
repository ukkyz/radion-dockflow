/** Shared between the workflow canvas (client) and the run engine (server). */

export interface WorkflowField {
  key: string;
  label: string;
  type: "text" | "number" | "select" | "textarea";
  placeholder?: string;
  options?: string[];
  help?: string;
}

export interface WorkflowNodeDef {
  type: string;
  label: string;
  description: string;
  accent: string;
  glyph: string;
  fields: WorkflowField[];
  outputs: string[];
}

export const WORKFLOW_NODE_DEFS: Record<string, WorkflowNodeDef> = {
  trigger: {
    type: "trigger",
    label: "Trigger",
    description: "Entry point of the run. Carries variables passed to the workflow.",
    accent: "#38bdf8",
    glyph: "▶",
    fields: [
      { key: "label", label: "Label", type: "text", placeholder: "manual deploy" },
      { key: "payload", label: "Variables (JSON)", type: "textarea", placeholder: '{"image":"vega/api:2.15.0"}' },
    ],
    outputs: ["triggered"],
  },
  dockerAction: {
    type: "dockerAction",
    label: "Docker action",
    description: "Start / stop / restart / pause / remove a container on the active engine.",
    accent: "#0ea5e9",
    glyph: "⛴",
    fields: [
      { key: "target", label: "Container", type: "text", placeholder: "vega-api or 3f2c1a (empty = {{container}})" },
      { key: "action", label: "Action", type: "select", options: ["start", "stop", "restart", "pause", "unpause", "kill", "remove"] },
      { key: "waitHealthy", label: "Wait until running", type: "select", options: ["no", "yes"] },
    ],
    outputs: ["mode", "containerId", "message"],
  },
  dockerRun: {
    type: "dockerRun",
    label: "Run container",
    description: "Create + start a new container from an image.",
    accent: "#0891b2",
    glyph: "＋",
    fields: [
      { key: "image", label: "Image", type: "text", placeholder: "nginx:1.27-alpine" },
      { key: "name", label: "Name", type: "text", placeholder: "tmp-{{image_tag}}" },
      { key: "ports", label: "Ports (host:container)", type: "text", placeholder: "8081:80" },
      { key: "env", label: "Env (K=V, comma separated)", type: "text", placeholder: "MODE=demo" },
      { key: "command", label: "Command", type: "text", placeholder: "/bin/sh -c 'sleep 5'" },
    ],
    outputs: ["mode", "containerId"],
  },
  dockerExec: {
    type: "dockerExec",
    label: "Exec in container",
    description: "Run a command inside a running container and capture the output.",
    accent: "#6366f1",
    glyph: "⌨",
    fields: [
      { key: "target", label: "Container", type: "text", placeholder: "vega-api" },
      { key: "command", label: "Command", type: "text", placeholder: "npm run migrate" },
      { key: "failOnNonZero", label: "Fail on non-zero exit", type: "select", options: ["yes", "no"] },
    ],
    outputs: ["exitCode", "output"],
  },
  dockerLogs: {
    type: "dockerLogs",
    label: "Inspect logs",
    description: "Read the tail of a container log and optionally require a pattern.",
    accent: "#7c3aed",
    glyph: "≡",
    fields: [
      { key: "target", label: "Container", type: "text", placeholder: "vega-orders" },
      { key: "tail", label: "Tail lines", type: "number", placeholder: "120" },
      { key: "mustContain", label: "Must contain", type: "text", placeholder: "listening on" },
      { key: "mustNotContain", label: "Must not contain", type: "text", placeholder: "Exception" },
    ],
    outputs: ["matched", "logTail"],
  },
  healthcheck: {
    type: "healthcheck",
    label: "Health check",
    description: "Poll an HTTP endpoint until it answers with the expected status.",
    accent: "#22c55e",
    glyph: "♥",
    fields: [
      { key: "url", label: "URL", type: "text", placeholder: "http://127.0.0.1:3001/health" },
      { key: "expectStatus", label: "Expected status", type: "number", placeholder: "200" },
      { key: "retries", label: "Retries", type: "number", placeholder: "3" },
      { key: "intervalMs", label: "Interval (ms)", type: "number", placeholder: "1000" },
    ],
    outputs: ["status", "body", "attempts"],
  },
  cli: {
    type: "cli",
    label: "CLI command",
    description: "Execute any local CLI application (docker compose, kubectl, psql, terraform...).",
    accent: "#f59e0b",
    glyph: "▮",
    fields: [
      { key: "binary", label: "Binary", type: "text", placeholder: "docker" },
      { key: "args", label: "Arguments", type: "text", placeholder: "compose -p vega-shop ps --format json" },
      { key: "cwd", label: "Working dir", type: "text", placeholder: "." },
      { key: "env", label: "Env (K=V, comma separated)", type: "text", placeholder: "COMPOSE_PROFILES=local" },
      { key: "timeoutMs", label: "Timeout (ms)", type: "number", placeholder: "30000" },
    ],
    outputs: ["exitCode", "stdout", "stderr"],
  },
  http: {
    type: "http",
    label: "HTTP request",
    description: "Call any HTTP API (webhook, Slack, K8s API, your own service).",
    accent: "#14b8a6",
    glyph: "⇄",
    fields: [
      { key: "url", label: "URL", type: "text", placeholder: "https://hooks.example.com/deploy" },
      { key: "method", label: "Method", type: "select", options: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      { key: "body", label: "Body (JSON)", type: "textarea", placeholder: '{"event":"deploy"}' },
      { key: "expectStatus", label: "Expected status", type: "number", placeholder: "200" },
    ],
    outputs: ["status", "body"],
  },
  delay: {
    type: "delay",
    label: "Delay",
    description: "Wait for a number of seconds (or milliseconds) between steps.",
    accent: "#a855f7",
    glyph: "⏱",
    fields: [
      { key: "seconds", label: "Seconds", type: "number", placeholder: "5" },
      { key: "milliseconds", label: "Extra ms", type: "number", placeholder: "0" },
    ],
    outputs: ["waitedMs"],
  },
  condition: {
    type: "condition",
    label: "Condition",
    description: "Gate the run: the downstream 'true' branch continues, 'false' is skipped.",
    accent: "#eab308",
    glyph: "?",
    fields: [
      { key: "expression", label: "Expression", type: "text", placeholder: "{{dockerExec_1.exitCode}} == 0" },
      { key: "description", label: "Note", type: "text", placeholder: "only deploy when migration passed" },
    ],
    outputs: ["result"],
  },
  notify: {
    type: "notify",
    label: "Notify",
    description: "Emit a message into the run timeline and the audit log.",
    accent: "#f472b6",
    glyph: "✉",
    fields: [
      { key: "message", label: "Message", type: "text", placeholder: "{{trigger.payload.image}} deployed" },
      { key: "level", label: "Level", type: "select", options: ["info", "warn", "error"] },
    ],
    outputs: ["message"],
  },
};

export const WORKFLOW_PALETTE_ORDER = [
  "trigger",
  "dockerAction",
  "dockerRun",
  "dockerExec",
  "dockerLogs",
  "healthcheck",
  "cli",
  "http",
  "delay",
  "condition",
  "notify",
];

export function defaultDataFor(type: string): Record<string, unknown> {
  const def = WORKFLOW_NODE_DEFS[type] ?? WORKFLOW_NODE_DEFS.cli;
  const data: Record<string, unknown> = { label: def.label, nodeType: type };
  for (const field of def.fields) {
    if (field.type === "select") data[field.key] = field.options?.[0] ?? "";
    else if (field.type === "number") data[field.key] = field.placeholder ?? "";
    else data[field.key] = "";
  }
  if (type === "dockerAction") {
    data.action = "restart";
    data.waitHealthy = "yes";
  }
  if (type === "cli") data.binary = "docker";
  if (type === "http") data.method = "POST";
  if (type === "dockerRun") data.ports = "8081:80";
  if (type === "healthcheck") {
    data.expectStatus = 200;
    data.retries = 3;
    data.intervalMs = 1000;
  }
  if (type === "condition") data.expression = "{{previous.exitCode}} == 0";
  if (type === "notify") data.level = "info";
  if (type === "trigger") data.label = "manual run";
  if (type === "delay") {
    data.seconds = 2;
    data.milliseconds = 0;
  }
  return data;
}
