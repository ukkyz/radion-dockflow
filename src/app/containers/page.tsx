"use client";

import { useMemo, useState } from "react";
import ContainerDetail from "@/components/ContainerDetail";
import { apiDelete, apiPost, cls, fmtMb, stateTone, timeAgo, TONE_CLASSES, useApi } from "@/lib/client";
import type { ContainerInfo, ImageInfo, NetworkInfo, VolumeInfo } from "@/lib/types";

type Tab = "containers" | "images" | "volumes" | "networks";

interface ContainersPayload {
  mode: string;
  containers: ContainerInfo[];
  stats: { total: number; running: number; stopped: number; unhealthy: number; cpuPercent: number; memMb: number; projects: string[] };
}

export default function ContainersPage() {
  const [tab, setTab] = useState<Tab>("containers");
  const [project, setProject] = useState("all");
  const [filter, setFilter] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ image: "nginx:1.27-alpine", name: "", ports: "8081:80", env: "", command: "" });
  const [showRun, setShowRun] = useState(false);

  const containers = useApi<ContainersPayload>("/radion/api/docker/containers", 6000);
  const images = useApi<{ mode: string; images: ImageInfo[] }>(tab === "images" ? "/radion/api/docker/images" : null, 15000);
  const volumes = useApi<{ mode: string; volumes: VolumeInfo[] }>(tab === "volumes" ? "/radion/api/docker/volumes" : null, 15000);
  const networks = useApi<{ mode: string; networks: NetworkInfo[] }>(tab === "networks" ? "/radion/api/docker/networks" : null, 15000);

  const rows = useMemo(() => {
    const list = containers.data?.containers ?? [];
    return list.filter((container) => {
      if (project !== "all" && (container.composeProject ?? "standalone") !== project) return false;
      if (stateFilter === "running" && container.state !== "running") return false;
      if (stateFilter === "stopped" && !["exited", "created", "dead"].includes(container.state)) return false;
      if (stateFilter === "unhealthy" && !(container.health === "unhealthy" || container.state === "restarting")) return false;
      if (!filter) return true;
      const haystack = `${container.name} ${container.image} ${container.composeService ?? ""} ${container.id}`.toLowerCase();
      return haystack.includes(filter.toLowerCase());
    });
  }, [containers.data, project, stateFilter, filter]);

  const act = async (id: string, action: string) => {
    setBusy(`${id}:${action}`);
    try {
      const result = await apiPost<{ message: string }>(`/radion/api/docker/containers/${id}`, { action });
      setNotice(result.message);
      await containers.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "action failed");
    } finally {
      setBusy(null);
    }
  };

  const runPrune = async (kind: string) => {
    setBusy(`prune:${kind}`);
    try {
      const result = await apiPost<{ message: string }>("/radion/api/docker/prune", { kind });
      setNotice(result.message);
      await Promise.all([containers.refresh(), images.refresh(), volumes.refresh(), networks.refresh()]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "prune failed");
    } finally {
      setBusy(null);
    }
  };

  const createContainer = async () => {
    setBusy("create");
    try {
      const result = await apiPost<{ message: string; id: string }>("/radion/api/docker/containers", form);
      setNotice(result.message);
      setShowRun(false);
      await containers.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "failed to create container");
    } finally {
      setBusy(null);
    }
  };

  const stats = containers.data?.stats;

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Metric label="containers" value={String(stats?.total ?? 0)} hint={`${stats?.running ?? 0} running`} />
        <Metric label="stopped" value={String(stats?.stopped ?? 0)} hint="exited / created" />
        <Metric label="attention" value={String(stats?.unhealthy ?? 0)} hint="unhealthy or restarting" tone={(stats?.unhealthy ?? 0) > 0 ? "bad" : "good"} />
        <Metric label="cpu total" value={`${stats?.cpuPercent ?? 0}%`} hint="sum of containers" tone={(stats?.cpuPercent ?? 0) > 80 ? "warn" : "good"} />
        <Metric label="memory total" value={fmtMb(stats?.memMb ?? 0)} hint="rss across containers" />
      </div>

      <div className="panel flex flex-wrap items-center gap-2 px-3 py-2">
        <div className="flex gap-1">
          {(["containers", "images", "volumes", "networks"] as Tab[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={cls("rounded-lg px-2.5 py-1 text-[12px] transition", tab === item ? "bg-sky-500/15 text-sky-300" : "text-slate-400 hover:text-slate-200")}
            >
              {item}
            </button>
          ))}
        </div>

        {tab === "containers" ? (
          <>
            <select value={project} onChange={(event) => setProject(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-300">
              <option value="all">all projects</option>
              {(stats?.projects ?? []).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-300">
              <option value="all">any state</option>
              <option value="running">running</option>
              <option value="stopped">stopped</option>
              <option value="unhealthy">needs attention</option>
            </select>
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="filter by name, image, id"
              className="w-56 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 outline-none focus:border-sky-500"
            />
          </>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5 text-[11px]">
          <button type="button" onClick={() => void runPrune(tab === "containers" ? "containers" : tab.slice(0, -1))} disabled={busy !== null} className="chip text-amber-300 hover:border-amber-500">
            {busy?.startsWith("prune") ? "pruning…" : `prune ${tab === "containers" ? "stopped" : tab}`}
          </button>
          <button type="button" onClick={() => setShowRun((v) => !v)} className="chip border-sky-500/50 bg-sky-500/10 text-sky-300">
            + run container
          </button>
        </div>
      </div>

      {notice ? <div className="panel border-sky-500/40 px-3 py-2 text-[12px] text-sky-300">{notice}</div> : null}
      {containers.error ? <div className="panel border-rose-500/40 px-3 py-2 text-[12px] text-rose-300">{containers.error}</div> : null}

      {showRun ? (
        <div className="panel grid gap-2 px-3 py-3 md:grid-cols-5">
          {(
            [
              ["image", "image (required)"],
              ["name", "name"],
              ["ports", "ports host:container"],
              ["env", "env K=V, K=V"],
              ["command", "command"],
            ] as const
          ).map(([key, placeholder]) => (
            <input
              key={key}
              value={form[key]}
              placeholder={placeholder}
              onChange={(event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))}
              className="mono rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-sky-500"
            />
          ))}
          <button
            type="button"
            onClick={() => void createContainer()}
            disabled={busy !== null}
            className="rounded-lg bg-sky-500 px-3 py-1.5 text-[11px] font-semibold text-slate-950 disabled:opacity-50"
          >
            {busy === "create" ? "starting…" : "docker run"}
          </button>
        </div>
      ) : null}

      {tab === "containers" ? (
        <div className="panel overflow-hidden">
          <table className="w-full border-collapse text-[12px]">
            <thead className="bg-slate-900/60 text-left text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">name</th>
                <th className="px-3 py-2">state</th>
                <th className="px-3 py-2">image</th>
                <th className="px-3 py-2">ports</th>
                <th className="px-3 py-2">cpu</th>
                <th className="px-3 py-2">mem</th>
                <th className="px-3 py-2">project</th>
                <th className="px-3 py-2">created</th>
                <th className="px-3 py-2 text-right">actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((container) => {
                const tone = stateTone(container.state, container.health);
                const palette = TONE_CLASSES[tone];
                return (
                  <tr key={container.id} className="border-t border-slate-800/70 hover:bg-slate-800/25">
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => setSelected(container.id)} className="text-left hover:text-sky-300">
                        <div className="font-medium text-slate-200">{container.name}</div>
                        <div className="mono text-[10px] text-slate-500">{container.shortId}</div>
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <span className={cls("chip inline-flex items-center gap-1", palette.border, palette.bg, palette.text)}>
                        <span className={cls("h-1.5 w-1.5 rounded-full", palette.dot)} />
                        {container.health ?? container.state}
                      </span>
                    </td>
                    <td className="mono max-w-[220px] truncate px-3 py-2 text-slate-400" title={container.image}>
                      {container.image}
                    </td>
                    <td className="mono px-3 py-2 text-[11px] text-slate-400">
                      {container.ports.length ? container.ports.map((p) => `${p.host ?? "-"}→${p.container}`).join(" ") : "—"}
                    </td>
                    <td className="px-3 py-2 text-slate-300">{container.cpuPercent.toFixed(1)}%</td>
                    <td className="px-3 py-2 text-slate-300">{fmtMb(container.memUsageMb)}</td>
                    <td className="px-3 py-2 text-slate-400">{container.composeProject ?? "standalone"}</td>
                    <td className="px-3 py-2 text-slate-500">{timeAgo(container.createdAt)}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1 text-[10px]">
                        {container.state === "running" ? (
                          <>
                            <button type="button" disabled={busy !== null} onClick={() => void act(container.id, "restart")} className="chip hover:border-amber-500 hover:text-amber-300">
                              restart
                            </button>
                            <button type="button" disabled={busy !== null} onClick={() => void act(container.id, "stop")} className="chip hover:border-rose-500 hover:text-rose-300">
                              stop
                            </button>
                          </>
                        ) : (
                          <button type="button" disabled={busy !== null} onClick={() => void act(container.id, "start")} className="chip hover:border-emerald-500 hover:text-emerald-300">
                            start
                          </button>
                        )}
                        <button type="button" onClick={() => setSelected(container.id)} className="chip hover:border-sky-500 hover:text-sky-300">
                          logs
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!rows.length ? (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-slate-500">
                    {containers.loading ? "loading containers…" : "no containers match the current filters"}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {tab === "images" ? (
        <SimpleTable
          headers={["tag", "id", "size", "used by", "created", ""]}
          rows={(images.data?.images ?? []).map((image) => [
            <span key="tag" className="mono text-slate-200">
              {image.tags.join(", ")}
            </span>,
            <span key="id" className="mono text-[10px] text-slate-500">
              {image.shortId}
            </span>,
            `${image.sizeMb} MB`,
            `${image.containers} containers`,
            timeAgo(image.createdAt),
            <button
              key="del"
              type="button"
              className="chip hover:border-rose-500 hover:text-rose-300"
              onClick={async () => {
                try {
                  const result = await apiDelete<{ message: string }>(`/radion/api/docker/images?id=${encodeURIComponent(image.id)}`);
                  setNotice(result.message);
                  await images.refresh();
                } catch (error) {
                  setNotice(error instanceof Error ? error.message : "remove failed");
                }
              }}
            >
              remove
            </button>,
          ])}
        />
      ) : null}

      {tab === "volumes" ? (
        <SimpleTable
          headers={["name", "driver", "mountpoint", "attached", "size", ""]}
          rows={(volumes.data?.volumes ?? []).map((volume) => [
            <span key="name" className="text-slate-200">
              {volume.name}
            </span>,
            volume.driver,
            <span key="mp" className="mono text-[10px] text-slate-500">
              {volume.mountpoint}
            </span>,
            volume.containers.map((c) => c.name).join(", ") || "—",
            volume.sizeMb ? `${volume.sizeMb} MB` : "—",
            <button
              key="del"
              type="button"
              className="chip hover:border-rose-500 hover:text-rose-300"
              onClick={async () => {
                try {
                  const result = await apiDelete<{ message: string }>(`/radion/api/docker/volumes?name=${encodeURIComponent(volume.name)}`);
                  setNotice(result.message);
                  await volumes.refresh();
                } catch (error) {
                  setNotice(error instanceof Error ? error.message : "remove failed");
                }
              }}
            >
              remove
            </button>,
          ])}
        />
      ) : null}

      {tab === "networks" ? (
        <SimpleTable
          headers={["name", "driver", "subnet", "containers", "scope", ""]}
          rows={(networks.data?.networks ?? []).map((network) => [
            <span key="name" className="text-slate-200">
              {network.name}
            </span>,
            network.driver,
            <span key="sn" className="mono text-[11px] text-slate-400">
              {network.subnet ?? "—"}
            </span>,
            network.containers.map((c) => `${c.name}${c.ip ? ` (${c.ip})` : ""}`).join(", ") || "—",
            network.scope,
            <button
              key="del"
              type="button"
              className="chip hover:border-rose-500 hover:text-rose-300"
              onClick={async () => {
                try {
                  const result = await apiDelete<{ message: string }>(`/radion/api/docker/networks?id=${encodeURIComponent(network.id)}`);
                  setNotice(result.message);
                  await networks.refresh();
                } catch (error) {
                  setNotice(error instanceof Error ? error.message : "remove failed");
                }
              }}
            >
              remove
            </button>,
          ])}
        />
      ) : null}

      <ContainerDetail containerId={selected} onClose={() => setSelected(null)} />
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

function SimpleTable({ headers, rows }: { headers: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="panel overflow-hidden">
      <table className="w-full border-collapse text-[12px]">
        <thead className="bg-slate-900/60 text-left text-[10px] uppercase tracking-wide text-slate-500">
          <tr>
            {headers.map((header) => (
              <th key={header} className="px-3 py-2">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t border-slate-800/70 hover:bg-slate-800/25">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-3 py-2 text-slate-400">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
          {!rows.length ? (
            <tr>
              <td colSpan={headers.length} className="px-3 py-6 text-center text-slate-500">
                nothing here yet
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
