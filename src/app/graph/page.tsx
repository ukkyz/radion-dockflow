"use client";

import { useCallback, useMemo, useState } from "react";
import MapCanvas, { type CanvasNode } from "@/components/MapCanvas";
import ContainerDetail from "@/components/ContainerDetail";
import { apiPost, cls, fmtMb, stateTone, TONE_CLASSES, useApi } from "@/lib/client";
import type { HierarchyNode, HierarchyPayload } from "@/lib/types";

const ACCENTS: Record<string, string> = {
  host: "#38bdf8",
  project: "#a855f7",
  service: "#22d3ee",
  container: "#0ea5e9",
  volume: "#f59e0b",
  network: "#14b8a6",
  image: "#6366f1",
};

function aggregate(node: HierarchyNode): CanvasNode["agg"] {
  const detail = (node.detail ?? {}) as Record<string, unknown>;
  switch (node.kind) {
    case "host":
      return [
        { label: "mode", value: String(detail.mode ?? "—"), tone: detail.mode === "live" ? "good" : "warn" },
        { label: "api", value: String(detail.apiVersion ?? "—"), tone: "info" },
        { label: "cpus", value: String(detail.cpus ?? "—"), tone: "idle" },
        { label: "ram", value: fmtMb(Number(detail.totalMemoryMb ?? 0)), tone: "idle" },
      ];
    case "project":
      return [
        { label: "containers", value: String(detail.containers ?? "—"), tone: "info" },
        { label: "running", value: String(detail.running ?? "—"), tone: "good" },
        ...(Number(detail.unhealthy ?? 0) > 0 ? [{ label: "unhealthy", value: String(detail.unhealthy), tone: "bad" as const }] : []),
      ];
    case "service":
      return [
        { label: "replicas", value: String(detail.replicas ?? "—"), tone: "info" },
        { label: "cpu", value: `${node.metrics?.cpu ?? 0}%`, tone: (node.metrics?.cpu ?? 0) > 60 ? "warn" : "good" },
        { label: "mem", value: fmtMb(node.metrics?.mem ?? 0), tone: "idle" },
      ];
    case "container":
      return [
        { label: "cpu", value: `${node.metrics?.cpu ?? 0}%`, tone: (node.metrics?.cpu ?? 0) > 60 ? "warn" : "good" },
        { label: "mem", value: fmtMb(node.metrics?.mem ?? 0), tone: "idle" },
        { label: "net", value: `${node.metrics?.net ?? 0} MB`, tone: "info" },
      ];
    case "image":
      return [
        { label: "size", value: `${detail.sizeMb ?? 0} MB`, tone: "idle" },
        { label: "used by", value: String(detail.containers ?? 0), tone: "info" },
      ];
    case "volume":
      return [
        { label: "driver", value: String(detail.driver ?? "local"), tone: "idle" },
        { label: "attached", value: String((detail.containers as string[] | undefined)?.length ?? 0), tone: "info" },
      ];
    case "network":
      return [
        { label: "driver", value: String(detail.driver ?? "bridge"), tone: "idle" },
        { label: "subnet", value: String(detail.subnet ?? "—"), tone: "info" },
      ];
    default:
      return [];
  }
}

