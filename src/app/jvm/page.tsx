"use client";

import { useEffect, useMemo, useState } from "react";
import MapCanvas, { type CanvasNode } from "@/components/MapCanvas";
import { AreaChart, DonutGauge, StackedBar, StatTile } from "@/components/Charts";
import { apiDelete, apiPost, cls, fmtMb, fmtMs, timeAgo, TONE_CLASSES, useApi } from "@/lib/client";
import type {
  JvmDeadlock,
  JvmDumpSummary,
  JvmMBean,
  JvmMethodNode,
  JvmProfile,
  JvmSnapshot,
  JvmTarget,
  JvmThread,
  JvmThreadResponse,
} from "@/lib/types";

interface TargetsPayload {
  targets: JvmTarget[];
  counts: { total: number; online: number; offline: number; simulated: number; discovered: number };
  hint: string;
}

const TABS = ["monitor", "visual-gc", "threads", "sampler", "mbeans", "dumps", "anatomy"] as const;
type Tab = (typeof TABS)[number];

const KIND_ACCENT: Record<string, string> = {
  jolokia: "#a855f7",
  actuator: "#22c55e",
  simulated: "#38bdf8",
};

const STATE_TONE: Record<string, string> = {
  RUNNABLE: "good",
  RUNNING: "good",
  WAITING: "warn",
  TIMED_WAITING: "info",
  BLOCKED: "bad",
  NEW: "idle",
  TERMINATED: "idle",
};

const REGION_COLORS: Record<string, string> = {
  eden: "#38bdf8",
  survivor: "#a855f7",
  old: "#f59e0b",
  metaspace: "#14b8a6",
  class: "#6366f1",
  code: "#f472b6",
};

function regionColor(name: string): string {
  if (/eden/i.test(name)) return REGION_COLORS.eden;
  if (/survivor/i.test(name)) return REGION_COLORS.survivor;
  if (/old gen|tenured/i.test(name)) return REGION_COLORS.old;
  if (/metaspace/i.test(name)) return REGION_COLORS.metaspace;
  if (/class/i.test(name)) return REGION_COLORS.class;
  if (/code/i.test(name)) return REGION_COLORS.code;
  return "#64748b";
}

