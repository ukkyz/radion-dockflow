"use client";

import Link from "next/link";
import { useState } from "react";
import { apiPost, cls, fmtMb, fmtMs, stateTone, timeAgo, TONE_CLASSES, useApi } from "@/lib/client";
import type { ApmTopology, ContainerInfo, DockerOverview } from "@/lib/types";

interface HealthInfo {
  status: string;
  database: string;
  databaseEngine: string;
  dbError?: string | null;
  sqlite: {
    path: string;
    engine: string;
    kind: "file" | "remote";
    authToken: boolean;
    replicaOf: string | null;
    sizeKb: number | null;
    tables: number;
  };
}

interface RunSummary {
  id: string;
  workflowName: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
  steps: { label: string; status: string }[];
}

export default function OverviewPage() {
  const overview = useApi<DockerOverview>("/radion/api/docker/overview", 8000);
  const containers = useApi<{ containers: ContainerInfo[] }>("/radion/api/docker/containers", 6000);
  const runs = useApi<{ runs: RunSummary[] }>("/radion/api/runs?limit=6", 10000);
  const apm = useApi<ApmTopology>("/radion/api/apm/topology", 12000);
  const binaries = useApi<{ available: Record<string, string | null> }>("/radion/api/cli/run?detect=1", 0);
  const health = useApi<HealthInfo>("/radion/api/health", 30_000);
  const jvm = useApi<{ targets: { id: string; name: string; kind: string; status: string; jvmVersion: string | null; app: string }[]; counts: { total: number; online: number; simulated: number; discovered: number } }>(
    "/radion/api/jvm/targets",
    20_000,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const data = overview.data;
  const top = [...(containers.data?.containers ?? [])].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 6);
  const totals = apm.data?.totals;

  const prune = async (kind: string) => {
    setBusy(true);
    try {
      const result = await apiPost<{ message: string }>("/radion/api/docker/prune", { kind });
      setNotice(result.message);
      await overview.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "prune failed");
    } finally {
      setBusy(false);
    }
  };

  const restartProject = async (project: string) => {
    setBusy(true);
    try {
      const result = await apiPost<{ message: string }>("/radion/api/docker/projects", { project, action: "restart" });
      setNotice(result.message);
      await overview.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "restart failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {data?.mode === "demo" ? (
        <div className="panel border-amber-500/40 bg-amber-500/[0.06] px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="chip border-amber-500/50 bg-amber-500/10 text-amber-300">demo engine active</span>
            <span className="text-[12px] text-amber-200/90">
              No Docker daemon answered on this host ({data.endpoint.address}). Everything below runs against a simulated engine so every screen stays fully
              functional — add a reachable endpoint in the header and hit <span className="mono">reconnect</span> to switch to live mode.
            </span>
          </div>
          {data.error ? <div className="mono mt-1 text-[10px] text-amber-400/70">last error: {data.error}</div> : null}
        </div>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        <Card label="containers" value={`${data?.counts.running ?? 0}/${data?.counts.containers ?? 0}`} hint="running / total" />
        <Card label="needs attention" value={String(data?.counts.unhealthy ?? 0)} hint="unhealthy or restarting" tone={(data?.counts.unhealthy ?? 0) > 0 ? "bad" : "good"} />
        <Card label="images" value={String(data?.counts.images ?? 0)} hint={`${data?.counts.diskImagesMb ?? 0} MB on disk`} />
        <Card label="volumes" value={String(data?.counts.volumes ?? 0)} hint="local volumes" />
        <Card label="networks" value={String(data?.counts.networks ?? 0)} hint="bridge / overlay" />
        <Card label="cpu total" value={`${data?.counts.totalCpuPercent ?? 0}%`} hint={`${data?.engine.cpus ?? 0} cpus`} tone={(data?.counts.totalCpuPercent ?? 0) > 70 ? "warn" : "good"} />
        <Card label="memory" value={fmtMb(data?.counts.totalMemMb ?? 0)} hint={`of ${fmtMb(data?.counts.memLimitMb ?? 0)}`} />
        <Card label="apm error rate" value={`${totals?.errorRate ?? 0}%`} hint={`p95 ${fmtMs(totals?.p95Ms ?? 0)}`} tone={(totals?.errorRate ?? 0) > 3 ? "bad" : "good"} />
        <Card
          label="java processes"
          value={String(jvm.data?.counts.total ?? 0)}
          hint={`${jvm.data?.counts.online ?? 0} jmx/actuator · ${jvm.data?.counts.simulated ?? 0} simulated`}
          tone={(jvm.data?.counts.total ?? 0) > 0 ? "good" : "warn"}
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.4fr_1fr]">
        <section className="panel p-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-100">Busiest containers</h2>
            <span className="text-[11px] text-slate-500">live cpu · click a row for logs, stats and exec</span>
            <Link href="/containers" className="ml-auto text-[11px] text-sky-400 hover:text-sky-300">
              open containers →
            </Link>
          </div>
          <div className="mt-3 space-y-1.5">
            {top.map((container) => {
              const tone = stateTone(container.state, container.health);
              const palette = TONE_CLASSES[tone];
              return (
                <div key={container.id} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-2">
                  <span className={cls("h-1.5 w-1.5 shrink-0 rounded-full", palette.dot)} />
                  <span className="w-40 shrink-0 truncate text-[12px] text-slate-200">{container.name}</span>
                  <span className="hidden w-52 shrink-0 truncate text-[11px] text-slate-500 sm:block">{container.image}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                    <span className="block h-full rounded-full bg-gradient-to-r from-sky-500 to-purple-500" style={{ width: `${Math.min(100, container.cpuPercent)}%` }} />
                  </span>
                  <span className="mono w-14 shrink-0 text-right text-[11px] text-slate-300">{container.cpuPercent.toFixed(1)}%</span>
                  <span className="mono w-20 shrink-0 text-right text-[11px] text-slate-400">{fmtMb(container.memUsageMb)}</span>
                </div>
              );
            })}
            {!top.length ? <div className="py-6 text-center text-[12px] text-slate-500">{containers.loading ? "loading…" : "no containers"}</div> : null}
          </div>
        </section>

        <section className="panel p-3">
          <h2 className="text-sm font-semibold text-slate-100">Engine</h2>
          <div className="mt-2 space-y-1 text-[11px]">
            <Row k="endpoint" v={data?.endpoint.address ?? "—"} mono />
            <Row k="mode" v={data?.mode === "live" ? "live engine" : "demo engine"} />
            <Row k="server" v={`docker ${data?.engine.serverVersion ?? "—"} (api ${data?.engine.apiVersion ?? "—"})`} />
            <Row k="host" v={`${data?.engine.name ?? "—"} · ${data?.engine.os ?? ""} ${data?.engine.arch ?? ""}`} />
            <Row k="kernel" v={data?.engine.kernelVersion ?? "—"} />
            <Row k="resources" v={`${data?.engine.cpus ?? 0} cpus · ${fmtMb(data?.engine.totalMemoryMb ?? 0)}`} />
            <Row k="storage" v={`${data?.engine.driver ?? "—"} · runtime ${data?.engine.runtime ?? "—"}`} />
            <Row
              k="console db"
              v={`${health.data?.sqlite.engine ?? "libsql"} · ${health.data?.sqlite.kind ?? "file"} · ${health.data?.sqlite.tables ?? 0} tables${
                health.data?.sqlite?.sizeKb ? ` · ${health.data.sqlite.sizeKb} KB` : ""
              } · ${health.data?.sqlite.path ?? "data/dockflow.db"}${health.data?.sqlite?.replicaOf ? " (embedded replica)" : ""}`}
              mono
            />
          </div>
          {data?.engine.warnings?.length ? (
            <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[11px] text-amber-300">{data.engine.warnings.join(" · ")}</div>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
            <button type="button" disabled={busy} onClick={() => void prune("containers")} className="chip text-amber-300 hover:border-amber-500">
              prune stopped
            </button>
            <button type="button" disabled={busy} onClick={() => void prune("images")} className="chip text-amber-300 hover:border-amber-500">
              prune images
            </button>
            <button type="button" disabled={busy} onClick={() => void prune("volumes")} className="chip text-amber-300 hover:border-amber-500">
              prune volumes
            </button>
            {(containers.data?.containers ?? [])
              .map((c) => c.composeProject)
              .filter((p, i, all): p is string => Boolean(p) && all.indexOf(p) === i)
              .map((project) => (
                <button key={project} type="button" disabled={busy} onClick={() => void restartProject(project)} className="chip border-sky-500/40 text-sky-300 hover:border-sky-400">
                  restart {project}
                </button>
              ))}
          </div>
          {notice ? <div className="mt-2 text-[11px] text-sky-300">{notice}</div> : null}
        </section>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1fr_1fr_1fr]">
        <section className="panel p-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-100">JVM monitor</h2>
            <Link href="/jvm" className="ml-auto text-[11px] text-sky-400 hover:text-sky-300">
              open jvisualvm-style monitor →
            </Link>
          </div>
          <div className="mt-2 space-y-1">
            {(jvm.data?.targets ?? []).slice(0, 5).map((target) => (
              <div key={target.id} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5 text-[11px]">
                <span className={cls("h-1.5 w-1.5 rounded-full", target.status === "online" ? "bg-emerald-400" : target.status === "offline" ? "bg-rose-500" : "bg-sky-400")} />
                <span className="w-40 truncate text-slate-300">{target.name}</span>
                <span className="chip text-slate-500">{target.kind}</span>
                <span className="mono ml-auto truncate text-slate-500">{target.jvmVersion ?? "jvm unknown"}</span>
              </div>
            ))}
            {!jvm.data?.targets.length ? (
              <div className="py-3 text-center text-[11px] text-slate-500">{jvm.loading ? "loading JVM targets…" : "no Java processes found on the engine"}</div>
            ) : null}
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
            Heap + GC charts, visual GC, deadlock detection, sampling profiler with call tree, mbean browser and thread/heap dumps.
          </p>
        </section>

        <section className="panel p-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-100">APM snapshot</h2>
            <Link href="/apm" className="ml-auto text-[11px] text-sky-400 hover:text-sky-300">
              service map →
            </Link>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Mini label="services" value={String(totals?.services ?? 0)} />
            <Mini label="unhealthy" value={String(totals?.unhealthy ?? 0)} tone={(totals?.unhealthy ?? 0) > 0 ? "bad" : "good"} />
            <Mini label="calls/min" value={String(totals?.callsPerMin ?? 0)} />
            <Mini label="error rate" value={`${totals?.errorRate ?? 0}%`} tone={(totals?.errorRate ?? 0) > 3 ? "bad" : "good"} />
            <Mini label="p95" value={fmtMs(totals?.p95Ms ?? 0)} />
            <Mini label="apdex" value={String(totals?.apdex ?? 1)} />
          </div>
          <div className="mt-3 space-y-1">
            {[...(apm.data?.nodes ?? [])]
              .sort((a, b) => b.p95Ms - a.p95Ms)
              .slice(0, 5)
              .map((node) => (
                <div key={node.key} className="flex items-center gap-2 text-[11px]">
                  <span className={cls("h-1.5 w-1.5 rounded-full", (TONE_CLASSES[stateTone(node.status)] ?? TONE_CLASSES.idle).dot)} />
                  <span className="w-28 truncate text-slate-300">{node.name}</span>
                  <span className="mono text-slate-500">p95 {fmtMs(node.p95Ms)}</span>
                  <span className="mono ml-auto text-slate-400">{node.requests} spans</span>
                </div>
              ))}
            {!apm.data?.nodes.length ? <div className="py-3 text-center text-[11px] text-slate-500">{apm.loading ? "loading telemetry…" : "no telemetry yet — enable live traffic on the APM page"}</div> : null}
          </div>
        </section>

        <section className="panel p-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-slate-100">Workflow runs</h2>
            <Link href="/workflows" className="ml-auto text-[11px] text-sky-400 hover:text-sky-300">
              automate →
            </Link>
          </div>
          <div className="mt-2 space-y-1.5">
            {(runs.data?.runs ?? []).map((run) => (
              <div key={run.id} className="rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-2">
                <div className="flex items-center gap-2 text-[12px]">
                  <span
                    className={cls(
                      "h-1.5 w-1.5 rounded-full",
                      (TONE_CLASSES[stateTone(run.status === "success" ? "running" : run.status === "failed" ? "exited" : "restarting")] ?? TONE_CLASSES.idle).dot,
                    )}
                  />
                  <span className="truncate text-slate-200">{run.workflowName}</span>
                  <span className="chip ml-auto text-slate-400">{run.status}</span>
                </div>
                <div className="mt-1 text-[10px] text-slate-500">
                  {timeAgo(run.startedAt)} · {run.steps.filter((s) => s.status === "success").length}/{run.steps.length} steps ok
                  {run.durationMs ? ` · ${(run.durationMs / 1000).toFixed(1)}s` : ""}
                </div>
              </div>
            ))}
            {!runs.data?.runs.length ? <div className="py-3 text-center text-[11px] text-slate-500">no runs recorded yet</div> : null}
          </div>
        </section>

        <section className="panel p-3">
          <h2 className="text-sm font-semibold text-slate-100">CLI applications on PATH</h2>
          <p className="mt-1 text-[11px] text-slate-500">Workflows and the CLI console can drive any of these locally.</p>
          <div className="mt-2 space-y-1">
            {Object.entries(binaries.data?.available ?? {}).map(([binary, version]) => (
              <div key={binary} className="flex items-start gap-2 text-[11px]">
                <span className={cls("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", version ? "bg-emerald-400" : "bg-slate-600")} />
                <span className="mono w-16 shrink-0 text-slate-300">{binary}</span>
                <span className="mono min-w-0 flex-1 truncate text-slate-500">{version ?? "not found"}</span>
              </div>
            ))}
            {!binaries.data ? <div className="py-3 text-center text-[11px] text-slate-500">probing binaries…</div> : null}
          </div>
          <Link href="/cli" className="mt-3 inline-block text-[11px] text-sky-400 hover:text-sky-300">
            open CLI console →
          </Link>
        </section>
      </div>
    </div>
  );
}

function Card({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "warn" | "bad" }) {
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
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cls("mono text-[13px]", tone ? palette.text : "text-slate-200")}>{value}</div>
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-slate-500">{k}</span>
      <span className={cls("min-w-0 flex-1 truncate text-slate-300", mono ? "mono text-[10px]" : "")} title={v}>
        {v}
      </span>
    </div>
  );
}
