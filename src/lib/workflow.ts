import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { workflowRuns, workflows, type RunStep, type WorkflowGraph } from "@/db/schema";
import { runCli } from "./cli";
import { containerAction, execInContainer, getContainerLogs, listContainers, runNewContainer, type ContainerAction } from "./docker";

const cancelled = new Set<string>();

export function cancelRun(runId: string): void {
  cancelled.add(runId);
}

type Fields = Record<string, unknown>;

interface NodeResult {
  ok: boolean;
  output: string;
  fields: Fields;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveTemplate(template: string, ctx: Record<string, Fields>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, path: string) => {
    const parts = path.split(".");
    let current: unknown = ctx;
    for (const part of parts) {
      if (current && typeof current === "object" && part in (current as Fields)) {
        current = (current as Fields)[part];
      } else {
        return "";
      }
    }
    if (current !== null && typeof current === "object" && "value" in (current as Fields)) {
      current = (current as Fields).value;
    }
    if (current === undefined || current === null) return "";
    return typeof current === "string" ? current : JSON.stringify(current);
  });
}

function parseKeyValue(input: unknown): string[] {
  if (typeof input !== "string" || !input.trim()) return [];
  return input
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean);
}

function evaluateExpression(raw: string, ctx: Record<string, Fields>): boolean {
  const text = resolveTemplate(raw ?? "", ctx).trim();
  if (!text) return true;
  const operators = ["contains", "==", "!=", ">=", "<=", ">", "<", "matches"];
  for (const op of operators) {
    const index = text.indexOf(` ${op} `);
    if (index === -1) continue;
    const left = text.slice(0, index).trim();
    const right = text.slice(index + op.length + 2).trim();
    switch (op) {
      case "contains":
        return left.includes(right);
      case "matches":
        try {
          return new RegExp(right).test(left);
        } catch {
          return false;
        }
      case "==":
        return left === right;
      case "!=":
        return left !== right;
      case ">":
        return Number(left) > Number(right);
      case "<":
        return Number(left) < Number(right);
      case ">=":
        return Number(left) >= Number(right);
      case "<=":
        return Number(left) <= Number(right);
      default:
        return false;
    }
  }
  return !["false", "0", "no", ""].includes(text.toLowerCase());
}

async function resolveContainer(target: string, ctx: Record<string, Fields>): Promise<string> {
  const wanted = resolveTemplate(target ?? "", ctx).trim();
  const { containers } = await listContainers();
  if (!wanted) throw new Error("no container target given (set the container name or pass {{container}})");
  const match =
    containers.find((c) => c.id === wanted) ??
    containers.find((c) => c.id.startsWith(wanted)) ??
    containers.find((c) => c.name === wanted) ??
    containers.find((c) => c.composeService === wanted) ??
    containers.find((c) => c.name.startsWith(wanted));
  if (!match) throw new Error(`container "${wanted}" not found on the active engine`);
  return match.id;
}

async function waitForRunning(id: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { containers } = await listContainers();
    const found = containers.find((c) => c.id === id);
    if (found && found.state === "running") return true;
    await sleep(900);
  }
  return false;
}

