"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { apiPost, cls, useApi } from "@/lib/client";

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

interface ConnectionInfo {
  mode: "live" | "demo";
  error: string | null;
  engine: { serverVersion: string; apiVersion: string; os: string; cpus: number; totalMemoryMb: number; name: string };
  active: { name: string; address: string; kind: string };
  endpoints: { id: string; name: string; address: string; kind: string; status: string; isDefault: boolean }[];
  instruction: string | null;
}

const NAV = [
  { href: "/", label: "Overview", glyph: "◎" },
  { href: "/graph", label: "Container hierarchy", glyph: "⧉" },
  { href: "/topology", label: "Container topology", glyph: "📦" },
  { href: "/containers", label: "Containers", glyph: "🐳" },
  { href: "/apm", label: "Service map / APM", glyph: "📈" },
  { href: "/jvm", label: "JVM monitor", glyph: "☕" },
  { href: "/config", label: "Config & repos", glyph: "🧩" },
  { href: "/workflows", label: "Workflows", glyph: "⛓" },
  { href: "/cli", label: "CLI console", glyph: "▮" },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [showEndpoints, setShowEndpoints] = useState(false);
  const [newAddress, setNewAddress] = useState("tcp://host.docker.internal:2375");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { data, refresh } = useApi<ConnectionInfo>("/radion/api/docker/connection", 20_000);
  const health = useApi<HealthInfo>("/radion/api/health", 60_000);

  const reconnect = async () => {
    setBusy(true);
    try {
      const res = await fetch("/radion/api/docker/connection?force=1", { cache: "no-store" });
      const json = (await res.json()) as { ok: boolean; error?: string };
      setMessage(json.ok ? "connection refreshed" : json.error ?? "failed");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const addEndpoint = async () => {
    setBusy(true);
    try {
      await apiPost("/radion/api/docker/connection", { address: newAddress, makeDefault: true });
      setMessage(`endpoint ${newAddress} saved`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "failed to add endpoint");
    } finally {
      setBusy(false);
    }
  };

  const mode = data?.mode ?? "demo";

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-[#070b14]/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1800px] flex-wrap items-center gap-3 px-4 py-2.5">
          <Link href="/" className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-sky-500 to-purple-600 text-sm font-black text-slate-950">
              DF
            </span>
            <span className="text-sm font-semibold tracking-tight text-slate-100">
              DockFlow <span className="text-slate-500">Console</span>
            </span>
          </Link>

          <nav className="flex flex-wrap items-center gap-1 text-[12px]">
            {NAV.map((item) => {
              const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cls(
                    "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 transition",
                    active ? "bg-sky-500/15 text-sky-300 shadow-[inset_0_0_0_1px_rgba(56,189,248,0.3)]" : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200",
                  )}
                >
                  <span className="text-[13px]">{item.glyph}</span>
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowEndpoints((v) => !v)}
              className={cls(
                "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] transition",
                mode === "live" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-amber-500/40 bg-amber-500/10 text-amber-300",
              )}
              title={data?.error ?? "docker engine connection"}
            >
              <span className={cls("h-2 w-2 rounded-full", mode === "live" ? "bg-emerald-400 pulse-ring" : "bg-amber-400")} />
              {mode === "live" ? `engine ${data?.engine.serverVersion ?? ""}` : "demo engine"}
              <span className="mono max-w-[190px] truncate text-slate-400">{data?.active?.address ?? "…"}</span>
            </button>
            <button
              type="button"
              onClick={() => void reconnect()}
              disabled={busy}
              className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-[11px] text-slate-300 transition hover:border-sky-500 hover:text-sky-300 disabled:opacity-50"
            >
              reconnect
            </button>
          </div>
        </div>

        {showEndpoints ? (
          <div className="border-t border-slate-800 bg-[#0a1120]">
            <div className="mx-auto grid w-full max-w-[1800px] gap-3 px-4 py-3 md:grid-cols-[1.4fr_1fr]">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-slate-500">Docker endpoints</div>
                <div className="mt-2 space-y-1.5">
                  {(data?.endpoints ?? []).map((endpoint) => (
                    <div key={endpoint.address} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-1.5 text-[11px]">
                      <span className={cls("h-1.5 w-1.5 rounded-full", endpoint.status === "online" ? "bg-emerald-400" : "bg-slate-600")} />
                      <span className="text-slate-200">{endpoint.name}</span>
                      <span className="mono text-slate-500">{endpoint.address}</span>
                      {endpoint.isDefault ? <span className="chip border-sky-500/40 bg-sky-500/10 text-sky-300">default</span> : null}
                      <button
                        type="button"
                        className="ml-auto text-slate-500 hover:text-rose-400"
                        onClick={async () => {
                          await fetch(`/radion/api/docker/connection?id=${encodeURIComponent(endpoint.id)}`, { method: "DELETE" });
                          await refresh();
                        }}
                      >
                        remove
                      </button>
                    </div>
                  ))}
                  {!data?.endpoints?.length ? <div className="text-[11px] text-slate-500">No endpoints captured yet.</div> : null}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-slate-500">Add / switch endpoint</div>
                <div className="mt-2 flex gap-2">
                  <input
                    value={newAddress}
                    onChange={(event) => setNewAddress(event.target.value)}
                    className="mono w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-[11px] text-slate-200 outline-none focus:border-sky-500"
                    placeholder="unix:///var/run/docker.sock | tcp://host:2375"
                  />
                  <button type="button" onClick={() => void addEndpoint()} disabled={busy} className="shrink-0 rounded-lg bg-sky-500 px-3 py-1.5 text-[11px] font-semibold text-slate-950 disabled:opacity-50">
                    save + connect
                  </button>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                  {data?.instruction ??
                    "The console speaks the Docker Engine API directly. Unix sockets work when the app runs on the same host; use an exposed TCP endpoint (DOCKER_HOST=tcp://…) for remote engines."}
                </p>
                {message ? <p className="mt-1 text-[11px] text-sky-300">{message}</p> : null}
                {data?.error ? <p className="mt-1 mono text-[10px] text-amber-400/80">last error: {data.error}</p> : null}
              </div>
            </div>
          </div>
        ) : null}
      </header>

      <main className="mx-auto w-full max-w-[1800px] flex-1 px-4 py-4">{children}</main>

      <footer className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-slate-800/70 px-4 py-3 text-[11px] text-slate-600">
        <span>DockFlow Console · xyflow hierarchy maps · Docker Engine API · agent ingestion at <span className="mono">POST /radion/api/apm/ingest</span> ·</span>
        <span className={cls("flex items-center gap-1", health.data?.status === "healthy" ? "text-emerald-500" : "text-amber-500")}>
          <span className={cls("h-1.5 w-1.5 rounded-full", health.data?.status === "healthy" ? "bg-emerald-400" : "bg-amber-400")} />
          {health.data?.sqlite.engine ?? "libsql"} {health.data?.database === "up" ? "ready" : "unavailable"} · {health.data?.sqlite.tables ?? 0} tables
          {health.data?.sqlite?.sizeKb ? ` · ${health.data.sqlite.sizeKb} KB` : ""}
          {health.data?.sqlite?.kind === "remote" ? " · remote" : ""}
          {health.data?.sqlite?.authToken ? " · token" : ""}
          {health.data?.sqlite?.replicaOf ? " · embedded replica" : ""}
        </span>
        <span className="mono truncate text-slate-600">{health.data?.sqlite.path ?? ""}</span>
        <span className={cls(mode === "live" ? "text-emerald-500" : "text-amber-500")}>
          · {mode === "live" ? "connected to a live engine" : "demo engine (no local daemon reachable)"}
        </span>
      </footer>
    </div>
  );
}