export default function GraphPage() {
  const { data, error, loading, refresh } = useApi<HierarchyPayload>("/radion/api/docker/graph", 8000);
  const [selected, setSelected] = useState<HierarchyNode | null>(null);
  const [containerId, setContainerId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nodes: CanvasNode[] = useMemo(() => {
    if (!data) return [];
    return data.nodes.map((node) => ({
      id: node.id,
      title: node.label,
      subtitle: node.subtitle,
      kind: node.kind,
      parentId: node.parentId,
      status: node.kind === "container" ? (node.status === "up" ? "running" : node.status === "degraded" ? "restarting" : "exited") : node.status,
      health: (node.badge === "healthy" || node.badge === "unhealthy" || node.badge === "starting" ? node.badge : null) as string | null,
      badge: node.badge,
      accent: ACCENTS[node.kind],
      agg: aggregate(node),
      tone: node.status === "degraded" ? "alert" : node.status === "down" ? "muted" : "normal",
    }));
  }, [data]);

  const edges = useMemo(
    () =>
      (data?.edges ?? []).map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        tone: "idle" as const,
      })),
    [data],
  );

  const onSelect = useCallback(
    (node: CanvasNode | null) => {
      if (!node) {
        setSelected(null);
        return;
      }
      const match = data?.nodes.find((n) => n.id === node.id) ?? null;
      setSelected(match);
      if (match?.kind === "container" && match.detail?.containerId) setContainerId(String(match.detail.containerId));
    },
    [data],
  );

  const runAction = async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await apiPost<{ message: string }>(path, body);
      setNotice(result.message);
      await refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "action failed");
    } finally {
      setBusy(false);
    }
  };

  const detail = (selected?.detail ?? {}) as Record<string, unknown>;

  return (
    <div className="space-y-3">
      <div className="panel flex flex-wrap items-center gap-3 px-3 py-2.5">
        <div>
          <div className="text-sm font-semibold text-slate-100">Container hierarchy map</div>
          <div className="text-[11px] text-slate-500">
            Host → compose project → service → container → networks &amp; volumes. Every node can expand or collapse its children.
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 text-[11px]">
          {data ? (
            <>
              <span className={cls("chip", data.mode === "live" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-amber-500/40 bg-amber-500/10 text-amber-300")}>
                {data.mode === "live" ? `live engine · ${data.endpoint.address}` : "demo engine"}
              </span>
              <span className="chip text-slate-400">{data.nodes.length} nodes</span>
              <span className="chip text-slate-400">{data.edges.length} edges</span>
            </>
          ) : null}
          <button type="button" onClick={() => void refresh()} className="chip text-slate-300 hover:border-sky-500 hover:text-sky-300">
            {loading ? "loading…" : "refresh"}
          </button>
        </div>
      </div>

      {error ? <div className="panel border-rose-500/40 px-3 py-2 text-[12px] text-rose-300">{error}</div> : null}
      {notice ? <div className="panel border-sky-500/40 px-3 py-2 text-[12px] text-sky-300">{notice}</div> : null}

      <MapCanvas
        nodes={nodes}
        edges={edges}
        layout="tree"
        defaultExpandDepth={2}
        onSelect={onSelect}
        height="620px"
        legend={[
          { label: "running", tone: "#34d399" },
          { label: "restarting / paused", tone: "#fbbf24" },
          { label: "exited", tone: "#64748b" },
        ]}
      />

      {selected ? (
        <div className="fixed inset-y-0 right-0 z-30 flex w-full max-w-[520px] flex-col border-l border-slate-800 bg-[#0a1120]/98 p-4 shadow-2xl backdrop-blur">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={cls("h-2 w-2 rounded-full", (TONE_CLASSES[stateTone(selected.status)] ?? TONE_CLASSES.idle).dot)} />
                <span className="truncate text-sm font-semibold text-slate-100">{selected.label}</span>
                <span className="chip text-slate-400">{selected.kind}</span>
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">{selected.subtitle}</div>
            </div>
            <button type="button" onClick={() => setSelected(null)} className="rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-400 hover:border-rose-500 hover:text-rose-300">
              close
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
            {selected.kind === "container" && selected.detail?.containerId ? (
              <button type="button" className="chip border-sky-500/50 bg-sky-500/10 text-sky-300" onClick={() => setContainerId(String(selected.detail?.containerId))}>
                open logs / stats / exec
              </button>
            ) : null}
            {selected.kind === "project" && detail.project ? (
              <>
                <button type="button" disabled={busy} className="chip text-emerald-300" onClick={() => void runAction("/radion/api/docker/projects", { project: detail.project, action: "start" })}>
                  start all
                </button>
                <button type="button" disabled={busy} className="chip text-amber-300" onClick={() => void runAction("/radion/api/docker/projects", { project: detail.project, action: "restart" })}>
                  restart all
                </button>
                <button type="button" disabled={busy} className="chip text-rose-300" onClick={() => void runAction("/radion/api/docker/projects", { project: detail.project, action: "stop" })}>
                  stop all
                </button>
              </>
            ) : null}
            {selected.kind === "container" && detail.containerId ? (
              <>
                <button type="button" disabled={busy} className="chip text-amber-300" onClick={() => void runAction(`/radion/api/docker/containers/${detail.containerId}`, { action: "restart" })}>
                  restart
                </button>
                <button type="button" disabled={busy} className="chip text-rose-300" onClick={() => void runAction(`/radion/api/docker/containers/${detail.containerId}`, { action: "stop" })}>
                  stop
                </button>
              </>
            ) : null}
            {(selected.kind === "image" || selected.kind === "volume" || selected.kind === "network") && selected.id.includes(":") && !selected.id.startsWith("attach:") && !selected.id.startsWith("mount:") ? (
              <button
                type="button"
                disabled={busy}
                className="chip text-rose-300"
                onClick={() => {
                  const [, ...rest] = selected.id.split(":");
                  const target = rest.join(":");
                  if (selected.kind === "image") void runAction(`/api/docker/images?id=${encodeURIComponent(String(detail.imageId ?? target))}`, {});
                }}
              >
                inspect resource
              </button>
            ) : null}
          </div>

          <div className="mt-3 flex-1 space-y-2 overflow-auto">
            {Object.entries(detail).map(([key, value]) => (
              <div key={key} className="rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{key}</div>
                <div className="mono mt-0.5 whitespace-pre-wrap break-words text-[11px] text-slate-300">
                  {Array.isArray(value) ? value.join("\n") || "—" : value === null || value === undefined ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <ContainerDetail containerId={containerId} onClose={() => setContainerId(null)} />
    </div>
  );
}
