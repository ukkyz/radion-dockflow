"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import MapCanvas, { type CanvasNode } from "@/components/MapCanvas";
import ContainerDetail from "@/components/ContainerDetail";
import { apiPost, cls, fmtMs, stateTone, timeAgo, TONE_CLASSES, useApi } from "@/lib/client";
import type { ApmNode, ApmSpan, ApmTopology, ApmTrace } from "@/lib/types";

interface TracesPayload {
  mode: string;
  traces: ApmTrace[];
  full: ApmTrace[];
}

interface ServiceDetail {
  node: ApmNode | null;
  operations: { operation: string; calls: number; avgMs: number; errors: number; p95Ms: number }[];
  slowest: ApmSpan[];
  errors: { operation: string; message: string; count: number }[];
}

const KIND_ACCENT: Record<string, string> = {
  gateway: "#38bdf8",
  service: "#22d3ee",
  db: "#f59e0b",
  cache: "#f43f5e",
  queue: "#a855f7",
  external: "#64748b",
};

const TIERS: { id: string; label: string; kinds: string[]; accent: string }[] = [
  { id: "tier:edge", label: "edge tier", kinds: ["gateway", "external"], accent: "#38bdf8" },
  { id: "tier:app", label: "application tier", kinds: ["service"], accent: "#22d3ee" },
  { id: "tier:data", label: "data tier", kinds: ["db", "cache", "queue"], accent: "#f59e0b" },
];

function linkTone(errorRate: number): "good" | "warn" | "bad" | "idle" | "info" {
  if (errorRate > 5) return "bad";
  if (errorRate > 1) return "warn";
  if (errorRate > 0) return "info";
  return "good";
}