async function executeNode(
  node: WorkflowGraph["nodes"][number],
  ctx: Record<string, Fields>,
): Promise<NodeResult> {
  const data = (node.data ?? {}) as Fields;
  const type = String(data.nodeType ?? node.type ?? "cli");
  const t = (key: string, fallback = "") => resolveTemplate(String(data[key] ?? fallback), ctx);

  switch (type) {
    case "trigger": {
      return { ok: true, output: `triggered (${t("label", "manual run")})`, fields: {} };
    }
    case "dockerAction": {
      const id = await resolveContainer(String(data.target ?? ""), ctx);
      const action = t("action", "restart") as ContainerAction;
      const res = await containerAction(id, action);
      let extra = "";
      if (t("waitHealthy", "no") === "yes" && ["start", "restart", "unpause"].includes(action)) {
        const healthy = await waitForRunning(id);
        extra = healthy ? " · container reported running" : " · container did not reach running state in 15s";
      }
      return {
        ok: true,
        output: `${res.message}${extra} (mode=${res.mode})`,
        fields: { mode: res.mode, containerId: id, container: id, message: res.message },
      };
    }
    case "dockerRun": {
      const image = t("image");
      if (!image) return { ok: false, output: "image is required", fields: { exitCode: 1 } };
      const ports = parseKeyValue(data.ports).map((pair) => {
        const [host, container] = pair.split(":");
        return { host: Number(host), container: Number(container), protocol: "tcp" };
      });
      const res = await runNewContainer({
        image,
        name: t("name") || undefined,
        ports,
        env: parseKeyValue(data.env),
        command: t("command") || undefined,
      });
      return {
        ok: true,
        output: res.message,
        fields: { mode: res.mode, containerId: res.id, container: res.id, exitCode: 0 },
      };
    }
    case "dockerExec": {
      const id = await resolveContainer(String(data.target ?? ""), ctx);
      const command = t("command");
      if (!command) return { ok: false, output: "command is required", fields: { exitCode: 1 } };
      const res = await execInContainer(id, ["/bin/sh", "-lc", command]);
      const failOnNonZero = t("failOnNonZero", "yes") === "yes";
      const failed = failOnNonZero && res.exitCode !== 0 && res.exitCode !== null;
      return {
        ok: !failed,
        output: `exit=${res.exitCode ?? 0}\n${res.output.slice(0, 4000)}`,
        fields: { exitCode: res.exitCode ?? 0, output: res.output, containerId: id, container: id },
      };
    }
    case "dockerLogs": {
      const id = await resolveContainer(String(data.target ?? ""), ctx);
      const tail = Number(data.tail ?? 120) || 120;
      const { logs } = await getContainerLogs(id, tail);
      const mustContain = t("mustContain");
      const mustNotContain = t("mustNotContain");
      let ok = true;
      const notes: string[] = [];
      if (mustContain && !logs.includes(mustContain)) {
        ok = false;
        notes.push(`missing required pattern "${mustContain}"`);
      }
      if (mustNotContain && logs.includes(mustNotContain)) {
        ok = false;
        notes.push(`found forbidden pattern "${mustNotContain}"`);
      }
      return {
        ok,
        output: `${notes.join(" · ") || "log patterns satisfied"}\n${logs.slice(-1500)}`,
        fields: { matched: ok, logTail: logs.slice(-2000), containerId: id },
      };
    }
    case "healthcheck": {
      const url = t("url");
      if (!url) return { ok: false, output: "url is required", fields: { status: 0 } };
      const expect = Number(data.expectStatus ?? 200) || 200;
      const retries = Math.max(1, Number(data.retries ?? 3) || 3);
      const interval = Math.max(200, Number(data.intervalMs ?? 1000) || 1000);
      let lastStatus = 0;
      let body = "";
      for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(4000), cache: "no-store" });
          lastStatus = res.status;
          body = (await res.text()).slice(0, 2000);
        } catch (error) {
          lastStatus = 0;
          body = error instanceof Error ? error.message : String(error);
        }
        if (lastStatus === expect) {
          return { ok: true, output: `attempt ${attempt}/${retries}: status ${lastStatus}\n${body.slice(0, 800)}`, fields: { status: lastStatus, body, attempts: attempt } };
        }
        if (attempt < retries) await sleep(interval);
      }
      return { ok: false, output: `expected ${expect}, last status ${lastStatus}\n${body.slice(0, 800)}`, fields: { status: lastStatus, body, attempts: retries } };
    }
    case "cli": {
      const binary = t("binary");
      if (!binary) return { ok: false, output: "binary is required", fields: { exitCode: 1 } };
      const args = t("args").split(/\s+/).filter(Boolean);
      const res = await runCli({
        binary,
        args,
        cwd: t("cwd") || process.cwd(),
        env: Object.fromEntries(parseKeyValue(data.env).map((p) => p.split("=") as [string, string])),
        timeoutMs: Number(data.timeoutMs ?? 30_000) || 30_000,
      });
      const ok = res.exitCode === 0;
      return {
        ok,
        output: `$ ${res.command}\nexit=${res.exitCode ?? "null"} (${res.durationMs}ms)\n${(res.stdout || res.stderr).slice(0, 4000)}`,
        fields: { exitCode: res.exitCode ?? -1, stdout: res.stdout, stderr: res.stderr, command: res.command },
      };
    }
    case "http": {
      const url = t("url");
      if (!url) return { ok: false, output: "url is required", fields: { status: 0 } };
      const method = t("method", "POST");
      const expect = Number(data.expectStatus ?? 200) || 200;
      try {
        const res = await fetch(url, {
          method,
          headers: { "content-type": "application/json" },
          body: ["GET", "DELETE"].includes(method) || !String(data.body ?? "").trim() ? undefined : resolveTemplate(String(data.body), ctx),
          signal: AbortSignal.timeout(6000),
        });
        const body = (await res.text()).slice(0, 2000);
        return {
          ok: expect === 0 || res.status === expect,
          output: `${method} ${url} → ${res.status}\n${body.slice(0, 800)}`,
          fields: { status: res.status, body },
        };
      } catch (error) {
        return { ok: false, output: error instanceof Error ? error.message : String(error), fields: { status: 0, body: "" } };
      }
    }
    case "delay": {
      const waitMs = Math.min(30_000, (Number(data.seconds ?? 1) || 0) * 1000 + (Number(data.milliseconds ?? 0) || 0));
      await sleep(waitMs);
      return { ok: true, output: `waited ${waitMs}ms`, fields: { waitedMs: waitMs } };
    }
    case "condition": {
      const result = evaluateExpression(String(data.expression ?? ""), ctx);
      return {
        ok: true,
        output: `expression "${resolveTemplate(String(data.expression ?? ""), ctx)}" → ${result}`,
        fields: { result, branch: result ? "true" : "false" },
      };
    }
    case "notify": {
      const message = t("message", "workflow event");
      return { ok: true, output: `[${t("level", "info")}] ${message}`, fields: { message } };
    }
    default:
      return { ok: false, output: `unsupported node type "${type}"`, fields: {} };
  }
}

