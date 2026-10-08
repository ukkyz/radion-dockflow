"use client";

import { useEffect, useState } from "react";
import WorkflowEditor, { type WorkflowGraphPayload } from "@/components/WorkflowEditor";
import { apiDelete, apiPost, cls, fmtMs, timeAgo, TONE_CLASSES, useApi } from "@/lib/client";
import { defaultDataFor } from "@/lib/workflow-defs";

interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  nodeCount: number;
  edgeCount: number;
  steps: { id: string; type: string; label: string }[];
}

interface RunSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
  steps: { label: string; status: string; output: string; durationMs?: number }[];
}

const STATUS_TONE: Record<string, keyof typeof TONE_CLASSES> = { success: "good", failed: "bad", running: "info", pending: "idle", skipped: "warn" };

export default function WorkflowsPage() {
  const workflows = useApi<{ workflows: WorkflowSummary[] }>("/radion/api/workflows", 15000);
  const runs = useApi<{ runs: RunSummary[] }>("/radion/api/runs?limit=12", 4000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);

  const detail = useApi<{ workflow: WorkflowGraphPayload }>(selectedId ? `/radion/api/workflows/${selectedId}` : null, 0);

  useEffect(() => {
    if (!selectedId && workflows.data?.workflows.length) setSelectedId(workflows.data.workflows[0].id);
  }, [workflows.data, selectedId]);

  const createWorkflow = async (cloneOf?: string) => {
    try {
      const graph = {
        nodes: [
          { id: "trigger_1", type: "wfNode", position: { x: 80, y: 160 }, data: { ...defaultDataFor("trigger") } },
          { id: "dockerAction_2", type: "wfNode", position: { x: 400, y: 100 }, data: { ...defaultDataFor("dockerAction"), target: "{{container}}", label: "restart target" } },
          { id: "healthcheck_3", type: "wfNode", position: { x: 720, y: 100 }, data: { ...defaultDataFor("healthcheck") } },
          { id: "notify_4", type: "wfNode", position: { x: 1040, y: 180 }, data: { ...defaultDataFor("notify") } },
        ],
        edges: [
          { id: "e1", source: "trigger_1", target: "dockerAction_2" },
          { id: "e2", source: "dockerAction_2", target: "healthcheck_3" },
          { id: "e3", source: "healthcheck_3", target: "notify_4" },
        ],
      };
      const result = await apiPost<{ workflow: { id: string } }>("/radion/api/workflows", cloneOf ? { cloneOf } : { name: "Untitled workflow", description: "Describe what this run should achieve.", graph });
      setNotice("workflow created");
      await workflows.refresh();
      setSelectedId(result.workflow.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "failed to create workflow");
    }
  };

  const removeWorkflow = async (id: string) => {
    try {
      await apiDelete(`/radion/api/workflows/${id}`);
      setNotice("workflow deleted");
      setSelectedId(null);
      await workflows.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "failed to delete workflow");
    }
  };

  return (
    <div className="space-y-3">
      <div className="panel flex flex-wrap items-center gap-2 px-3 py-2.5">
        <div>
          <div className="text-sm font-semibold text-slate-100">Workflow automation</div>
          <div className="text-[11px] text-slate-500">
            Chain Docker actions, container exec, CLI applications, HTTP calls and gates — every step runs server-side against the active engine.
          </div>
        </div>
        <div className="ml-auto flex gap-1.5 text-[11px]">
          <button type="button" onClick={() => void createWorkflow()} className="chip border-sky-500/50 bg-sky-500/10 text-sky-300">
            + new workflow
          </button>
          {selectedId ? (
            <>
              <button type="button" onClick={() => void createWorkflow(selectedId)} className="chip text-slate-300 hover:border-sky-500">
                clone
              </button>
              <button type="button" onClick={() => void removeWorkflow(selectedId)} className="chip text-rose-300 hover:border-rose-500">
                delete
              </button>
            </>
          ) : null}
        </div>
      </div>

      {notice ? <div className="panel border-sky-500/40 px-3 py-2 text-[12px] text-sky-300">{notice}</div> : null}

      <div className="grid gap-3 xl:grid-cols-[300px_1fr]">
        <div className="space-y-3">
          <div className="panel p-2">
            <div className="px-1.5 py-1 text-[11px] uppercase tracking-wide text-slate-500">workflows</div>
            <div className="space-y-1">
              {(workflows.data?.workflows ?? []).map((workflow) => (
                <button
                  key={workflow.id}
                  type="button"
                  onClick={() => setSelectedId(workflow.id)}
                  className={cls(
                    "w-full rounded-lg border px-2.5 py-2 text-left transition",
                    selectedId === workflow.id ? "border-sky-500/60 bg-sky-500/10" : "border-slate-800 bg-slate-950/40 hover:border-slate-600",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[12px] font-medium text-slate-200">{workflow.name}</span>
                    <span className="chip ml-auto text-slate-500">{workflow.nodeCount} steps</span>
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-slate-500">{workflow.description || "no description"}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {workflow.steps.slice(0, 5).map((step) => (
                      <span key={step.id} className="chip text-slate-500">
                        {step.label || step.type}
                      </span>
                    ))}
                  </div>
                  <div className="mt-1 text-[10px] text-slate-600">updated {timeAgo(workflow.updatedAt)}</div>
                </button>
              ))}
              {!workflows.data?.workflows.length ? <div className="px-2 py-4 text-center text-[11px] text-slate-500">{workflows.loading ? "loading…" : "no workflows yet"}</div> : null}
            </div>
          </div>

          <div className="panel p-2">
            <div className="px-1.5 py-1 text-[11px] uppercase tracking-wide text-slate-500">run history</div>
            <div className="space-y-1">
              {(runs.data?.runs ?? []).map((run) => {
                const palette = TONE_CLASSES[STATUS_TONE[run.status] ?? "idle"] ?? TONE_CLASSES.idle;
                const expanded = openRun === run.id;
                return (
                  <div key={run.id} className="rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5">
                    <button type="button" onClick={() => setOpenRun(expanded ? null : run.id)} className="flex w-full items-center gap-2 text-left text-[11px]">
                      <span className={cls("h-1.5 w-1.5 rounded-full", palette.dot)} />
                      <span className="truncate text-slate-200">{run.workflowName}</span>
                      <span className="ml-auto text-slate-500">{duration(run)}</span>
                      <span className="text-slate-600">{timeAgo(run.startedAt)}</span>
                    </button>
                    {expanded ? (
                      <div className="mt-1 space-y-0.5">
                        {run.steps.map((step) => {
                          const stepPalette = TONE_CLASSES[STATUS_TONE[step.status] ?? "idle"] ?? TONE_CLASSES.idle;
                          return (
                            <div key={`${run.id}-${step.label}`} className="flex items-center gap-2 text-[10px]">
                              <span className={cls("h-1 w-1 rounded-full", stepPalette.dot)} />
                              <span className="truncate text-slate-400">{step.label}</span>
                              <span className="ml-auto text-slate-600">{step.status}</span>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {!runs.data?.runs.length ? <div className="px-2 py-4 text-center text-[11px] text-slate-500">no runs recorded yet</div> : null}
            </div>
          </div>
        </div>

        <div>
          {detail.data?.workflow ? (
            <WorkflowEditor workflow={detail.data.workflow} onSaved={() => void workflows.refresh()} />
          ) : (
            <div className="panel grid h-[520px] place-items-center text-[12px] text-slate-500">{selectedId ? "loading workflow…" : "select or create a workflow"}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function duration(run: RunSummary): string {
  if (run.durationMs) return fmtMs(run.durationMs);
  return run.status === "running" ? "running" : "—";
}
