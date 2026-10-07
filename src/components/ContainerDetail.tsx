"use client";

import { useEffect, useState } from "react";
import { apiPost, cls, fmtMb, stateTone, TONE_CLASSES, useApi } from "@/lib/client";

interface ContainerPayload {
  container: {
    id: string;
    name: string;
    image: string;
    state: string;
    status: string;
    health: string | null;
    command: string;
    platform: string;
    createdAt: string;
    startedAt: string | null;
    restartCount: number;
    exitCode: number | null;
    labels: Record<string, string>;
    composeProject: string | null;
    composeService: string | null;
    ports: { host: number | null; container: number; protocol: string }[];
    networks: { name: string; ip?: string }[];
    mounts: { type: string; source: string; target: string; mode?: string }[];
    cpuPercent: number;
    memUsageMb: number;
    memLimitMb: number;
    memPercent: number;
    netRxMb: number;
    netTxMb: number;
    blockReadMb: number;
    blockWriteMb: number;
    pids: number;
  };
}

interface StatsPayload {
  cpuPercent: number;
  memUsageMb: number;
  memLimitMb: number;
  netRxMb: number;
  netTxMb: number;
  blockReadMb: number;
  blockWriteMb: number;
  pids: number;
  history: { ts: string; cpu: number; mem: number; net: number }[];
}

const TABS = ["overview", "logs", "stats", "exec"] as const;
type Tab = (typeof TABS)[number];

const ACTIONS = ["start", "stop", "restart", "pause", "unpause", "kill"] as const;

