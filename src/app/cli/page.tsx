"use client";

import { useMemo, useState } from "react";
import { apiDelete, apiPost, cls, stripAnsi, timeAgo, TONE_CLASSES, useApi } from "@/lib/client";
import type { CliRunResult, CliToolRecord } from "@/lib/types";

interface HistoryEntry extends CliRunResult {
  id: string;
  at: string;
}

export default function CliConsolePage() {
  const tools = useApi<{ tools: CliToolRecord[] }>("/api/cli-tools", 0);
  const available = useApi<{ available: Record<string, string | null> }>("/api/cli/run?detect=1", 0);
  const [form, setForm] = useState({ binary: "docker", args: "version", cwd: ".", env: "", timeoutMs: "30000" });
  const [result, setResult] = useState<CliRunResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [newTool, setNewTool] = useState({ name: "", binary: "", baseArgs: "", cwd: ".", description: "", category: "custom" });

  const grouped = useMemo(() => {
    const map = new Map<string, CliToolRecord[]>();
    for (const tool of tools.data?.tools ?? []) {
      map.set(tool.category, [...(map.get(tool.category) ?? []), tool]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tools.data]);

  const run = async (input?: { toolId?: string; binary?: string; args?: string }) => {
    setBusy(true);
    setNotice(null);
    try {
      const payload = input?.toolId
        ? { toolId: input.toolId }
        : {
            binary: input?.binary ?? form.binary,
            args: input?.args ?? form.args,
            cwd: form.cwd,
            env: Object.fromEntries(
              form.env
                .split(",")
                .map((pair) => pair.trim())
                .filter(Boolean)
                .map((pair) => {
                  const [key, ...rest] = pair.split("=");
                  return [key, rest.join("=")];
                }),
            ),
            timeoutMs: Number(form.timeoutMs) || 30000,
          };
      const result = await apiPost<CliRunResult>("/api/cli/run", payload);
      setResult(result);
      setHistory((prev) => [{ ...result, id: `${Date.now()}`, at: new Date().toISOString() }, ...prev].slice(0, 25));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "command failed");
    } finally {
      setBusy(false);
    }
  };

  const addTool = async () => {
    try {
      if (!newTool.name || !newTool.binary) throw new Error("name and binary are required");
      await apiPost("/api/cli-tools", newTool);
      setNotice(`saved ${newTool.name}`);
      setNewTool({ name: "", binary: "", baseArgs: "", cwd: ".", description: "", category: "custom" });
      await tools.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "failed to save tool");
    }
  };

  return (
    <div className="grid gap-3 xl:grid-cols-[320px_1fr_300px]">
      <div className="space-y-3">
        <div className="panel p-2">
          <div className="px-1.5 py-1 text-[11px] uppercase tracking-wide text-slate-500">saved commands</div>
          <div className="max-h-[520px] space-y-2 overflow-auto">
            {grouped.map(([category, items]) => (
              <div key={category}>
                <div className="px-1.5 py-1 text-[10px] uppercase tracking-wide text-slate-600">{category}</div>
                <div className="space-y-1">
                  {items.map((tool) => (
                    <div key={tool.id} className="rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[11px] font-medium text-slate-200">{tool.name}</span>
                        <button
                          type="button"
                          onClick={async () => {
                            await fetch("/api/cli-tools", {
                              method: "PATCH",
                              headers: { "content-type": "application/json" },
                              body: JSON.stringify({ id: tool.id, favorite: !tool.favorite }),
                            });
                            await tools.refresh();
                          }}
                          className={cls("ml-auto text-[11px]", tool.favorite ? "text-amber-300" : "text-slate-600 hover:text-amber-300")}
                        >
                          {tool.favorite ? "★" : "☆"}
                        </button>
                        <button
                          type="button"
                          className="text-[10px] text-rose-400 hover:text-rose-300"
                          onClick={async () => {
                            await apiDelete(`/api/cli-tools?id=${tool.id}`);
                            await tools.refresh();
                          }}
                        >
                          del
                        </button>
                      </div>
                      <div className="mono truncate text-[10px] text-slate-500">
                        {tool.binary} {tool.baseArgs}
                      </div>
                      <div className="mt-1 flex gap-1">
                        <button type="button" onClick={() => void run({ toolId: tool.id })} className="chip border-sky-500/40 text-sky-300 hover:border-sky-400">
                          run
                        </button>
                        <button
                          type="button"
                          onClick={() => setForm((prev) => ({ ...prev, binary: tool.binary, args: tool.baseArgs, cwd: tool.cwd }))}
                          className="chip text-slate-400 hover:text-slate-200"
                        >
                          edit args
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {!grouped.length ? <div className="px-2 py-4 text-center text-[11px] text-slate-500">{tools.loading ? "loading…" : "no saved commands"}</div> : null}
          </div>
        </div>

        <div className="panel p-2">
          <div className="px-1.5 py-1 text-[11px] uppercase tracking-wide text-slate-500">add command</div>
          <div className="space-y-1.5">
            {(
              [
                ["name", "name"],
                ["binary", "binary (docker, kubectl, psql…)"],
                ["baseArgs", "arguments"],
                ["cwd", "working directory"],
                ["description", "description"],
              ] as const
            ).map(([key, placeholder]) => (
              <input
                key={key}
                value={newTool[key]}
                placeholder={placeholder}
                onChange={(event) => setNewTool((prev) => ({ ...prev, [key]: event.target.value }))}
                className="mono w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-sky-500"
              />
            ))}
            <button type="button" onClick={() => void addTool()} className="w-full rounded-lg bg-sky-500 px-2 py-1.5 text-[11px] font-semibold text-slate-950">
              save command
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="panel p-3">
          <div className="grid gap-2 md:grid-cols-5">
            <input
              value={form.binary}
              onChange={(event) => setForm((prev) => ({ ...prev, binary: event.target.value }))}
              placeholder="binary"
              className="mono rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-sky-500"
            />
            <input
              value={form.args}
              onChange={(event) => setForm((prev) => ({ ...prev, args: event.target.value }))}
              onKeyDown={(event) => {
                if (event.key === "Enter") void run();
              }}
              placeholder="arguments"
              className="mono rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-sky-500 md:col-span-2"
            />
            <input
              value={form.cwd}
              onChange={(event) => setForm((prev) => ({ ...prev, cwd: event.target.value }))}
              placeholder="cwd"
              className="mono rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-sky-500"
            />
            <button
              type="button"
              onClick={() => void run()}
              disabled={busy}
              className="rounded-lg bg-sky-500 px-3 py-1.5 text-[11px] font-semibold text-slate-950 disabled:opacity-50"
            >
              {busy ? "running…" : "▶ execute"}
            </button>
            <input
              value={form.env}
              onChange={(event) => setForm((prev) => ({ ...prev, env: event.target.value }))}
              placeholder="env K=V, K=V"
              className="mono rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-sky-500 md:col-span-3"
            />
            <input
              value={form.timeoutMs}
              onChange={(event) => setForm((prev) => ({ ...prev, timeoutMs: event.target.value.replace(/[^0-9]/g, "") }))}
              placeholder="timeout ms"
              className="mono rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-sky-500"
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
            {[
              { label: "docker ps", binary: "docker", args: "ps -a" },
              { label: "docker compose ls", binary: "docker", args: "compose ls" },
              { label: "docker system df", binary: "docker", args: "system df" },
              { label: "docker images", binary: "docker", args: "images" },
              { label: "docker context ls", binary: "docker", args: "context ls" },
              { label: "node -v", binary: "node", args: "-v" },
              { label: "git status", binary: "git", args: "status --short" },
              { label: "curl health", binary: "curl", args: "-s http://127.0.0.1:3000/api/health" },
            ].map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => void run({ binary: preset.binary, args: preset.args })}
                className="chip text-slate-400 hover:border-sky-500 hover:text-sky-300"
              >
                {preset.label}
              </button>
            ))}
          </div>
          {notice ? <div className="mt-2 text-[11px] text-rose-300">{notice}</div> : null}
        </div>

        <div className="panel p-3">
          <div className="flex items-center gap-2 text-[11px] text-slate-500">
            <span className="uppercase tracking-wide">output</span>
            {result ? (
              <>
                <span className={cls("chip", result.exitCode === 0 ? "border-emerald-500/40 text-emerald-300" : "border-rose-500/40 text-rose-300")}>
                  exit {result.exitCode ?? "null"}
                </span>
                <span className="chip text-slate-400">{result.durationMs}ms</span>
                {result.truncated ? <span className="chip border-amber-500/40 text-amber-300">truncated</span> : null}
              </>
            ) : null}
          </div>
          <pre className="terminal mt-2 max-h-[420px] overflow-auto rounded-lg p-3">
            {result ? `$ ${result.command}\n${stripAnsi(result.stdout)}${result.stderr ? `\n--- stderr ---\n${stripAnsi(result.stderr)}` : ""}` : "run a command to see its output here"}
          </pre>
        </div>

        <div className="panel p-3">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">history</div>
          <div className="mt-2 space-y-1">
            {history.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setResult(entry)}
                className="flex w-full items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5 text-left text-[11px]"
              >
                <span className={cls("h-1.5 w-1.5 rounded-full", entry.exitCode === 0 ? "bg-emerald-400" : "bg-rose-500")} />
                <span className="mono min-w-0 flex-1 truncate text-slate-300">{entry.command}</span>
                <span className="text-slate-500">{entry.durationMs}ms</span>
                <span className="text-slate-600">{timeAgo(entry.at)}</span>
              </button>
            ))}
            {!history.length ? <div className="py-3 text-center text-[11px] text-slate-500">no commands run in this session</div> : null}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="panel p-3">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">applications on PATH</div>
          <div className="mt-2 space-y-1">
            {Object.entries(available.data?.available ?? {}).map(([binary, version]) => {
              const palette = version ? TONE_CLASSES.good : TONE_CLASSES.idle;
              return (
                <button
                  key={binary}
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, binary, args: "--help" }))}
                  className="flex w-full items-start gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5 text-left text-[11px]"
                >
                  <span className={cls("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", palette.dot)} />
                  <span className="mono w-16 shrink-0 text-slate-300">{binary}</span>
                  <span className="mono min-w-0 flex-1 truncate text-[10px] text-slate-500">{version ?? "not installed"}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="panel p-3 text-[11px] leading-relaxed text-slate-500">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">how this reaches your apps</div>
          <p className="mt-2">
            Commands run as child processes of the console server with a sanitised argv (no shell), a 120s cap and an output budget. That means you can drive{" "}
            <span className="mono text-slate-400">docker</span>, <span className="mono text-slate-400">docker compose</span>,{" "}
            <span className="mono text-slate-400">kubectl</span>, <span className="mono text-slate-400">psql</span>, <span className="mono text-slate-400">terraform</span> and your own
            binaries from here — and from workflow steps.
          </p>
          <p className="mt-2">
            Self-destructive patterns (format, mkfs, shutdown, <span className="mono">rm -rf /</span>) are refused. The container API lives at{" "}
            <span className="mono text-slate-400">/api/docker/*</span> and agent telemetry at <span className="mono text-slate-400">/api/apm/ingest</span>.
          </p>
        </div>
      </div>
    </div>
  );
}