export async function createRun(workflowId: string, trigger = "manual", payload: Record<string, unknown> = {}) {
  const rows = await db.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1);
  if (!rows.length) throw new Error("workflow not found");
  const workflow = rows[0];
  const graph = workflow.graph as WorkflowGraph;

  const steps: RunStep[] = graph.nodes.map((node) => ({
    nodeId: node.id,
    label: String((node.data as Fields)?.label ?? node.type),
    type: String((node.data as Fields)?.nodeType ?? node.type),
    status: "pending",
    output: "",
  }));

  const inserted = await db
    .insert(workflowRuns)
    .values({
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: "running",
      trigger,
      steps,
    })
    .returning({ id: workflowRuns.id });

  const runId = inserted[0].id;
  void executeRun(runId, graph, payload).catch(async (error) => {
    await db
      .update(workflowRuns)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(workflowRuns.id, runId));
    console.error("workflow run failed", error);
  });
  return { runId, workflowName: workflow.name, stepCount: steps.length };
}

async function executeRun(runId: string, graph: WorkflowGraph, payload: Record<string, unknown>): Promise<void> {
  const startedAt = Date.now();
  const ctx: Record<string, Fields> = { trigger: {} };
  const statuses = new Map<string, RunStep["status"]>();

  const triggerNode = graph.nodes.find((n) => String((n.data as Fields)?.nodeType ?? n.type) === "trigger");
  const triggerData = (triggerNode?.data ?? {}) as Fields;
  let triggerPayload: Record<string, unknown> = {};
  const rawPayload = String(triggerData.payload ?? "").trim();
  if (rawPayload) {
    try {
      triggerPayload = JSON.parse(resolveTemplate(rawPayload, { trigger: {} })) as Record<string, unknown>;
    } catch {
      triggerPayload = { raw: rawPayload };
    }
  }
  ctx.trigger = { ...triggerPayload, ...payload, label: String(triggerData.label ?? "manual run") };
  if (typeof ctx.trigger.container === "string") ctx.container = { value: ctx.trigger.container };
  const triggerOutput = ctx.trigger.container;
  ctx.container = { value: String(triggerOutput ?? "") };

  const incoming = new Map<string, { source: string; label?: string }[]>();
  for (const edge of graph.edges) {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), { source: edge.source, label: edge.label }]);
  }

  // order: trigger first, then a BFS over outgoing edges
  const order: string[] = [];
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  const queue = triggerNode ? [triggerNode.id] : graph.nodes.slice(0, 1).map((n) => n.id);
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const next of outgoing.get(id) ?? []) queue.push(next);
  }
  for (const node of graph.nodes) if (!seen.has(node.id)) order.push(node.id);

  const persist = async (steps: RunStep[], status: string, finished = false) => {
    await db
      .update(workflowRuns)
      .set({
        steps,
        status,
        finishedAt: finished ? new Date() : null,
        durationMs: finished ? Date.now() - startedAt : null,
      })
      .where(eq(workflowRuns.id, runId));
  };

  const steps: RunStep[] = graph.nodes.map((node) => ({
    nodeId: node.id,
    label: String((node.data as Fields)?.label ?? node.type),
    type: String((node.data as Fields)?.nodeType ?? node.type),
    status: "pending",
    output: "",
  }));
  const stepById = new Map(steps.map((s) => [s.nodeId, s]));
  await persist(steps, "running");

  let failed = false;
  for (const nodeId of order) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    const step = stepById.get(nodeId);
    if (!node || !step) continue;
    if (cancelled.has(runId)) {
      step.status = "skipped";
      step.output = "run cancelled by operator";
      statuses.set(nodeId, "skipped");
      continue;
    }

    const deps = incoming.get(nodeId) ?? [];
    const blocked = deps.some((dep) => {
      const depStatus = statuses.get(dep.source);
      if (depStatus === "failed" || depStatus === "skipped") return true;
      const depStep = stepById.get(dep.source);
      const depType = depStep?.type;
      if (depType === "condition") {
        const result = Boolean((ctx[dep.source] ?? {}).result);
        const label = (dep.label ?? "").toLowerCase();
        if (label.includes("false") && result) return true;
        if (label.includes("true") && !result) return true;
      }
      return false;
    });
    if (blocked || failed) {
      step.status = "skipped";
      step.output = failed ? "skipped because an upstream step failed" : "branch not taken";
      statuses.set(nodeId, "skipped");
      await persist(steps, "running");
      continue;
    }

    step.status = "running";
    step.startedAt = new Date().toISOString();
    await persist(steps, "running");

    try {
      const result = await executeNode(node, ctx);
      ctx[nodeId] = { ...result.fields, output: result.output };
      ctx.previous = { ...result.fields, output: result.output };
      step.status = result.ok ? "success" : "failed";
      step.output = result.output.slice(0, 6000);
      step.durationMs = Date.now() - (step.startedAt ? new Date(step.startedAt).getTime() : Date.now());
      statuses.set(nodeId, step.status);
      if (!result.ok) failed = true;
    } catch (error) {
      step.status = "failed";
      step.output = error instanceof Error ? error.message : String(error);
      step.durationMs = Date.now() - (step.startedAt ? new Date(step.startedAt).getTime() : Date.now());
      statuses.set(nodeId, "failed");
      failed = true;
    }
    await persist(steps, "running");
  }

  await persist(steps, failed ? "failed" : "success", true);
  cancelled.delete(runId);
}

export async function listRuns(workflowId?: string, limit = 25) {
  const rows = workflowId
    ? await db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId)).orderBy(desc(workflowRuns.startedAt)).limit(limit)
    : await db.select().from(workflowRuns).orderBy(desc(workflowRuns.startedAt)).limit(limit);
  return rows.map((row) => ({
    id: row.id,
    workflowId: row.workflowId,
    workflowName: row.workflowName,
    status: row.status,
    trigger: row.trigger,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    durationMs: row.durationMs,
    steps: row.steps,
  }));
}

export async function getRun(runId: string) {
  const rows = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
  if (!rows.length) return null;
  const row = rows[0];
  return {
    id: row.id,
    workflowId: row.workflowId,
    workflowName: row.workflowName,
    status: row.status,
    trigger: row.trigger,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    durationMs: row.durationMs,
    steps: row.steps,
  };
}