export default function ContainerDetail({ containerId, onClose }: { containerId: string | null; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState<string | null>(null);
  const [command, setCommand] = useState("ls -la /");
  const [terminal, setTerminal] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const { data, refresh } = useApi<ContainerPayload>(containerId ? `/radion/api/docker/containers/${containerId}` : null, 5000);
  const { data: logs, refresh: refreshLogs } = useApi<{ logs: string; mode: string }>(
    containerId && tab === "logs" ? `/radion/api/docker/containers/${containerId}/logs?tail=250` : null,
    tab === "logs" ? 4000 : 0,
  );
  const { data: stats } = useApi<StatsPayload>(containerId && tab === "stats" ? `/radion/api/docker/containers/${containerId}/stats` : null, tab === "stats" ? 3000 : 0);

  useEffect(() => {
    setTab("overview");
    setTerminal([]);
    setNotice(null);
  }, [containerId]);

  if (!containerId) return null;
  const container = data?.container;
  const tone = stateTone(container?.state, container?.health);
  const palette = TONE_CLASSES[tone] ?? TONE_CLASSES.idle;

  const act = async (action: string) => {
    setBusy(action);
    setNotice(null);
    try {
      const result = await apiPost<{ message: string; mode: string }>(`/radion/api/docker/containers/${containerId}`, { action });
      setNotice(result.message);
      await refresh();
      await refreshLogs();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "action failed");
    } finally {
      setBusy(null);
    }
  };

  const runExec = async () => {
    setBusy("exec");
    try {
      const result = await apiPost<{ output: string; exitCode: number | null }>(`/radion/api/docker/containers/${containerId}/exec`, { command });
      setTerminal((prev) => [...prev, `$ ${command}`, result.output.trim() || `(no output) exit=${result.exitCode ?? 0}`]);
    } catch (error) {
      setTerminal((prev) => [...prev, `$ ${command}`, `error: ${error instanceof Error ? error.message : "failed"}`]);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[560px] flex-col border-l border-slate-800 bg-[#0a1120]/98 shadow-2xl backdrop-blur">
      <div className="flex items-start gap-3 border-b border-slate-800 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cls("h-2 w-2 rounded-full", palette.dot)} />
            <span className="truncate text-sm font-semibold text-slate-100">{container?.name ?? containerId.slice(0, 12)}</span>
            <span className={cls("chip", palette.border, palette.bg, palette.text)}>{container?.health ?? container?.state ?? "…"}</span>
          </div>
          <div className="mono mt-1 truncate text-[11px] text-slate-500">{container?.id ?? containerId}</div>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-400 hover:border-rose-500 hover:text-rose-300">
          close
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-800 px-4 py-2">
        {ACTIONS.map((action) => (
          <button
            key={action}
            type="button"
            disabled={busy !== null}
            onClick={() => void act(action)}
            className={cls(
              "rounded-lg border px-2 py-1 text-[11px] transition disabled:opacity-40",
              action === "stop" || action === "kill" ? "border-rose-500/40 text-rose-300 hover:bg-rose-500/10" : "border-slate-700 text-slate-300 hover:border-sky-500 hover:text-sky-300",
            )}
          >
            {busy === action ? "…" : action}
          </button>
        ))}
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void act("remove")}
          className="ml-auto rounded-lg border border-rose-600/50 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/20 disabled:opacity-40"
        >
          remove
        </button>
      </div>

      <div className="flex gap-1 border-b border-slate-800 px-4 py-2 text-[11px]">
        {TABS.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            className={cls("rounded-lg px-2.5 py-1 transition", tab === item ? "bg-sky-500/15 text-sky-300" : "text-slate-400 hover:text-slate-200")}
          >
            {item}
          </button>
        ))}
      </div>

      {notice ? <div className="border-b border-slate-800 bg-sky-500/10 px-4 py-1.5 text-[11px] text-sky-300">{notice}</div> : null}

      <div className="flex-1 overflow-auto px-4 py-3 text-[12px]">
        {tab === "overview" && container ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Stat label="state" value={`${container.state}${container.exitCode !== null ? ` (${container.exitCode})` : ""}`} />
              <Stat label="restarts" value={String(container.restartCount)} />
              <Stat label="cpu" value={`${container.cpuPercent.toFixed(1)}%`} />
              <Stat label="memory" value={`${fmtMb(container.memUsageMb)} / ${fmtMb(container.memLimitMb)}`} />
              <Stat label="net rx/tx" value={`${container.netRxMb.toFixed(1)} / ${container.netTxMb.toFixed(1)} MB`} />
              <Stat label="block read/write" value={`${container.blockReadMb.toFixed(1)} / ${container.blockWriteMb.toFixed(1)} MB`} />
              <Stat label="pids" value={String(container.pids)} />
              <Stat label="platform" value={container.platform} />
            </div>
            <Section title="image & command">
              <KV k="image" v={container.image} />
              <KV k="command" v={container.command || "—"} />
              <KV k="project" v={container.composeProject ?? "standalone"} />
              <KV k="service" v={container.composeService ?? "—"} />
              <KV k="created" v={new Date(container.createdAt).toLocaleString()} />
              <KV k="started" v={container.startedAt ? new Date(container.startedAt).toLocaleString() : "—"} />
            </Section>
            <Section title="ports">
              {container.ports.length ? container.ports.map((port) => <KV key={`${port.host}-${port.container}`} k={port.host ? `0.0.0.0:${port.host}` : "—"} v={`${port.container}/${port.protocol}`} />) : <div className="text-slate-500">no published ports</div>}
            </Section>
            <Section title="networks">
              {container.networks.map((net) => (
                <KV key={net.name} k={net.name} v={net.ip ?? "—"} />
              ))}
            </Section>
            <Section title="mounts">
              {container.mounts.length ? (
                container.mounts.map((mount) => <KV key={`${mount.source}-${mount.target}`} k={`${mount.type} ${mount.mode ?? ""}`} v={`${mount.source} → ${mount.target}`} />)
              ) : (
                <div className="text-slate-500">no mounts</div>
              )}
            </Section>
            <Section title="labels">
              {Object.entries(container.labels).map(([key, value]) => (
                <KV key={key} k={key} v={value || "—"} />
              ))}
            </Section>
          </div>
        ) : null}

        {tab === "logs" ? (
          <div>
            <div className="mb-2 flex items-center gap-2 text-[11px] text-slate-500">
              <button type="button" className="chip hover:text-sky-300" onClick={() => void refreshLogs()}>
                refresh
              </button>
              <span>{logs?.mode === "demo" ? "simulated engine logs" : "engine stream (tail 250)"}</span>
            </div>
            <pre className="terminal max-h-[70vh] overflow-auto rounded-lg p-3">{logs?.logs || "loading…"}</pre>
          </div>
        ) : null}

        {tab === "stats" ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <Stat label="cpu" value={`${(stats?.cpuPercent ?? 0).toFixed(1)}%`} />
              <Stat label="mem" value={`${fmtMb(stats?.memUsageMb ?? 0)} / ${fmtMb(stats?.memLimitMb ?? 0)}`} />
              <Stat label="net rx" value={`${(stats?.netRxMb ?? 0).toFixed(1)} MB`} />
              <Stat label="net tx" value={`${(stats?.netTxMb ?? 0).toFixed(1)} MB`} />
            </div>
            <Sparkline label="cpu %" points={(stats?.history ?? []).map((h) => h.cpu)} color="#38bdf8" suffix="%" max={100} />
            <Sparkline label="memory MB" points={(stats?.history ?? []).map((h) => h.mem)} color="#a855f7" suffix=" MB" />
            <Sparkline label="network MB" points={(stats?.history ?? []).map((h) => h.net)} color="#34d399" suffix=" MB" />
          </div>
        ) : null}

        {tab === "exec" ? (
          <div className="space-y-2">
            <div className="flex gap-2">
              <span className="grid place-items-center rounded-lg border border-slate-800 px-2 text-[11px] text-slate-500">#</span>
              <input
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void runExec();
                }}
                className="mono w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-[12px] text-slate-200 outline-none focus:border-sky-500"
                placeholder="command to run inside the container"
              />
              <button type="button" onClick={() => void runExec()} disabled={busy !== null} className="shrink-0 rounded-lg bg-sky-500 px-3 py-1.5 text-[11px] font-semibold text-slate-950 disabled:opacity-50">
                {busy === "exec" ? "…" : "run"}
              </button>
            </div>
            <pre className="terminal max-h-[60vh] overflow-auto rounded-lg p-3">{terminal.join("\n") || "exec a command inside the container (docker exec equivalent)"}</pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mono mt-0.5 truncate text-[12px] text-slate-200">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">{title}</div>
      <div className="space-y-1 rounded-lg border border-slate-800 bg-slate-950/40 p-2">{children}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2 text-[11px]">
      <span className="w-32 shrink-0 truncate text-slate-500">{k}</span>
      <span className="mono min-w-0 flex-1 truncate text-slate-300" title={v}>
        {v}
      </span>
    </div>
  );
}

export function Sparkline({ label, points, color, suffix, max }: { label: string; points: number[]; color: string; suffix?: string; max?: number }) {
  const width = 460;
  const height = 56;
  const data = points.length ? points : [0];
  const peak = max ?? Math.max(...data, 1);
  const step = width / Math.max(1, data.length - 1);
  const path = data.map((value, index) => `${index === 0 ? "M" : "L"}${(index * step).toFixed(1)},${(height - (value / peak) * height).toFixed(1)}`).join(" ");
  const last = data[data.length - 1] ?? 0;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-500">
        <span>{label}</span>
        <span className="mono text-slate-400">
          {last.toFixed(1)}
          {suffix}
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-14 w-full">
        <path d={`${path} L${width},${height} L0,${height} Z`} fill={color} opacity="0.13" />
        <path d={path} fill="none" stroke={color} strokeWidth="1.6" />
      </svg>
    </div>
  );
}