export default function JvmPage() {
  const targets = useApi<TargetsPayload>("/api/jvm/targets", 15_000);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("monitor");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", kind: "jolokia", url: "http://127.0.0.1:8778/jolokia" });
  const [showAdd, setShowAdd] = useState(false);
  const [threadFilter, setThreadFilter] = useState("all");
  const [threadSearch, setThreadSearch] = useState("");
  const [selectedThread, setSelectedThread] = useState<JvmThread | null>(null);
  const [selectedMBean, setSelectedMBean] = useState<string | null>(null);
  const [openDump, setOpenDump] = useState<{ id: string; content: string; name: string } | null>(null);
  const [profileOn, setProfileOn] = useState(false);

  useEffect(() => {
    if (!targetId && targets.data?.targets.length) setTargetId(targets.data.targets[0].id);
  }, [targets.data, targetId]);

  const offline = targets.data?.targets.find((t) => t.id === targetId)?.status === "offline";
  const snapshot = useApi<JvmSnapshot>(targetId && !offline ? `/api/jvm/${encodeURIComponent(targetId)}/snapshot` : null, tab === "monitor" || tab === "anatomy" ? 3000 : tab === "visual-gc" ? 2500 : 6000);
  const threads = useApi<JvmThreadResponse>(targetId && !offline && (tab === "threads" || tab === "sampler") ? `/api/jvm/${encodeURIComponent(targetId)}/threads` : null, tab === "threads" ? 5000 : 0);
  const profile = useApi<JvmProfile>(targetId && !offline && tab === "sampler" ? `/api/jvm/${encodeURIComponent(targetId)}/profile` : null, profileOn ? 1200 : 0);
  const mbeans = useApi<{ target: JvmTarget; domains: { domain: string; mbeans: string[] }[]; attributes: JvmMBean["attributes"]; selected: string | null; operations: JvmMBean["operations"] }>(
    targetId && !offline && tab === "mbeans" ? `/api/jvm/${encodeURIComponent(targetId)}/mbeans${selectedMBean ? `?mbean=${encodeURIComponent(selectedMBean)}` : ""}` : null,
    tab === "mbeans" ? 6000 : 0,
  );
  const dumps = useApi<{ dumps: JvmDumpSummary[] }>(targetId && tab === "dumps" ? `/api/jvm/${encodeURIComponent(targetId)}/dumps` : null, tab === "dumps" ? 8000 : 0);

  useEffect(() => {
    if (!profile.data) return;
    setProfileOn(profile.data.status === "running");
  }, [profile.data]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setNotice(null);
    try {
      const result = await fn();
      if (result && typeof result === "object" && "message" in result) setNotice(String((result as { message: string }).message));
      await Promise.all([snapshot.refresh(), targets.refresh()]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "action failed");
    } finally {
      setBusy(null);
    }
  };

  const startProfile = async () => {
    if (!targetId) return;
    try {
      await apiPost(`/api/jvm/${encodeURIComponent(targetId)}/profile`, { action: "start", durationMs: 12_000 });
      setProfileOn(true);
      setNotice("sampling session started");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "failed to start sampling");
    }
  };

  const stopProfile = async () => {
    if (!targetId) return;
    await apiPost(`/api/jvm/${encodeURIComponent(targetId)}/profile`, { action: "stop" });
    setProfileOn(false);
    await profile.refresh();
  };

  const saveProfile = async () => {
    if (!targetId) return;
    try {
      await apiPost(`/api/jvm/${encodeURIComponent(targetId)}/profile`, { action: "save" });
      setNotice("profile snapshot saved to dumps");
      await dumps.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "nothing to save yet");
    }
  };

  const captureDump = async (kind: "thread" | "heap") => {
    if (!targetId) return;
    setBusy(`dump-${kind}`);
    setNotice(null);
    try {
      const result = await apiPost<{ dump: JvmDumpSummary }>(`/api/jvm/${encodeURIComponent(targetId)}/dumps`, { kind });
      setNotice(`${kind} dump captured (${result.dump.sizeKb} KB)`);
      await dumps.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "capture failed");
    } finally {
      setBusy(null);
    }
  };

  const filteredThreads = useMemo(() => {
    const list = threads.data?.threads ?? [];
    return list.filter((thread) => {
      if (threadFilter !== "all" && thread.state !== threadFilter) return false;
      if (!threadSearch) return true;
      const haystack = `${thread.name} ${thread.frames[0]?.className ?? ""} ${thread.frames[0]?.methodName ?? ""}`.toLowerCase();
      return haystack.includes(threadSearch.toLowerCase());
    });
  }, [threads.data, threadFilter, threadSearch]);

  const anatomyNodes = useMemo<CanvasNode[]>(() => {
    const snap = snapshot.data;
    if (!snap) return [];
    const heapSegments = snap.memory.pools.filter((entry) => entry.type === "heap");
    const nonHeap = snap.memory.pools.filter((entry) => entry.type === "nonheap");
    const nodes: CanvasNode[] = [
      {
        id: "jvm",
        title: `${snap.jvm.name}`,
        subtitle: `${snap.jvm.version} · ${snap.jvm.vendor}`,
        kind: "host",
        parentId: null,
        status: "running",
        accent: KIND_ACCENT[snap.target.kind],
        badge: `up ${Math.floor(snap.jvm.uptimeMs / 3_600_000)}h`,
        agg: [
          { label: "pid", value: String(snap.jvm.pid), tone: "info" },
          { label: "heap", value: `${snap.memory.heap.usedMb.toFixed(0)}/${snap.memory.heap.maxMb.toFixed(0)} MB`, tone: snap.memory.heap.usagePct > 85 ? "warn" : "good" },
          { label: "cpu", value: `${snap.cpu.processLoad}%`, tone: snap.cpu.processLoad > 75 ? "warn" : "good" },
          { label: "threads", value: String(snap.threads.live), tone: "info" },
        ],
      },
      {
        id: "memory",
        title: "Memory",
        subtitle: "heap + non-heap areas",
        kind: "project",
        parentId: "jvm",
        status: "up",
        accent: "#0ea5e9",
        agg: [
          { label: "heap", value: `${snap.memory.heap.usagePct}%`, tone: snap.memory.heap.usagePct > 85 ? "warn" : "good" },
          { label: "non-heap", value: `${snap.memory.nonHeap.usedMb.toFixed(0)} MB`, tone: "idle" },
        ],
      },
      { id: "heap", title: "Heap", subtitle: `${snap.memory.heap.committedMb.toFixed(0)} MB committed · ${snap.memory.heap.maxMb.toFixed(0)} MB max`, kind: "service", parentId: "memory", status: "up", accent: "#0284c7", metrics: { cpu: snap.memory.heap.usagePct, mem: snap.memory.heap.usedMb, net: 0 }, badge: `${snap.memory.heap.usedMb.toFixed(0)} MB` },
      ...heapSegments.map((entry) => ({
        id: `pool:heap:${entry.name}`,
        title: entry.name,
        subtitle: `${entry.usedMb} / ${entry.maxMb} MB`,
        kind: "volume",
        parentId: "heap",
        status: "up",
        accent: regionColor(entry.name),
        metrics: { cpu: entry.usagePct, mem: entry.usedMb, net: 0 },
        badge: `${entry.usagePct}%`,
      })),
      { id: "nonheap", title: "Non-heap", subtitle: `${snap.memory.nonHeap.usedMb.toFixed(0)} MB used`, kind: "service", parentId: "memory", status: "up", accent: "#14b8a6", badge: `${snap.memory.nonHeap.usagePct}%` },
      ...nonHeap.map((entry) => ({
        id: `pool:nonheap:${entry.name}`,
        title: entry.name,
        subtitle: `${entry.usedMb} / ${entry.maxMb} MB`,
        kind: "image",
        parentId: "nonheap",
        status: "up",
        accent: regionColor(entry.name),
        metrics: { cpu: entry.usagePct, mem: entry.usedMb, net: 0 },
        badge: `${entry.usagePct}%`,
      })),
      {
        id: "gc",
        title: "Garbage collection",
        subtitle: `${snap.gc.totalCount} collections · ${(snap.gc.totalTimeMs / 1000).toFixed(1)} s`,
        kind: "service",
        parentId: "jvm",
        status: snap.gc.avgPauseMs > 300 ? "degraded" : "up",
        accent: "#f59e0b",
        badge: `${snap.gc.avgPauseMs} ms avg`,
        agg: [
          { label: "young", value: String(snap.gc.youngCount), tone: "info" },
          { label: "old", value: String(snap.gc.oldCount), tone: snap.gc.oldCount > 20 ? "warn" : "idle" },
        ],
      },
      ...snap.gc.collectors.map((collector) => ({
        id: `gc:${collector.name}`,
        title: collector.name,
        subtitle: `${collector.count} runs · ${(collector.timeMs / 1000).toFixed(1)} s total`,
        kind: "container",
        parentId: "gc",
        status: "up",
        accent: "#d97706",
        agg: [
          { label: "avg", value: `${collector.avgPauseMs} ms`, tone: collector.avgPauseMs > 300 ? "warn" : "good" },
          { label: "pools", value: collector.poolNames.join(", ") || "—", tone: "idle" },
        ],
      })),
      {
        id: "threads",
        title: "Threads",
        subtitle: `${snap.threads.live} live · ${snap.threads.peak} peak`,
        kind: "service",
        parentId: "jvm",
        status: snap.threads.deadlocked ? "degraded" : "up",
        accent: "#a855f7",
        badge: `${snap.threads.blocked} blocked`,
        agg: [
          { label: "daemon", value: String(snap.threads.daemon), tone: "idle" },
          { label: "started", value: String(snap.threads.started), tone: "info" },
          { label: "waiting", value: String(snap.threads.waiting), tone: "warn" },
        ],
      },
      {
        id: "classes",
        title: "Classes",
        subtitle: `${snap.classes.loaded} loaded · ${snap.classes.unloaded} unloaded`,
        kind: "service",
        parentId: "jvm",
        status: "up",
        accent: "#6366f1",
        badge: `${snap.classes.total} total`,
      },
      {
        id: "cpu",
        title: "CPU",
        subtitle: `${snap.cpu.processLoad}% process · ${snap.cpu.systemLoad}% system`,
        kind: "service",
        parentId: "jvm",
        status: snap.cpu.processLoad > 80 ? "degraded" : "up",
        accent: "#22c55e",
        badge: `${snap.cpu.availableProcessors} cpus`,
        agg: [
          { label: "load1m", value: String(snap.cpu.loadAverage), tone: "idle" },
          { label: "cpu time", value: `${(snap.cpu.processCpuTimeMs / 60000).toFixed(1)} min`, tone: "info" },
        ],
      },
    ];
    if (threads.data) {
      const pools = new Map<string, JvmThread[]>();
      for (const thread of threads.data.threads) pools.set(thread.pool, [...(pools.get(thread.pool) ?? []), thread]);
      for (const [poolName, members] of pools) {
        nodes.push({
          id: `pool:threads:${poolName}`,
          title: poolName,
          subtitle: `${members.length} threads`,
          kind: "project",
          parentId: "threads",
          status: members.some((member) => member.state === "BLOCKED") ? "degraded" : "up",
          accent: "#7c3aed",
          badge: `${members.filter((member) => member.state === "RUNNABLE").length} runnable`,
          agg: [
            { label: "blocked", value: String(members.filter((member) => member.state === "BLOCKED").length), tone: "warn" },
            { label: "daemon", value: String(members.filter((member) => member.daemon).length), tone: "idle" },
          ],
        });
        for (const member of members.slice(0, 14)) {
          nodes.push({
            id: `thread:${member.id}`,
            title: member.name,
            subtitle: `${member.frames[0]?.className ?? ""}.${member.frames[0]?.methodName ?? ""}`,
            kind: "container",
            parentId: `pool:threads:${poolName}`,
            status: member.state === "RUNNABLE" ? "running" : member.state === "BLOCKED" ? "restarting" : "paused",
            accent: "#8b5cf6",
            badge: member.state,
            agg: [
              { label: "cpu", value: fmtMs(member.cpuMs), tone: "info" },
              { label: "waits", value: String(member.waitedCount), tone: "idle" },
            ],
          });
        }
      }
    }
    return nodes;
  }, [snapshot.data, threads.data]);

  const callTreeNodes = useMemo<CanvasNode[]>(() => {
    const tree = profile.data?.callTree;
    if (!tree) return [];
    const nodes: CanvasNode[] = [];
    const walk = (node: JvmMethodNode, parentId: string | null) => {
      nodes.push({
        id: node.id,
        title: `${node.methodName}`,
        subtitle: node.className,
        kind: node.depth === 0 ? "host" : "service",
        parentId,
        status: node.selfPct > 25 ? "running" : "up",
        accent: node.selfPct > 20 ? "#f59e0b" : node.selfPct > 8 ? "#38bdf8" : "#64748b",
        metrics: { cpu: node.totalPct, mem: node.selfPct, net: 0 },
        badge: `self ${node.selfPct}%`,
        agg: [
          { label: "self", value: `${node.selfPct}%`, tone: node.selfPct > 20 ? "warn" : "good" },
          { label: "total", value: `${node.totalPct}%`, tone: "info" },
          { label: "samples", value: String(node.samples), tone: "idle" },
        ],
      });
      for (const child of node.children) walk(child, node.id);
    };
    walk(tree, null);
    return nodes;
  }, [profile.data]);

  const selectedTarget = targets.data?.targets.find((t) => t.id === targetId) ?? null;

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile label="jvm targets" value={String(targets.data?.counts.total ?? 0)} hint={`${targets.data?.counts.discovered ?? 0} discovered on the engine`} />
        <StatTile label="online (JMX/actuator)" value={String(targets.data?.counts.online ?? 0)} tone={(targets.data?.counts.online ?? 0) > 0 ? "good" : "idle"} hint={`${targets.data?.counts.offline ?? 0} offline`} />
        <StatTile label="heap used" value={snapshot.data ? `${snapshot.data.memory.heap.usedMb.toFixed(0)} / ${snapshot.data.memory.heap.maxMb.toFixed(0)} MB` : "—"} tone={snapshot.data && snapshot.data.memory.heap.usagePct > 85 ? "warn" : "good"} hint={snapshot.data ? `${snapshot.data.memory.heap.usagePct}% of max` : ""} />
        <StatTile label="gc collections" value={snapshot.data ? String(snapshot.data.gc.totalCount) : "—"} hint={snapshot.data ? `${(snapshot.data.gc.totalTimeMs / 1000).toFixed(1)} s total · ${snapshot.data.gc.avgPauseMs} ms avg` : ""} />
        <StatTile label="threads / classes" value={snapshot.data ? `${snapshot.data.threads.live} / ${snapshot.data.classes.loaded}` : "—"} hint={snapshot.data && snapshot.data.threads.deadlocked ? `${snapshot.data.threads.deadlocked} deadlocked` : "no deadlocks detected"} tone={snapshot.data?.threads.deadlocked ? "bad" : "good"} />
      </div>

      <div className="grid gap-3 xl:grid-cols-[300px_1fr]">
        <div className="space-y-3">
          <div className="panel p-2">
            <div className="flex items-center gap-2 px-1.5 py-1">
              <span className="text-[11px] uppercase tracking-wide text-slate-500">java processes</span>
              <button type="button" onClick={() => setShowAdd((v) => !v)} className="ml-auto chip border-sky-500/50 bg-sky-500/10 text-sky-300">
                + attach JMX
              </button>
            </div>
            {showAdd ? (
              <div className="space-y-1.5 rounded-lg border border-slate-800 bg-slate-950/50 p-2">
                <select
                  value={form.kind}
                  onChange={(event) => {
                    const kind = event.target.value;
                    setForm({
                      kind,
                      name: "",
                      url: kind === "jolokia" ? "http://127.0.0.1:8778/jolokia" : kind === "actuator" ? "http://127.0.0.1:8080/actuator" : "",
                    });
                  }}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-200"
                >
                  <option value="jolokia">jolokia (JMX over HTTP)</option>
                  <option value="actuator">spring boot actuator</option>
                  <option value="simulated">simulated JVM</option>
                </select>
                <input value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="display name" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-sky-500" />
                {form.kind !== "simulated" ? (
                  <input value={form.url} onChange={(event) => setForm((prev) => ({ ...prev, url: event.target.value }))} placeholder="http://host:8778/jolokia" className="mono w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-sky-500" />
                ) : null}
                <button
                  type="button"
                  className="w-full rounded-lg bg-sky-500 px-2 py-1.5 text-[11px] font-semibold text-slate-950"
                  onClick={() =>
                    void run("attach", async () => {
                      await apiPost("/api/jvm/targets", form);
                      setShowAdd(false);
                      setNotice(`attached ${form.name || form.url}`);
                    })
                  }
                >
                  {busy === "attach" ? "connecting…" : "attach + probe"}
                </button>
              </div>
            ) : null}
            <div className="mt-1 space-y-1">
              {(targets.data?.targets ?? []).map((target) => {
                const palette = TONE_CLASSES[target.status === "online" ? "good" : target.status === "offline" ? "bad" : "info"];
                return (
                  <div key={target.id} className={cls("rounded-lg border px-2 py-1.5 transition", targetId === target.id ? "border-sky-500/60 bg-sky-500/10" : "border-slate-800 bg-slate-950/40 hover:border-slate-600")}>
                    <button type="button" onClick={() => { setTargetId(target.id); setSelectedThread(null); setSelectedMBean(null); }} className="w-full text-left">
                      <div className="flex items-center gap-2">
                        <span className={cls("h-1.5 w-1.5 rounded-full", palette.dot)} />
                        <span className="truncate text-[11px] font-medium text-slate-200">{target.name}</span>
                        <span className={cls("chip ml-auto", palette.border, palette.text)}>{target.kind}</span>
                      </div>
                      <div className="mono mt-0.5 truncate text-[10px] text-slate-500">{target.url || target.app}{target.project ? ` · ${target.project}` : ""}</div>
                      {target.jvmVersion ? <div className="truncate text-[10px] text-slate-500">java {target.jvmVersion}</div> : null}
                      {target.lastError ? <div className="truncate text-[10px] text-amber-400/80">{target.lastError}</div> : null}
                    </button>
                    {!target.autoDiscovered ? (
                      <button
                        type="button"
                        onClick={() => void run("remove", async () => {
                          await apiDelete(`/api/jvm/targets?id=${encodeURIComponent(target.id)}`);
                          if (targetId === target.id) setTargetId(null);
                          setNotice(`removed ${target.name}`);
                        })}
                        className="mt-1 text-[10px] text-rose-400 hover:text-rose-300"
                      >
                        remove
                      </button>
                    ) : (
                      <div className="mt-0.5 text-[10px] text-slate-600">discovered from the docker engine · simulated model</div>
                    )}
                  </div>
                );
              })}
              {!targets.data?.targets.length ? <div className="px-2 py-4 text-center text-[11px] text-slate-500">{targets.loading ? "loading…" : "no JVM targets"}</div> : null}
            </div>
          </div>

          <div className="panel p-3 text-[11px] leading-relaxed text-slate-500">
            <div className="text-[11px] uppercase tracking-wide text-slate-500">how to attach a real JVM</div>
            <p className="mt-2">
              <span className="text-slate-300">Jolokia (full JMX):</span> run the target with{" "}
              <span className="mono text-slate-400">-javaagent:jolokia-jvm.jar=port=8778,host=0.0.0.0</span> and attach{" "}
              <span className="mono text-slate-400">http://host:8778/jolokia</span>. This gives memory pools, GC counters, threads, mbeans and operations.
            </p>
            <p className="mt-2">
              <span className="text-slate-300">Actuator (no agent):</span> expose <span className="mono text-slate-400">management.endpoints.web.exposure.include=health,info,metrics,threaddump,heapdump</span> and attach{" "}
              <span className="mono text-slate-400">http://host:8080/actuator</span>. Prometheus-style metrics + real thread dumps + heap dump download.
            </p>
            <p className="mt-2">This page mirrors java vm: monitor charts, visual GC, thread inspector with deadlock detection, sampler with a call tree, mbean browser and dump capture.</p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="panel p-3">
            {snapshot.data ? (
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-[240px] flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-100">{snapshot.data.target.name}</span>
                    <span className="chip text-slate-400">{snapshot.data.target.kind}</span>
                    {snapshot.data.target.status !== "online" ? <span className="chip border-amber-500/40 bg-amber-500/10 text-amber-300">simulated</span> : null}
                    <span className="chip text-slate-400">java {snapshot.data.jvm.version}</span>
                    <span className="chip text-slate-400">{snapshot.data.jvm.vendor}</span>
                  </div>
                  <div className="mono mt-1 text-[10px] text-slate-500">
                    pid {snapshot.data.jvm.pid}@{snapshot.data.jvm.hostname} · {snapshot.data.jvm.name} · {snapshot.data.jvm.cpus} cpus · gc {snapshot.data.jvm.gcCollector}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
                    <Info label="uptime" value={formatUptime(snapshot.data.jvm.uptimeMs)} />
                    <Info label="heap" value={`${snapshot.data.memory.heap.usedMb.toFixed(0)} MB / ${snapshot.data.memory.heap.maxMb.toFixed(0)} MB`} />
                    <Info label="threads" value={`${snapshot.data.threads.live} live`} />
                    <Info label="gc pause avg" value={`${snapshot.data.gc.avgPauseMs} ms`} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                    <button type="button" disabled={busy !== null} onClick={() => void run("gc", async () => apiPost(`/api/jvm/${encodeURIComponent(targetId!)}/operation`, { operation: "gc" }))} className="chip text-amber-300 hover:border-amber-500">
                      {busy === "gc" ? "…" : "run gc"}
                    </button>
                    <button type="button" disabled={busy !== null} onClick={() => void run("resetPeakThreads", async () => apiPost(`/api/jvm/${encodeURIComponent(targetId!)}/operation`, { operation: "resetPeakThreads" }))} className="chip text-sky-300 hover:border-sky-500">
                      reset peak threads
                    </button>
                    <button type="button" disabled={busy !== null} onClick={() => void captureDump("thread")} className="chip text-slate-300 hover:border-sky-500">
                      {busy === "dump-thread" ? "…" : "thread dump"}
                    </button>
                    <button type="button" disabled={busy !== null} onClick={() => void captureDump("heap")} className="chip text-rose-300 hover:border-rose-500">
                      {busy === "dump-heap" ? "…" : "heap dump"}
                    </button>
                    <button type="button" onClick={() => void snapshot.refresh()} className="chip text-slate-400 hover:border-sky-500">
                      refresh
                    </button>
                    {targetId ? <a href={`/api/jvm/${encodeURIComponent(targetId)}/snapshot`} target="_blank" rel="noreferrer" className="chip text-slate-500 hover:text-sky-300">raw snapshot ↗</a> : null}
                  </div>
                </div>
                <DonutGauge value={snapshot.data.memory.heap.usagePct} label="heap used" color={snapshot.data.memory.heap.usagePct > 85 ? "#f43f5e" : "#38bdf8"} />
                <DonutGauge value={snapshot.data.cpu.processLoad} label="process cpu" color={snapshot.data.cpu.processLoad > 80 ? "#f59e0b" : "#22c55e"} />
              </div>
            ) : (
              <div className="py-6 text-center text-[12px] text-slate-500">
                {targets.loading ? "loading targets…" : offline ? "target offline — check the endpoint or protocol" : "select a JVM target"}
              </div>
            )}
            {notice ? <div className="mt-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-2.5 py-1.5 text-[11px] text-sky-300">{notice}</div> : null}
            {snapshot.error ? <div className="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/5 px-2.5 py-1.5 text-[11px] text-rose-300">{snapshot.error}</div> : null}
          </div>

          <div className="flex flex-wrap gap-1 border-b border-slate-800 pb-1 text-[11px]">
            {TABS.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setTab(item)}
                className={cls("rounded-lg px-2.5 py-1 transition", tab === item ? "bg-sky-500/15 text-sky-300" : "text-slate-400 hover:text-slate-200")}
              >
                {item === "visual-gc" ? "visual GC" : item}
              </button>
            ))}
          </div>

          {tab === "monitor" && snapshot.data ? (
            <div className="grid gap-3 lg:grid-cols-2">
              <Chart title="Heap & non-heap memory" sub="MB over the sampling window">
                <AreaChart
                  series={[
                    { label: "heap used", color: "#38bdf8", points: snapshot.data.history.map((point) => point.heapUsedMb), fill: true },
                    { label: "heap committed", color: "#0ea5e9", points: snapshot.data.history.map((point) => point.heapCommittedMb) },
                    { label: "non-heap", color: "#14b8a6", points: snapshot.data.history.map((point) => point.nonHeapMb) },
                  ]}
                  formatValue={(value) => `${value.toFixed(0)} MB`}
                  bands={[{ value: snapshot.data.memory.heap.maxMb, label: "max heap", color: "#f43f5e" }]}
                />
              </Chart>
              <Chart title="Heap generations" sub="eden / survivor / old gen (MB)">
                <AreaChart
                  series={[
                    { label: "eden", color: "#38bdf8", points: snapshot.data.history.map((point) => point.edenMb), fill: true },
                    { label: "survivor", color: "#a855f7", points: snapshot.data.history.map((point) => point.survivorMb) },
                    { label: "old gen", color: "#f59e0b", points: snapshot.data.history.map((point) => point.oldMb) },
                  ]}
                  formatValue={(value) => `${value.toFixed(0)} MB`}
                />
              </Chart>
              <Chart title="Threads" sub="live thread count">
                <AreaChart
                  series={[{ label: "live", color: "#a855f7", points: snapshot.data.history.map((point) => point.threadsLive), fill: true }]}
                  bands={[{ value: snapshot.data.threads.peak, label: "peak", color: "#64748b" }]}
                  formatValue={(value) => value.toFixed(0)}
                />
              </Chart>
              <Chart title="CPU & classes" sub="process cpu % and loaded classes">
                <AreaChart
                  series={[
                    { label: "process cpu", color: "#22c55e", points: snapshot.data.history.map((point) => point.cpuProcess), fill: true },
                    { label: "loaded classes (÷100)", color: "#6366f1", points: snapshot.data.history.map((point) => point.classesLoaded / 100) },
                  ]}
                  max={100}
                  formatValue={(value) => value.toFixed(1)}
                />
              </Chart>
              <Chart title="GC activity" sub="cumulative collections and pause time">
                <AreaChart
                  series={[
                    { label: "collections", color: "#f59e0b", points: snapshot.data.history.map((point) => point.gcCount), fill: true },
                    { label: "pause seconds", color: "#f43f5e", points: snapshot.data.history.map((point) => point.gcTimeMs / 1000) },
                  ]}
                  formatValue={(value) => value.toFixed(0)}
                />
              </Chart>
              <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                <div className="text-[11px] uppercase tracking-wide text-slate-500">runtime</div>
                <div className="mt-2 space-y-1 text-[11px]">
                  <Info label="vm" value={snapshot.data.jvm.name} full />
                  <Info label="version" value={`${snapshot.data.jvm.version} (spec ${snapshot.data.jvm.specVersion})`} full />
                  <Info label="vendor" value={snapshot.data.jvm.vendor} full />
                  <Info label="os" value={`${snapshot.data.jvm.osName} ${snapshot.data.jvm.osArch}`} full />
                  <Info label="started" value={new Date(snapshot.data.jvm.startTime).toLocaleString()} full />
                  <Info label="cpu time" value={`${(snapshot.data.cpu.processCpuTimeMs / 60000).toFixed(1)} min`} full />
                  {snapshot.data.jvm.args.length ? <Info label="jvm args" value={snapshot.data.jvm.args.join(" ")} full mono /> : null}
                  {snapshot.data.jvm.classPath ? <Info label="classpath" value={snapshot.data.jvm.classPath} full mono /> : null}
                </div>
                {snapshot.data.buffers.length ? (
                  <div className="mt-2">
                    <div className="text-[10px] uppercase tracking-wide text-slate-500">nio buffers</div>
                    <div className="mt-1 space-y-0.5 text-[11px]">
                      {snapshot.data.buffers.map((buffer) => (
                        <div key={buffer.name} className="flex gap-2">
                          <span className="w-16 shrink-0 text-slate-500">{buffer.name}</span>
                          <span className="mono text-slate-300">
                            {buffer.usedMb} / {buffer.capacityMb} MB · {buffer.count} buffers
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {tab === "visual-gc" && snapshot.data ? (
            <div className="space-y-3">
              <div className="panel p-3">
                <div className="text-[11px] uppercase tracking-wide text-slate-500">heap regions</div>
                <div className="mt-2">
                  <StackedBar
                    total={snapshot.data.memory.heap.maxMb}
                    segments={[
                      ...snapshot.data.memory.pools
                        .filter((entry) => entry.type === "heap")
                        .map((entry) => ({ label: entry.name, value: entry.usedMb, color: regionColor(entry.name) })),
                      { label: "free", value: Math.max(0, snapshot.data.memory.heap.maxMb - snapshot.data.memory.heap.usedMb), color: "#1e293b" },
                    ]}
                  />
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {snapshot.data.memory.pools.map((entry) => (
                    <div key={entry.name} className="rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-2">
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full" style={{ background: regionColor(entry.name) }} />
                        <span className="truncate text-[11px] text-slate-300">{entry.name}</span>
                        <span className="chip ml-auto text-slate-400">{entry.type}</span>
                      </div>
                      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-800">
                        <div className="h-full rounded-full" style={{ width: `${Math.min(100, entry.usagePct)}%`, background: regionColor(entry.name) }} />
                      </div>
                      <div className="mono mt-1 text-[10px] text-slate-500">
                        {entry.usedMb} used · {entry.committedMb} committed · {entry.maxMb} max ({entry.usagePct}%)
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-[1.1fr_1fr]">
                <div className="panel p-3">
                  <div className="text-[11px] uppercase tracking-wide text-slate-500">gc events (pause timeline)</div>
                  <div className="mt-2 space-y-1">
                    {snapshot.data.gcEvents.slice(0, 14).map((event, index) => {
                      const tone = event.kind === "young" ? "#38bdf8" : event.kind === "meta" ? "#14b8a6" : "#f59e0b";
                      return (
                        <div key={`${event.at}-${index}`} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5 text-[11px]">
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone }} />
                          <span className="truncate text-slate-300">{event.cause}</span>
                          <span className="chip text-slate-500">{event.kind}</span>
                          <span className="mono ml-auto text-slate-400">{event.pauseMs} ms</span>
                          <span className="mono w-16 text-right text-emerald-300/80">-{event.reclaimedMb} MB</span>
                          <span className="w-16 text-right text-[10px] text-slate-600">{new Date(event.at).toLocaleTimeString()}</span>
                        </div>
                      );
                    })}
                    {!snapshot.data.gcEvents.length ? <div className="py-4 text-center text-[11px] text-slate-500">no GC events captured yet — keep this tab open for a few seconds</div> : null}
                  </div>
                </div>
                <div className="panel p-3">
                  <div className="text-[11px] uppercase tracking-wide text-slate-500">collectors</div>
                  <div className="mt-2 space-y-2">
                    {snapshot.data.gc.collectors.map((collector) => (
                      <div key={collector.name} className="rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-slate-200">{collector.name}</span>
                          <span className="chip ml-auto text-slate-400">{collector.count} runs</span>
                        </div>
                        <div className="mono mt-1 text-[10px] text-slate-500">
                          total {(collector.timeMs / 1000).toFixed(2)} s · avg pause {collector.avgPauseMs} ms · pools {collector.poolNames.join(", ") || "—"}
                        </div>
                      </div>
                    ))}
                    <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-2 text-[11px] text-slate-400">
                      overhead: <span className="mono text-slate-200">{((snapshot.data.gc.totalTimeMs / Math.max(1, snapshot.data.jvm.uptimeMs)) * 100).toFixed(3)}%</span> of uptime · last event{" "}
                      <span className="text-slate-300">{snapshot.data.gc.lastEvent?.cause ?? "—"}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {tab === "threads" ? (
            <div className="space-y-3">
              {threads.data?.deadlocks.length ? (
                <div className="panel border-rose-500/40 bg-rose-500/[0.06] p-3">
                  <div className="flex items-center gap-2">
                    <span className="chip border-rose-500/50 bg-rose-500/10 text-rose-300">deadlock detected</span>
                    <span className="text-[11px] text-rose-200/90">{threads.data.deadlocks.length} cycle(s) in the wait-for graph</span>
                  </div>
                  {threads.data.deadlocks.map((deadlock: JvmDeadlock, index) => (
                    <div key={index} className="mt-2 rounded-lg border border-rose-500/30 bg-slate-950/60 p-2">
                      <div className="text-[11px] text-rose-200">{deadlock.description}</div>
                      <div className="mt-1 space-y-0.5 text-[10px]">
                        {deadlock.threads.map((member) => (
                          <div key={member.id} className="mono flex flex-wrap gap-2 text-slate-400">
                            <span className="text-slate-200">{member.name}</span>
                            <span>{member.state}</span>
                            <span className="text-amber-300">holds {member.holds}</span>
                            <span className="text-rose-300">waits for {member.waitsFor}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="panel p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] uppercase tracking-wide text-slate-500">thread inspector</span>
                  <div className="ml-auto flex flex-wrap items-center gap-1 text-[10px]">
                    {["all", "RUNNABLE", "WAITING", "TIMED_WAITING", "BLOCKED"].map((state) => (
                      <button
                        key={state}
                        type="button"
                        onClick={() => setThreadFilter(state)}
                        className={cls("rounded-lg px-2 py-1 transition", threadFilter === state ? "bg-sky-500/15 text-sky-300" : "text-slate-400 hover:text-slate-200")}
                      >
                        {state === "all" ? `all ${threads.data?.summary.total ?? 0}` : `${state} ${state === "RUNNABLE" ? threads.data?.summary.runnable ?? 0 : state === "BLOCKED" ? threads.data?.summary.blocked ?? 0 : state === "WAITING" ? threads.data?.summary.waiting ?? 0 : threads.data?.summary.timedWaiting ?? 0}`}
                      </button>
                    ))}
                    <input
                      value={threadSearch}
                      onChange={(event) => setThreadSearch(event.target.value)}
                      placeholder="filter name / frame"
                      className="w-40 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[10px] text-slate-200 outline-none focus:border-sky-500"
                    />
                    <button type="button" onClick={() => void threads.refresh()} className="chip text-slate-400 hover:border-sky-500">
                      refresh
                    </button>
                  </div>
                </div>
                <div className="mt-2 max-h-[300px] overflow-auto rounded-lg border border-slate-800">
                  <table className="w-full border-collapse text-[11px]">
                    <thead className="sticky top-0 bg-slate-900/90 text-left text-[10px] uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-2 py-1.5">thread</th>
                        <th className="px-2 py-1.5">state</th>
                        <th className="px-2 py-1.5">top frame</th>
                        <th className="px-2 py-1.5">cpu</th>
                        <th className="px-2 py-1.5">blocked</th>
                        <th className="px-2 py-1.5">waits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredThreads.map((thread) => {
                        const tone = STATE_TONE[thread.state] ?? "idle";
                        const palette = TONE_CLASSES[tone] ?? TONE_CLASSES.idle;
                        return (
                          <tr
                            key={thread.id}
                            onClick={() => setSelectedThread(thread)}
                            className={cls("cursor-pointer border-t border-slate-800/70 hover:bg-slate-800/30", selectedThread?.id === thread.id ? "bg-sky-500/10" : "")}
                          >
                            <td className="px-2 py-1.5">
                              <div className="flex items-center gap-1.5">
                                <span className={cls("h-1.5 w-1.5 rounded-full", palette.dot)} />
                                <span className="truncate text-slate-200">{thread.name}</span>
                                {thread.daemon ? <span className="chip text-slate-500">daemon</span> : null}
                              </div>
                            </td>
                            <td className={cls("px-2 py-1.5", palette.text)}>{thread.state}</td>
                            <td className="mono max-w-[280px] truncate px-2 py-1.5 text-slate-400">
                              {thread.frames[0] ? `${thread.frames[0].className}.${thread.frames[0].methodName}` : "—"}
                            </td>
                            <td className="mono px-2 py-1.5 text-slate-400">{fmtMs(thread.cpuMs)}</td>
                            <td className="mono px-2 py-1.5 text-slate-400">{thread.blockedCount}</td>
                            <td className="mono px-2 py-1.5 text-slate-400">{thread.waitedCount}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {selectedThread ? (
                  <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/50 p-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[12px] font-medium text-slate-200">{selectedThread.name}</span>
                      <span className="chip text-slate-400">{selectedThread.state}</span>
                      <span className="chip text-slate-500">prio {selectedThread.priority}</span>
                      <span className="chip text-slate-500">id {selectedThread.id}</span>
                      {selectedThread.daemon ? <span className="chip text-slate-500">daemon</span> : null}
                      {selectedThread.lockName ? <span className="chip border-amber-500/40 text-amber-300">holds {selectedThread.lockName}</span> : null}
                      {selectedThread.waitsOn ? <span className="chip border-rose-500/40 text-rose-300">{selectedThread.lockOwnerName ? `waiting for ${selectedThread.lockOwnerName}` : "waiting for lock"}</span> : null}
                    </div>
                    <pre className="terminal mt-2 max-h-64 overflow-auto rounded-lg p-2.5">
                      {selectedThread.frames.map((frame, index) => `\tat ${frame.className}.${frame.methodName}(${frame.fileName ?? "Unknown Source"}${frame.line !== undefined ? `:${frame.line}` : ""})`).join("\n") || "no stack trace"}
                    </pre>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {tab === "sampler" && targetId ? (
            <div className="space-y-3">
              <div className="panel p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] uppercase tracking-wide text-slate-500">cpu sampler (statistical thread-stack sampling)</span>
                  <div className="ml-auto flex flex-wrap gap-1.5 text-[11px]">
                    <button type="button" onClick={() => void startProfile()} disabled={profile.data?.status === "running"} className="chip border-emerald-500/50 bg-emerald-500/10 text-emerald-300 disabled:opacity-40">
                      ▶ start sampling
                    </button>
                    <button type="button" onClick={() => void stopProfile()} disabled={profile.data?.status !== "running"} className="chip text-amber-300 hover:border-amber-500 disabled:opacity-40">
                      ■ stop
                    </button>
                    <button type="button" onClick={() => void saveProfile()} className="chip text-slate-300 hover:border-sky-500">
                      save snapshot
                    </button>
                    <span className="chip text-slate-500">
                      {profile.data?.status ?? "idle"} · {profile.data?.samples ?? 0} samples · {profile.data?.intervalMs ?? 0} ms interval
                    </span>
                  </div>
                </div>
                {profile.data?.note ? <div className="mt-2 text-[10px] text-amber-300/80">{profile.data.note}</div> : null}
                {profile.data?.error ? <div className="mt-2 text-[10px] text-rose-300">{profile.data.error}</div> : null}

                <div className="mt-3 grid gap-3 lg:grid-cols-[1.1fr_1fr]">
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-500">hot methods (self time)</div>
                    <div className="mt-1.5 max-h-[320px] overflow-auto rounded-lg border border-slate-800">
                      <table className="w-full border-collapse text-[11px]">
                        <thead className="sticky top-0 bg-slate-900/90 text-left text-[10px] uppercase tracking-wide text-slate-500">
                          <tr>
                            <th className="px-2 py-1.5">method</th>
                            <th className="px-2 py-1.5">self</th>
                            <th className="px-2 py-1.5">self ms</th>
                            <th className="px-2 py-1.5">samples</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(profile.data?.hotMethods ?? []).map((method) => (
                            <tr key={`${method.className}.${method.methodName}`} className="border-t border-slate-800/70">
                              <td className="px-2 py-1.5">
                                <div className="truncate text-slate-200">{method.methodName}</div>
                                <div className="mono truncate text-[10px] text-slate-500">{method.className}</div>
                              </td>
                              <td className="px-2 py-1.5">
                                <div className="flex items-center gap-1.5">
                                  <span className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-800">
                                    <span className="block h-full rounded-full bg-sky-400" style={{ width: `${Math.min(100, method.selfPct * 2.5)}%` }} />
                                  </span>
                                  <span className="mono text-slate-300">{method.selfPct}%</span>
                                </div>
                              </td>
                              <td className="mono px-2 py-1.5 text-slate-400">{method.selfMs}</td>
                              <td className="mono px-2 py-1.5 text-slate-400">{method.samples}</td>
                            </tr>
                          ))}
                          {!profile.data?.hotMethods.length ? (
                            <tr>
                              <td colSpan={4} className="px-2 py-5 text-center text-slate-500">
                                start a sampling session to collect hot methods
                              </td>
                            </tr>
                          ) : null}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wide text-slate-500">allocation profile</div>
                    <div className="mt-1.5 space-y-1">
                      {(profile.data?.allocations ?? []).map((allocation) => (
                        <div key={allocation.className} className="rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5 text-[11px]">
                          <div className="flex items-center gap-2">
                            <span className="mono truncate text-slate-300">{allocation.className}</span>
                            <span className="mono ml-auto text-slate-400">{allocation.bytesMb} MB</span>
                          </div>
                          <div className="mt-1 flex items-center gap-2">
                            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                              <span className="block h-full rounded-full bg-purple-400" style={{ width: `${allocation.pct}%` }} />
                            </span>
                            <span className="mono text-[10px] text-slate-500">{allocation.instances.toLocaleString()} instances · {allocation.pct}%</span>
                          </div>
                        </div>
                      ))}
                      {!profile.data?.allocations.length ? (
                        <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-4 text-center text-[11px] text-slate-500">
                          allocation sampling appears once a session is running
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>

              <div className="panel p-3">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] uppercase tracking-wide text-slate-500">call tree (sampled stacks, expandable)</span>
                  <span className="text-[10px] text-slate-600">bar = total time share, badge = self time</span>
                </div>
                <div className="mt-2">
                  {callTreeNodes.length ? (
                    <MapCanvas
                      nodes={callTreeNodes}
                      edges={callTreeNodes.filter((node) => node.parentId).map((node) => ({ id: `e:${node.parentId}->${node.id}`, source: node.parentId as string, target: node.id, tone: "info" as const }))}
                      layout="tree"
                      defaultExpandDepth={2}
                      height="460px"
                      legend={[
                        { label: "hot (>20% self)", tone: "#f59e0b" },
                        { label: "warm", tone: "#38bdf8" },
                        { label: "cold", tone: "#64748b" },
                      ]}
                    />
                  ) : (
                    <div className="grid h-[200px] place-items-center text-[11px] text-slate-500">no call tree yet — run a sampling session</div>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          {tab === "mbeans" && targetId ? (
            <div className="grid gap-3 lg:grid-cols-[300px_1fr]">
              <div className="panel p-3">
                <div className="text-[11px] uppercase tracking-wide text-slate-500">mbean tree</div>
                <div className="mt-2 max-h-[440px] space-y-2 overflow-auto">
                  {(mbeans.data?.domains ?? []).map((domain) => (
                    <div key={domain.domain}>
                      <div className="text-[10px] uppercase tracking-wide text-slate-500">{domain.domain}</div>
                      <div className="mt-0.5 space-y-0.5">
                        {domain.mbeans.map((mbean) => (
                          <button
                            key={mbean}
                            type="button"
                            onClick={() => setSelectedMBean(mbean)}
                            className={cls("mono block w-full truncate rounded px-1.5 py-1 text-left text-[10px]", selectedMBean === mbean ? "bg-sky-500/15 text-sky-300" : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200")}
                          >
                            {mbean}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {!mbeans.data?.domains.length ? <div className="py-4 text-center text-[11px] text-slate-500">{mbeans.loading ? "loading…" : "no domains returned"}</div> : null}
                </div>
              </div>
              <div className="panel p-3">
                <div className="text-[11px] uppercase tracking-wide text-slate-500">attributes</div>
                {selectedMBean ? (
                  <>
                    <div className="mono mt-1 text-[11px] text-sky-300">{selectedMBean}</div>
                    <div className="mt-2 max-h-[330px] overflow-auto rounded-lg border border-slate-800">
                      <table className="w-full border-collapse text-[11px]">
                        <tbody>
                          {(mbeans.data?.attributes ?? []).map((attribute) => (
                            <tr key={attribute.name} className="border-t border-slate-800/70">
                              <td className="mono w-64 px-2 py-1.5 text-slate-400">{attribute.name}</td>
                              <td className="w-20 px-2 py-1.5 text-slate-600">{attribute.type}</td>
                              <td className="mono px-2 py-1.5 text-slate-200">{attribute.value}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {mbeans.data?.operations.length ? (
                      <div className="mt-3">
                        <div className="text-[10px] uppercase tracking-wide text-slate-500">operations</div>
                        <div className="mt-1 space-y-1">
                          {mbeans.data.operations.map((operation) => (
                            <div key={operation.name} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5 text-[11px]">
                              <span className="mono text-slate-200">{operation.name}</span>
                              <span className="truncate text-[10px] text-slate-500">{operation.description}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="mt-3 grid h-[300px] place-items-center text-[11px] text-slate-500">select an mbean to read its attributes</div>
                )}
              </div>
            </div>
          ) : null}

          {tab === "dumps" && targetId ? (
            <div className="panel p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide text-slate-500">captured dumps &amp; snapshots</span>
                <div className="ml-auto flex gap-1.5 text-[11px]">
                  <button type="button" disabled={busy !== null} onClick={() => void captureDump("thread")} className="chip text-slate-300 hover:border-sky-500">
                    capture thread dump
                  </button>
                  <button type="button" disabled={busy !== null} onClick={() => void captureDump("heap")} className="chip text-rose-300 hover:border-rose-500">
                    capture heap dump
                  </button>
                  <button type="button" onClick={() => void dumps.refresh()} className="chip text-slate-400 hover:border-sky-500">
                    refresh
                  </button>
                </div>
              </div>
              <div className="mt-2 space-y-1">
                {(dumps.data?.dumps ?? []).map((dump) => (
                  <div key={dump.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-1.5 text-[11px]">
                    <span className={cls("chip", dump.kind === "heap" ? "border-rose-500/40 text-rose-300" : dump.kind === "profile" ? "border-purple-500/40 text-purple-300" : "border-sky-500/40 text-sky-300")}>{dump.kind}</span>
                    <span className="text-slate-300">{dump.targetName}</span>
                    <span className="mono text-slate-500">{dump.sizeKb} KB</span>
                    <span className="truncate text-[10px] text-slate-500">
                      {Object.entries(dump.summary)
                        .slice(0, 3)
                        .map(([key, value]) => `${key}=${Array.isArray(value) ? value.length : String(value).slice(0, 40)}`)
                        .join(" · ")}
                    </span>
                    <span className="ml-auto text-[10px] text-slate-600">{timeAgo(dump.createdAt)}</span>
                    <button
                      type="button"
                      onClick={async () => {
                        const res = await fetch(`/api/jvm/dumps/${dump.id}`, { cache: "no-store" });
                        const json = (await res.json()) as { data?: { content: string } };
                        setOpenDump({ id: dump.id, content: json.data?.content ?? "no content", name: `${dump.kind} · ${dump.targetName}` });
                      }}
                      className="chip text-slate-300 hover:border-sky-500"
                    >
                      view
                    </button>
                    <button
                      type="button"
                      onClick={() => void run("delete-dump", async () => {
                        await apiDelete(`/api/jvm/dumps/${dump.id}`);
                        await dumps.refresh();
                        if (openDump?.id === dump.id) setOpenDump(null);
                      })}
                      className="chip text-rose-400 hover:border-rose-500"
                    >
                      delete
                    </button>
                  </div>
                ))}
                {!dumps.data?.dumps.length ? <div className="py-6 text-center text-[11px] text-slate-500">no dumps yet — capture a thread or heap dump</div> : null}
              </div>
              {openDump ? (
                <div className="mt-3">
                  <div className="flex items-center gap-2 text-[11px] text-slate-500">
                    <span>{openDump.name}</span>
                    <button type="button" onClick={() => setOpenDump(null)} className="ml-auto text-rose-400 hover:text-rose-300">
                      close
                    </button>
                  </div>
                  <pre className="terminal mt-1 max-h-[360px] overflow-auto rounded-lg p-3">{openDump.content}</pre>
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === "anatomy" ? (
            <div className="panel p-3">
              <div className="flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-wide text-slate-500">jvm anatomy map (expandable hierarchy)</span>
                <span className="text-[10px] text-slate-600">JVM → memory pools / GC collectors / thread pools → individual threads</span>
              </div>
              <div className="mt-2">
                {anatomyNodes.length ? (
                  <MapCanvas
                    nodes={anatomyNodes}
                    edges={anatomyNodes.filter((node) => node.parentId).map((node) => ({ id: `e:${node.parentId}->${node.id}`, source: node.parentId as string, target: node.id, tone: "idle" as const }))}
                    layout="tree"
                    defaultExpandDepth={2}
                    height="560px"
                    legend={[
                      { label: "runnable", tone: "#34d399" },
                      { label: "waiting", tone: "#fbbf24" },
                      { label: "blocked", tone: "#f43f5e" },
                    ]}
                    toolbarExtra={selectedTarget ? <span className="chip text-slate-500">{selectedTarget.name}</span> : null}
                  />
                ) : (
                  <div className="grid h-[200px] place-items-center text-[11px] text-slate-500">select a target to render its anatomy</div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Chart({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">{title}</span>
        {sub ? <span className="text-[10px] text-slate-600">{sub}</span> : null}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Info({ label, value, full, mono }: { label: string; value: string; full?: boolean; mono?: boolean }) {
  return (
    <div className={cls(full ? "flex gap-2" : "")}>
      <span className={cls("text-[10px] uppercase tracking-wide text-slate-500", full ? "w-[86px] shrink-0 pt-0.5" : "block")}>{label}</span>
      <span className={cls("truncate text-slate-300", mono ? "mono text-[10px]" : "text-[11px]")} title={value}>
        {value}
      </span>
    </div>
  );
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
}