export default function ApmPage() {
  const [view, setView] = useState<"flow" | "hierarchy">("flow");
  const [liveTraffic, setLiveTraffic] = useState(false);
  const [service, setService] = useState<string | null>(null);
  const [containerId, setContainerId] = useState<string | null>(null);
  const [traceService, setTraceService] = useState("all");
  const [traceStatus, setTraceStatus] = useState("all");
  const [minDuration, setMinDuration] = useState("");
  const [expandedTrace, setExpandedTrace] = useState<string | null>(null);
  const [simNotice, setSimNotice] = useState<string | null>(null);

  const topology = useApi<ApmTopology>("/radion/api/apm/topology", 6000);
  const traces = useApi<TracesPayload>(
    `/radion/api/apm/traces?limit=30${traceService !== "all" ? `&service=${encodeURIComponent(traceService)}` : ""}${traceStatus !== "all" ? `&status=${traceStatus}` : ""}${minDuration ? `&minDurationMs=${minDuration}` : ""}`,
    7000,
  );
  const detail = useApi<ServiceDetail>(service ? `/radion/api/apm/services/${encodeURIComponent(service)}` : null, 6000);

  useEffect(() => {
    if (topology.data?.mode === "demo" && !liveTraffic) setLiveTraffic(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topology.data?.mode]);

  useEffect(() => {
    if (!liveTraffic) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const result = await apiPost<{ traces: number; spans: number }>("/radion/api/apm/simulate", { batch: 2 });
        if (!cancelled) setSimNotice(`+${result.traces} traces · ${result.spans} spans`);
      } catch (error) {
        if (!cancelled) setSimNotice(error instanceof Error ? error.message : "simulation failed");
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 6000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [liveTraffic]);

  const nodes: CanvasNode[] = useMemo(() => {
    const services = topology.data?.nodes ?? [];
    const out: CanvasNode[] = [];
    if (view === "hierarchy") {
      for (const tier of TIERS) {
        const members = services.filter((s) => tier.kinds.includes(s.kind));
        out.push({
          id: tier.id,
          title: `${tier.label}`,
          subtitle: `${members.length} services`,
          kind: "project",
          parentId: null,
          status: members.some((m) => m.status === "down") ? "degraded" : "up",
          accent: tier.accent,
          badge: `${members.reduce((sum, m) => sum + m.requests, 0)} spans`,
          agg: [
            { label: "err", value: `${(members.reduce((s, m) => s + m.errors, 0) / Math.max(1, members.reduce((s, m) => s + m.requests, 0)) * 100).toFixed(1)}%`, tone: "warn" },
            { label: "avg", value: fmtMs(members.reduce((s, m) => s + m.avgMs, 0) / Math.max(1, members.length)), tone: "info" },
          ],
        });
      }
    }
    for (const node of services) {
      const tier = TIERS.find((t) => t.kinds.includes(node.kind));
      const hasContainer = Boolean(node.containerId);
      out.push({
        id: node.key,
        title: node.name,
        subtitle: `${node.kind} · ${node.runtime}${node.project ? ` · ${node.project}` : ""}${node.replicas ? ` · ${node.replicas} replica(s)` : ""}`,
        kind: node.kind,
        parentId: view === "hierarchy" ? tier?.id ?? null : null,
        status: node.status === "up" ? "running" : node.status,
        accent: KIND_ACCENT[node.kind] ?? "#22d3ee",
        badge: `${node.requests} spans`,
        tone: node.status === "warn" ? "alert" : node.status === "down" ? "muted" : "normal",
        agg: [
          { label: "err", value: `${node.errorRate}%`, tone: node.errorRate > 5 ? "bad" : node.errorRate > 1 ? "warn" : "good" },
          { label: "avg", value: fmtMs(node.avgMs), tone: "info" },
          { label: "p95", value: fmtMs(node.p95Ms), tone: node.p95Ms > node.slaLatencyMs * 2 ? "warn" : "idle" },
          { label: "apdex", value: String(node.apdex), tone: node.apdex < 0.85 ? "warn" : "good" },
        ],
        metrics: { cpu: node.cpu, mem: node.mem, net: 0 },
        meta: hasContainer
          ? [`container ${node.containerName ?? node.containerId?.slice(0, 12)}`, `agent ${node.agent?.name ?? "none"} · ${timeAgo(node.agent?.lastHeartbeatAt)}`]
          : [`agent ${node.agent?.name ?? "none"}`],
      });
    }
    if (view === "hierarchy") {
      for (const node of services) {
        if (!node.containerId) continue;
        out.push({
          id: `pod:${node.key}`,
          title: node.containerName ?? node.key,
          subtitle: `container · ${node.mode === "live" ? "live" : "demo"} engine`,
          kind: "container",
          parentId: node.key,
          status: node.status === "up" ? "running" : "exited",
          accent: "#0ea5e9",
          badge: `${node.cpu.toFixed(1)}% cpu`,
          agg: [
            { label: "cpu", value: `${node.cpu}%`, tone: node.cpu > 60 ? "warn" : "good" },
            { label: "mem", value: `${node.mem} MB`, tone: "idle" },
          ],
          meta: [`project ${node.project ?? "standalone"}`],
        });
      }
    }
    return out;
  }, [topology.data, view]);

  const edges = useMemo(
    () =>
      (topology.data?.links ?? []).map((link) => ({
        id: link.id,
        source: link.source,
        target: link.target,
        label: `${link.calls} · ${fmtMs(link.avgMs)}${link.errors ? ` · ${link.errors} err` : ""}`,
        tone: linkTone(link.errorRate),
        animated: link.errorRate > 5,
        width: Math.min(4, 1 + link.calls / 40),
      })),
    [topology.data],
  );

  const onSelect = useCallback((node: CanvasNode | null) => {
    if (!node) {
      setService(null);
      return;
    }
    if (TIERS.some((t) => t.id === node.id)) return;
    setService(node.id.startsWith("pod:") ? node.id.slice(4) : node.id);
  }, []);

  const totals = topology.data?.totals;
  const timeseries = topology.data?.timeseries ?? [];
  const maxRequests = Math.max(1, ...timeseries.map((point) => point.requests));

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Metric label="services" value={String(totals?.services ?? 0)} hint={`${totals?.agents ?? 0} agents reporting`} />
        <Metric label="calls / min" value={String(totals?.callsPerMin ?? 0)} hint={`${totals?.tracesPerMin ?? 0} traces/min`} />
        <Metric label="error rate" value={`${totals?.errorRate ?? 0}%`} tone={(totals?.errorRate ?? 0) > 3 ? "bad" : "good"} hint="last 10 minutes" />
        <Metric label="p95 latency" value={fmtMs(totals?.p95Ms ?? 0)} tone={(totals?.p95Ms ?? 0) > 800 ? "warn" : "good"} hint={`avg ${fmtMs(totals?.avgMs ?? 0)}`} />
        <Metric label="apdex" value={String(totals?.apdex ?? 1)} tone={(totals?.apdex ?? 1) < 0.9 ? "warn" : "good"} hint="satisfied + tolerating/2" />
        <Metric label="unhealthy" value={String(totals?.unhealthy ?? 0)} tone={(totals?.unhealthy ?? 0) > 0 ? "bad" : "good"} hint="services needing attention" />
      </div>

      <div className="panel px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-100">Traffic · requests per minute</h2>
          <span className="text-[11px] text-slate-500">bars = spans/min, red overlay = errors, line = avg latency</span>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px]">
            <button
              type="button"
              onClick={() => setLiveTraffic((v) => !v)}
              className={cls("chip transition", liveTraffic ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300" : "text-slate-400 hover:border-emerald-500 hover:text-emerald-300")}
            >
              {liveTraffic ? "◉ demo traffic generator on" : "○ demo traffic generator off"}
            </button>
            {simNotice ? <span className="chip text-slate-500">{simNotice}</span> : null}
            <span className="chip text-slate-400">ingest: POST /radion/api/apm/ingest</span>
          </div>
        </div>
        <div className="mt-3 flex h-28 items-end gap-1">
          {timeseries.map((point) => {
            const height = (point.requests / maxRequests) * 100;
            const errorHeight = point.requests ? (point.errors / point.requests) * 100 : 0;
            return (
              <div key={point.ts} className="group relative flex h-full flex-1 flex-col justify-end" title={`${new Date(point.ts).toLocaleTimeString()} · ${point.requests} spans · ${point.errors} errors · avg ${point.avgMs}ms`}>
                <div className="w-full overflow-hidden rounded-t bg-sky-500/70" style={{ height: `${Math.max(2, height)}%` }}>
                  <div className="w-full bg-rose-500" style={{ height: `${errorHeight}%` }} />
                </div>
              </div>
            );
          })}
          {!timeseries.some((p) => p.requests) ? (
            <div className="flex h-full w-full items-center justify-center text-[11px] text-slate-500">
              no spans in the last 30 minutes — switch on the demo traffic generator or point an agent at /api/apm/ingest
            </div>
          ) : null}
        </div>
      </div>

      <div className="panel p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-100">Service map</h2>
          <span className="text-[11px] text-slate-500">
            {view === "flow" ? "pinpoint-style call graph — edges are real client/server span pairs" : "hierarchical map — tier → service → container, expandable"}
          </span>
          <div className="ml-auto flex gap-1 text-[11px]">
            {(["flow", "hierarchy"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setView(mode)}
                className={cls("rounded-lg px-2.5 py-1 transition", view === mode ? "bg-sky-500/15 text-sky-300" : "text-slate-400 hover:text-slate-200")}
              >
                {mode === "flow" ? "call flow" : "hierarchy"}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3">
          <MapCanvas
            nodes={nodes}
            edges={edges}
            layout={view === "flow" ? "layered" : "tree"}
            defaultExpandDepth={view === "flow" ? 0 : 1}
            onSelect={onSelect}
            height="600px"
            legend={[
              { label: "healthy edge", tone: "#34d399" },
              { label: "elevated errors", tone: "#fbbf24" },
              { label: "failing", tone: "#f43f5e" },
            ]}
          />
        </div>
      </div>

      <div className="panel p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-100">Distributed traces</h2>
          <span className="text-[11px] text-slate-500">last 10 minutes · click a trace for the pin-point waterfall</span>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-[11px]">
            <select value={traceService} onChange={(event) => setTraceService(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-slate-300">
              <option value="all">all services</option>
              {(topology.data?.nodes ?? []).map((node) => (
                <option key={node.key} value={node.key}>
                  {node.name}
                </option>
              ))}
            </select>
            <select value={traceStatus} onChange={(event) => setTraceStatus(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-slate-300">
              <option value="all">any status</option>
              <option value="error">errors only</option>
              <option value="ok">clean only</option>
            </select>
            <input
              value={minDuration}
              onChange={(event) => setMinDuration(event.target.value.replace(/[^0-9]/g, ""))}
              placeholder="min ms"
              className="w-20 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200 outline-none focus:border-sky-500"
            />
          </div>
        </div>

        <div className="mt-3 space-y-1.5">
          {(traces.data?.full ?? []).map((trace) => {
            const expanded = expandedTrace === trace.traceId;
            return (
              <div key={trace.traceId} className="rounded-lg border border-slate-800 bg-slate-950/40">
                <button type="button" onClick={() => setExpandedTrace(expanded ? null : trace.traceId)} className="flex w-full items-center gap-2 px-2.5 py-2 text-left">
                  <span className={cls("h-1.5 w-1.5 shrink-0 rounded-full", trace.status === "error" ? "bg-rose-500" : "bg-emerald-400")} />
                  <span className="text-[12px] font-medium text-slate-200">{trace.rootServiceName}</span>
                  <span className="mono max-w-[320px] truncate text-[11px] text-slate-500">{trace.operation}</span>
                  <span className="chip ml-auto text-slate-400">{trace.spanCount} spans</span>
                  {trace.errorCount ? <span className="chip border-rose-500/40 bg-rose-500/10 text-rose-300">{trace.errorCount} err</span> : null}
                  <span className="mono w-20 text-right text-[11px] text-slate-300">{fmtMs(trace.durationMs)}</span>
                  <span className="w-20 text-right text-[10px] text-slate-500">{timeAgo(trace.startTime)}</span>
                </button>
                {expanded ? <Waterfall trace={trace} onOpenContainer={(name) => setContainerId(name)} /> : null}
              </div>
            );
          })}
          {!traces.data?.full.length ? (
            <div className="py-6 text-center text-[12px] text-slate-500">
              no traces captured yet — turn on the demo traffic generator above, or POST spans to <span className="mono">/api/apm/ingest</span>
            </div>
          ) : null}
        </div>
      </div>

      {service && detail.data ? (
        <div className="fixed inset-y-0 right-0 z-30 flex w-full max-w-[520px] flex-col border-l border-slate-800 bg-[#0a1120]/98 p-4 shadow-2xl backdrop-blur">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={cls("h-2 w-2 rounded-full", (TONE_CLASSES[stateTone(detail.data.node?.status === "up" ? "running" : detail.data.node?.status)] ?? TONE_CLASSES.idle).dot)} />
                <span className="text-sm font-semibold text-slate-100">{detail.data.node?.name ?? service}</span>
                <span className="chip text-slate-400">{detail.data.node?.kind ?? "service"}</span>
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">
                {detail.data.node?.runtime} · team {detail.data.node?.team} · SLA {detail.data.node?.slaLatencyMs}ms / {detail.data.node?.slaErrorPct}%
              </div>
            </div>
            <button type="button" onClick={() => setService(null)} className="rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-400 hover:border-rose-500 hover:text-rose-300">
              close
            </button>
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
            <Mini label="requests" value={String(detail.data.node?.requests ?? 0)} />
            <Mini label="error rate" value={`${detail.data.node?.errorRate ?? 0}%`} tone={(detail.data.node?.errorRate ?? 0) > 3 ? "bad" : "good"} />
            <Mini label="p95" value={fmtMs(detail.data.node?.p95Ms ?? 0)} />
            <Mini label="avg" value={fmtMs(detail.data.node?.avgMs ?? 0)} />
            <Mini label="apdex" value={String(detail.data.node?.apdex ?? 1)} />
            <Mini label="callers" value={`${detail.data.node?.incoming ?? 0} in / ${detail.data.node?.outgoing ?? 0} out`} />
          </div>

          {detail.data.node?.containerId ? (
            <button
              type="button"
              onClick={() => setContainerId(detail.data?.node?.containerId ?? null)}
              className="mt-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-2.5 py-1.5 text-left text-[11px] text-sky-300"
            >
              container {detail.data.node.containerName ?? detail.data.node.containerId.slice(0, 12)} · open logs / stats / exec
            </button>
          ) : null}

          <div className="mt-3 flex-1 space-y-3 overflow-auto">
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">operations</div>
              <div className="space-y-1">
                {detail.data.operations.map((operation) => (
                  <div key={operation.operation} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5 text-[11px]">
                    <span className="mono min-w-0 flex-1 truncate text-slate-300">{operation.operation}</span>
                    <span className="mono text-slate-500">{operation.calls} calls</span>
                    <span className="mono text-slate-400">avg {fmtMs(operation.avgMs)}</span>
                    <span className="mono text-slate-400">p95 {fmtMs(operation.p95Ms)}</span>
                    {operation.errors ? <span className="chip border-rose-500/40 text-rose-300">{operation.errors}</span> : null}
                  </div>
                ))}
                {!detail.data.operations.length ? <div className="text-[11px] text-slate-500">no spans in the current window</div> : null}
              </div>
            </div>

            {detail.data.errors.length ? (
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">error signatures</div>
                <div className="space-y-1">
                  {detail.data.errors.map((error) => (
                    <div key={error.message} className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-2 py-1.5 text-[11px]">
                      <div className="mono text-rose-300">{error.message}</div>
                      <div className="text-slate-500">
                        {error.operation} · {error.count}×
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">slowest spans</div>
              <div className="space-y-1">
                {detail.data.slowest.map((span) => (
                  <div key={span.spanId} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5 text-[11px]">
                    <span className={cls("h-1.5 w-1.5 rounded-full", span.status === "error" ? "bg-rose-500" : "bg-emerald-400")} />
                    <span className="mono min-w-0 flex-1 truncate text-slate-300">{span.operation}</span>
                    <span className="mono text-slate-400">{fmtMs(span.durationMs)}</span>
                    <span className="text-slate-600">{span.kind}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <ContainerDetail containerId={containerId} onClose={() => setContainerId(null)} />
    </div>
  );
}

function Waterfall({ trace, onOpenContainer }: { trace: ApmTrace; onOpenContainer: (id: string) => void }) {
  const start = Math.min(...trace.spans.map((span) => new Date(span.startTime).getTime()));
  const total = Math.max(1, trace.durationMs);
  const depthOf = (span: ApmSpan): number => {
    let depth = 0;
    let current = span;
    while (current.parentSpanId) {
      const parent = trace.spans.find((s) => s.spanId === current.parentSpanId);
      if (!parent) break;
      depth += 1;
      current = parent;
      if (depth > 8) break;
    }
    return depth;
  };

  return (
    <div className="scroll-fade max-h-[360px] overflow-auto border-t border-slate-800 px-2.5 py-2">
      <div className="mb-1 flex items-center gap-2 text-[10px] text-slate-500">
        <span className="mono">{trace.traceId}</span>
        <span>· started {new Date(trace.startTime).toLocaleTimeString()}</span>
      </div>
      <div className="space-y-1">
        {trace.spans.map((span) => {
          const offset = ((new Date(span.startTime).getTime() - start) / total) * 100;
          const width = Math.max(0.6, (span.durationMs / total) * 100);
          const depth = depthOf(span);
          return (
            <div key={span.spanId} className="flex items-center gap-2">
              <span className="flex w-64 shrink-0 items-center gap-1 truncate text-[11px]" style={{ paddingLeft: depth * 12 }}>
                <span className={cls("h-1.5 w-1.5 shrink-0 rounded-full", span.status === "error" ? "bg-rose-500" : "bg-emerald-400")} />
                <span className="truncate text-slate-300">{span.serviceName}</span>
                <span className="mono truncate text-[10px] text-slate-500">{span.operation}</span>
              </span>
              <span className="relative h-3 flex-1 rounded bg-slate-900/80">
                <span
                  className={cls("absolute top-0 h-3 rounded", span.kind === "client" ? "bg-sky-500/70" : span.status === "error" ? "bg-rose-500/80" : "bg-emerald-500/70")}
                  style={{ left: `${Math.min(99, offset)}%`, width: `${Math.min(100 - offset, width)}%` }}
                  title={`${span.serviceName} · ${span.operation} · ${fmtMs(span.durationMs)}`}
                />
              </span>
              <span className="mono w-16 shrink-0 text-right text-[10px] text-slate-400">{fmtMs(span.durationMs)}</span>
            </div>
          );
        })}
      </div>
      {trace.spans.some((span) => span.errorMessage) ? (
        <div className="mt-2 space-y-1">
          {trace.spans
            .filter((span) => span.errorMessage)
            .map((span) => (
              <div key={`${span.spanId}-err`} className="mono rounded border border-rose-500/30 bg-rose-500/5 px-2 py-1 text-[10px] text-rose-300">
                {span.serviceName}: {span.errorMessage}
              </div>
            ))}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => onOpenContainer(trace.spans[0]?.serviceName ?? "")}
        className="mt-2 text-[10px] text-sky-400 hover:text-sky-300"
      >
        inspect root service container →
      </button>
    </div>
  );
}

function Metric({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "warn" | "bad" }) {
  const palette = TONE_CLASSES[tone ?? "info"];
  return (
    <div className="panel px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cls("mono mt-0.5 text-lg font-semibold", tone ? palette.text : "text-slate-100")}>{value}</div>
      {hint ? <div className="text-[10px] text-slate-500">{hint}</div> : null}
    </div>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  const palette = TONE_CLASSES[tone ?? "info"];
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cls("mono text-[12px]", tone ? palette.text : "text-slate-200")}>{value}</div>
    </div>
  );
}
