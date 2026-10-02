"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { apiPost, apiPut, cls, timeAgo, TONE_CLASSES, useApi } from "@/lib/client";
import { WORKFLOW_NODE_DEFS, WORKFLOW_PALETTE_ORDER, defaultDataFor } from "@/lib/workflow-defs";

export interface WorkflowGraphPayload {
  id: string;
  name: string;
  description: string;
  graph: {
    nodes: { id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown> }[];
    edges: { id: string; source: string; target: string; label?: string }[];
  };
  updatedAt: string;
}

interface RunStepPayload {
  nodeId: string;
  label: string;
  type: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  output: string;
  durationMs?: number;
}

interface RunPayload {
  id: string;
  workflowName: string;
  status: string;
  trigger: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  steps: RunStepPayload[];
}

const STATUS_TONE: Record<string, string> = {
  success: "good",
  failed: "bad",
  running: "info",
  pending: "idle",
  skipped: "warn",
};

function WorkflowNodeView({ data, selected }: NodeProps) {
  const node = data as unknown as {
    label: string;
    nodeType: string;
    _status?: string;
    _summary?: string;
  };
  const def = WORKFLOW_NODE_DEFS[node.nodeType] ?? WORKFLOW_NODE_DEFS.cli;
  const tone = STATUS_TONE[node._status ?? "pending"] ?? "idle";
  const palette = TONE_CLASSES[tone];
  return (
    <div
      className={cls(
        "w-[230px] rounded-xl border bg-[#0d1424]/95 px-3 py-2 shadow-lg transition",
        selected ? "border-sky-400" : "border-slate-700",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md text-[12px]" style={{ background: `${def.accent}22`, color: def.accent }}>
          {def.glyph}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-slate-100">{node.label}</span>
        <span className={cls("h-1.5 w-1.5 rounded-full", palette.dot)} />
      </div>
      <div className="mt-1 text-[10px] uppercase tracking-wide" style={{ color: def.accent }}>
        {def.label}
      </div>
      {node._summary ? <div className="mono mt-1 truncate text-[10px] text-slate-500">{node._summary}</div> : null}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { wfNode: WorkflowNodeView };

function summarize(data: Record<string, unknown>): string {
  const type = String(data.nodeType ?? "");
  const pick = (key: string) => (data[key] === undefined || data[key] === "" ? "" : String(data[key]));
  switch (type) {
    case "dockerAction":
      return `${pick("action")} ${pick("target") || "(target)"}`;
    case "dockerRun":
      return `run ${pick("image")}`;
    case "dockerExec":
      return `${pick("target")}: ${pick("command")}`;
    case "dockerLogs":
      return `logs ${pick("target")}`;
    case "healthcheck":
      return pick("url");
    case "cli":
      return `${pick("binary")} ${pick("args")}`;
    case "http":
      return `${pick("method")} ${pick("url")}`;
    case "delay":
      return `${pick("seconds")}s`;
    case "condition":
      return pick("expression");
    case "notify":
      return pick("message");
    case "trigger":
      return pick("label");
    default:
      return "";
  }
}

function Editor({ workflow, onSaved }: { workflow: WorkflowGraphPayload; onSaved: () => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [name, setName] = useState(workflow.name);
  const [description, setDescription] = useState(workflow.description);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runPayload, setRunPayload] = useState("{}");
  const [notice, setNotice] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const run = useApi<{ run: RunPayload }>(runId ? `/api/runs/${runId}` : null, runId ? 1200 : 0);
  const runStatus = run.data?.run.status;
  const finished = runStatus === "success" || runStatus === "failed";

  useEffect(() => {
    setName(workflow.name);
    setDescription(workflow.description);
    setNodes(
      workflow.graph.nodes.map((node) => ({
        id: node.id,
        type: "wfNode",
        position: node.position,
        data: { ...node.data, _summary: summarize(node.data) },
      })),
    );
    setEdges(
      workflow.graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        labelBgStyle: { fill: "#0b1220" },
        labelStyle: { fill: "#94a3b8", fontSize: 10 },
        style: { stroke: "#334155" },
        animated: false,
      })),
    );
    setSelectedId(null);
    setRunId(null);
    setNotice(null);
  }, [workflow.id, workflow.graph, workflow.name, workflow.description, setNodes, setEdges]);

  useEffect(() => {
    if (!run.data?.run) return;
    const steps = new Map(run.data.run.steps.map((step) => [step.nodeId, step]));
    setNodes((current) =>
      current.map((node) => {
        const step = steps.get(node.id);
        return { ...node, data: { ...node.data, _status: step?.status ?? "pending" } };
      }),
    );
  }, [run.data, setNodes]);

  const selectedNode = nodes.find((node) => node.id === selectedId) ?? null;

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            id: `e-${connection.source}-${connection.target}-${Date.now().toString(36)}`,
            style: { stroke: "#334155" },
          },
          current,
        ),
      );
    },
    [setEdges],
  );

  const addNode = useCallback(
    (type: string, position?: { x: number; y: number }) => {
      const data = defaultDataFor(type);
      const id = `${type}_${Date.now().toString(36)}`;
      setNodes((current) => [
        ...current,
        {
          id,
          type: "wfNode",
          position: position ?? { x: 120 + current.length * 30, y: 80 + (current.length % 5) * 110 },
          data: { ...data, _summary: summarize(data) },
        },
      ]);
      setSelectedId(id);
    },
    [setNodes],
  );

  const updateSelected = (patch: Record<string, unknown>) => {
    if (!selectedId) return;
    setNodes((current) =>
      current.map((node) => {
        if (node.id !== selectedId) return node;
        const data = { ...node.data, ...patch };
        return { ...node, data: { ...data, _summary: summarize(data) } };
      }),
    );
  };

  const removeSelected = () => {
    if (!selectedId) return;
    setNodes((current) => current.filter((node) => node.id !== selectedId));
    setEdges((current) => current.filter((edge) => edge.source !== selectedId && edge.target !== selectedId));
    setSelectedId(null);
  };

  const save = async () => {
    setSaveState("saving…");
    try {
      await apiPut(`/api/workflows/${workflow.id}`, {
        name,
        description,
        graph: {
          nodes: nodes.map((node) => ({ id: node.id, type: "wfNode", position: node.position, data: strip(node.data) })),
          edges: edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, label: typeof edge.label === "string" ? edge.label : undefined })),
        },
      });
      setSaveState("saved");
      onSaved();
    } catch (error) {
      setSaveState(error instanceof Error ? error.message : "save failed");
    }
  };

  const startRun = async () => {
    setNotice(null);
    try {
      const payload = runPayload.trim() ? (JSON.parse(runPayload) as Record<string, unknown>) : {};
      const result = await apiPost<{ runId: string; stepCount: number }>(`/api/workflows/${workflow.id}/run`, { payload });
      setRunId(result.runId);
      setNotice(`run started with ${result.stepCount} steps`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "failed to start run");
    }
  };

  const cancel = async () => {
    if (!runId) return;
    await apiPost(`/api/runs/${runId}`, { action: "cancel" });
  };

  const runSteps = run.data?.run.steps ?? [];
  const def = selectedNode ? WORKFLOW_NODE_DEFS[String(selectedNode.data.nodeType)] ?? WORKFLOW_NODE_DEFS.cli : null;

  const memoNodes = useMemo(() => nodes, [nodes]);

  return (
    <div className="grid gap-3 xl:grid-cols-[240px_1fr_320px]">
      <div className="panel p-3">
        <div className="text-[11px] uppercase tracking-wide text-slate-500">step palette</div>
        <div className="mt-2 space-y-1.5">
          {WORKFLOW_PALETTE_ORDER.map((type) => {
            const nodeDef = WORKFLOW_NODE_DEFS[type];
            return (
              <button
                key={type}
                type="button"
                draggable
                onDragStart={() => (dragRef.current = type)}
                onClick={() => addNode(type)}
                className="flex w-full items-start gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5 text-left transition hover:border-sky-500/60"
              >
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[12px]" style={{ background: `${nodeDef.accent}22`, color: nodeDef.accent }}>
                  {nodeDef.glyph}
                </span>
                <span className="min-w-0">
                  <span className="block text-[11px] font-medium text-slate-200">{nodeDef.label}</span>
                  <span className="block truncate text-[10px] text-slate-500">{nodeDef.description}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-3 text-[10px] text-slate-500">drag into the canvas or click to append · connect handles to build the run order</div>
      </div>

      <div className="panel p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="min-w-[180px] flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-[12px] text-slate-100 outline-none focus:border-sky-500"
          />
          <button type="button" onClick={() => void save()} className="rounded-lg bg-sky-500 px-3 py-1.5 text-[11px] font-semibold text-slate-950">
            save
          </button>
          <input
            value={runPayload}
            onChange={(event) => setRunPayload(event.target.value)}
            placeholder='run vars {"container":"vega-api"}'
            className="mono w-56 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-sky-500"
          />
          <button type="button" onClick={() => void startRun()} className="rounded-lg bg-emerald-500 px-3 py-1.5 text-[11px] font-semibold text-slate-950">
            ▶ run
          </button>
          {runId && !finished ? (
            <button type="button" onClick={() => void cancel()} className="rounded-lg border border-rose-500/50 px-2.5 py-1.5 text-[11px] text-rose-300">
              cancel
            </button>
          ) : null}
          {saveState ? <span className="text-[11px] text-slate-400">{saveState}</span> : null}
        </div>
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="description"
          className="mt-2 w-full rounded-lg border border-slate-800 bg-slate-950/60 px-2.5 py-1.5 text-[11px] text-slate-300 outline-none focus:border-sky-600"
        />
        <div
          ref={wrapperRef}
          className="mt-2 h-[520px] overflow-hidden rounded-xl border border-slate-800"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const type = dragRef.current;
            if (!type || !wrapperRef.current) return;
            const bounds = wrapperRef.current.getBoundingClientRect();
            addNode(type, { x: event.clientX - bounds.left - 60, y: event.clientY - bounds.top - 30 });
            dragRef.current = null;
          }}
        >
          <ReactFlow
            nodes={memoNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            attributionPosition="top-left"
            style={{ background: "#070b14" }}
          >
            <Background variant={BackgroundVariant.Lines} gap={28} size={1} color="#131c2e" />
            <MiniMap style={{ background: "#0b1220", border: "1px solid #1e293b" }} pannable zoomable />
            <Controls showInteractive={false} style={{ background: "#0b1220", border: "1px solid #1e293b" }} />
          </ReactFlow>
        </div>
        {notice ? <div className="mt-2 text-[11px] text-sky-300">{notice}</div> : null}
      </div>

      <div className="space-y-3">
        <div className="panel p-3">
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">step settings</span>
            {selectedNode ? (
              <button type="button" onClick={removeSelected} className="ml-auto text-[10px] text-rose-400 hover:text-rose-300">
                delete step
              </button>
            ) : null}
          </div>
          {selectedNode && def ? (
            <div className="mt-2 space-y-2">
              <div className="flex items-center gap-2">
                <span className="grid h-6 w-6 place-items-center rounded-md text-[12px]" style={{ background: `${def.accent}22`, color: def.accent }}>
                  {def.glyph}
                </span>
                <span className="text-[12px] font-medium text-slate-200">{def.label}</span>
                <span className="mono ml-auto text-[10px] text-slate-500">{selectedNode.id}</span>
              </div>
              <p className="text-[10px] text-slate-500">{def.description}</p>
              <label className="block text-[10px] uppercase tracking-wide text-slate-500">
                label
                <input
                  value={String(selectedNode.data.label ?? "")}
                  onChange={(event) => updateSelected({ label: event.target.value })}
                  className="mt-0.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-100 outline-none focus:border-sky-500"
                />
              </label>
              {def.fields.map((field) => (
                <label key={field.key} className="block text-[10px] uppercase tracking-wide text-slate-500">
                  {field.label}
                  {field.type === "select" ? (
                    <select
                      value={String(selectedNode.data[field.key] ?? field.options?.[0] ?? "")}
                      onChange={(event) => updateSelected({ [field.key]: event.target.value })}
                      className="mt-0.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-100 outline-none focus:border-sky-500"
                    >
                      {(field.options ?? []).map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : field.type === "textarea" ? (
                    <textarea
                      value={String(selectedNode.data[field.key] ?? "")}
                      onChange={(event) => updateSelected({ [field.key]: event.target.value })}
                      placeholder={field.placeholder}
                      rows={2}
                      className="mt-0.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-100 outline-none focus:border-sky-500"
                    />
                  ) : (
                    <input
                      value={String(selectedNode.data[field.key] ?? "")}
                      onChange={(event) => updateSelected({ [field.key]: event.target.value })}
                      placeholder={field.placeholder}
                      className="mt-0.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-100 outline-none focus:border-sky-500"
                    />
                  )}
                </label>
              ))}
              <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5 text-[10px] text-slate-500">
                outputs: <span className="mono text-slate-400">{def.outputs.join(", ")}</span>
                <div className="mt-1">
                  reference them in later steps as <span className="mono text-slate-400">{`{{${selectedNode.id}.${def.outputs[0]}}}`}</span>
                </div>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-slate-500">select a step on the canvas to configure it.</p>
          )}
        </div>

        <div className="panel p-3">
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">run timeline</span>
            {run.data?.run ? (
              <span className={cls("chip ml-auto", (TONE_CLASSES[STATUS_TONE[run.data.run.status] ?? "idle"] ?? TONE_CLASSES.idle).border, (TONE_CLASSES[STATUS_TONE[run.data.run.status] ?? "idle"] ?? TONE_CLASSES.idle).text)}>
                {run.data.run.status}
              </span>
            ) : null}
          </div>
          {run.data?.run ? (
            <div className="mt-2 space-y-1.5">
              <div className="text-[10px] text-slate-500">
                started {timeAgo(run.data.run.startedAt)} · trigger {run.data.run.trigger}
                {run.data.run.durationMs ? ` · ${(run.data.run.durationMs / 1000).toFixed(1)}s` : ""}
              </div>
              {runSteps.map((step) => {
                const palette = TONE_CLASSES[STATUS_TONE[step.status] ?? "idle"] ?? TONE_CLASSES.idle;
                return (
                  <details key={`${step.nodeId}-${step.status}`} className="rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5">
                    <summary className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-300">
                      <span className={cls("h-1.5 w-1.5 rounded-full", palette.dot)} />
                      <span className="truncate">{step.label}</span>
                      <span className="mono ml-auto text-[10px] text-slate-500">{step.durationMs ? `${step.durationMs}ms` : step.status}</span>
                    </summary>
                    <pre className="terminal mt-1 max-h-40 overflow-auto rounded p-2">{step.output || "no output yet"}</pre>
                  </details>
                );
              })}
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-slate-500">
              run the workflow to see per-step status here. Steps annotated with <span className="mono">{"{{nodeId.field}}"}</span> templates resolve against previous
              outputs.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function strip(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("_")) continue;
    out[key] = value;
  }
  return out;
}

export default function WorkflowEditor({ workflow, onSaved }: { workflow: WorkflowGraphPayload; onSaved: () => void }) {
  return (
    <ReactFlowProvider>
      <Editor workflow={workflow} onSaved={onSaved} />
    </ReactFlowProvider>
  );
}
