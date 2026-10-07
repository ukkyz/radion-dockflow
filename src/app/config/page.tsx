"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import MapCanvas, { type CanvasNode } from "@/components/MapCanvas";
import { AreaChart, StatTile } from "@/components/Charts";
import { apiDelete, apiPost, cls, timeAgo, TONE_CLASSES, useApi } from "@/lib/client";

/* ------------------------------- types ------------------------------- */

interface ConfigNodeModel {
  id: string;
  title: string;
  subtitle?: string;
  kind: string;
  parentId: string | null;
  status: string;
  badge?: string;
  accent?: string;
  agg?: { label: string; value: string; tone?: string }[];
  meta?: string[];
  detail?: Record<string, unknown>;
}

interface ConfigEdgeModel {
  id: string;
  source: string;
  target: string;
  label?: string;
  tone?: string;
  animated?: boolean;
}

interface Finding {
  level: "error" | "warn" | "info";
  message: string;
  path?: string;
}

interface ParseResponse {
  model: {
    kind: "compose" | "terraform";
    nodes: ConfigNodeModel[];
    edges: ConfigEdgeModel[];
    findings: Finding[];
    file?: string;
    projectName?: string;
    files?: string[];
    stats: Record<string, unknown>;
    services?: {
      name: string;
      image: string | null;
      build: { context: string; dockerfile?: string; target?: string; args: number } | null;
      ports: { published: string; target: string; protocol: string }[];
      volumes: { source: string; target: string; mode?: string; type: string }[];
      networks: { name: string; aliases: string[]; ipv4?: string }[];
      dependsOn: { name: string; condition?: string }[];
      healthcheck: { test: string[]; interval?: string; retries?: number } | null;
      restart: string | null;
      deploy: { replicas?: number; cpus?: string; memory?: string } | null;
      environment: { key: string; value: string; interpolated: boolean }[];
      profiles: string[];
    }[];
    networks?: { name: string; driver: string; internal: boolean; usedBy: string[] }[];
    volumes?: { name: string; external: boolean; usedBy: string[] }[];
    resources?: { address: string; type: string; provider: string; attributes: number; dependsOn: string[]; dependents: string[]; countExpression: string | null; forEach: string | null }[];
    variables?: { name: string; type: string; default: string | null; description: string | null; sensitive: boolean; used: number; usedBy: string[] }[];
    outputs?: { name: string; value: string; description: string | null; sensitive: boolean; resolved: boolean }[];
    providers?: { name: string; region: string | null; version: string | null; resources: number }[];
    modules?: { name: string; source: string; version?: string }[];
    charts?: { key: string; label: string; value: number; tone: string }[];
  };
  kind: string;
  files: { path: string; relative: string; kind: string; sizeKb: number; modified: string }[];
}

interface SavedSource {
  id: string;
  name: string;
  kind: string;
  target: string;
  status: string;
  sizeKb: number;
  lastLoadedAt: string | null;
  summary: Record<string, unknown>;
}

interface GithubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  author: string;
  updatedAt: string;
  comments: number;
  labels: { name: string; color: string }[];
  assignees: string[];
  milestone: string | null;
  body: string;
  isPullRequest: boolean;
  references: number[];
}

interface GithubModel {
  kind: "github";
  mode: "live" | "simulated";
  repo: {
    fullName: string;
    description: string | null;
    stars: number;
    forks: number;
    watchers: number;
    openIssues: number;
    sizeMb: number;
    language: string | null;
    license: string | null;
    topics: string[];
    defaultBranch: string;
    pushedAt: string;
    archived: boolean;
    htmlUrl: string;
  };
  languages: { name: string; bytes: number; pct: number }[];
  contributors: { login: string; contributions: number }[];
  commitActivity: { week: string; commits: number }[];
  recentCommits: { sha: string; message: string; author: string; date: string }[];
  issues: GithubIssue[];
  nodes: ConfigNodeModel[];
  edges: ConfigEdgeModel[];
  findings: Finding[];
  stats: Record<string, number>;
  labelBreakdown: { label: string; color: string; total: number; open: number }[];
  requestInfo: { token: boolean; remaining: number | null; limit: number | null; reachable: boolean; error: string | null };
}

interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  sizeKb: number | null;
  language: string | null;
  htmlUrl: string | null;
}

const TABS = ["compose", "terraform", "github"] as const;
type Tab = (typeof TABS)[number];

const LEVEL_TONE: Record<Finding["level"], string> = { error: "bad", warn: "warn", info: "idle" };

/* ------------------------------- page ------------------------------- */

export default function ConfigPage() {
  const [tab, setTab] = useState<Tab>("compose");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<ConfigNodeModel | null>(null);
  const [findingsFilter, setFindingsFilter] = useState<"all" | Finding["level"]>("all");

  /* compose */
  const [composePath, setComposePath] = useState("samples/docker-compose.yml");
  const [composeContent, setComposeContent] = useState("");
  const [composeModel, setComposeModel] = useState<ParseResponse["model"] | null>(null);
  const [composeView, setComposeView] = useState<"graph" | "table">("graph");

  /* terraform */
  const [tfPath, setTfPath] = useState("samples/infra/main.tf");
  const [tfModel, setTfModel] = useState<ParseResponse["model"] | null>(null);
  const [tfView, setTfView] = useState<"graph" | "table">("graph");

  /* github */
  const [repoInput, setRepoInput] = useState("vercel/next.js");
  const [githubModel, setGithubModel] = useState<GithubModel | null>(null);
  const [githubView, setGithubView] = useState<"issues" | "tree" | "overview">("issues");
  const [treeChildren, setTreeChildren] = useState<Record<string, TreeEntry[]>>({});
  const [treeLoaded, setTreeLoaded] = useState<Set<string>>(new Set());
  const [filePreview, setFilePreview] = useState<{ path: string; content: string; mode: string; sizeKb: number } | null>(null);
  const [issueDetail, setIssueDetail] = useState<GithubIssue | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);

  const discovered = useApi<{ files: ParseResponse["files"]; root: string; counts: { compose: number; terraform: number; total: number } }>("/radion/api/config/parse", 0);
  const saved = useApi<{ sources: SavedSource[] }>("/radion/api/config/sources", 0);

  /* ---------------- loaders ---------------- */

  const loadCompose = useCallback(
    async (input: { path?: string; content?: string; save?: boolean }) => {
      setBusy("compose");
      setNotice(null);
      try {
        const result = await apiPost<ParseResponse>("/radion/api/config/parse", { kind: "compose", ...input });
        setComposeModel(result.model);
        if (input.content !== undefined) setComposeContent(input.content);
        if (result.files.length) await discovered.refresh();
        const errors = result.model.findings.filter((finding) => finding.level === "error").length;
        setNotice(`compose parsed: ${result.model.nodes.length} nodes · ${result.model.findings.length} findings${errors ? ` (${errors} errors)` : ""}`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "failed to parse compose file");
      } finally {
        setBusy(null);
      }
    },
    [discovered],
  );

  const loadTerraform = useCallback(
    async (input: { path?: string; content?: string; name?: string }) => {
      setBusy("terraform");
      setNotice(null);
      try {
        const result = await apiPost<ParseResponse>("/radion/api/config/parse", { kind: "terraform", ...input });
        setTfModel(result.model);
        if (result.files.length) await discovered.refresh();
        setNotice(`terraform parsed: ${result.model.files?.length ?? 1} file(s) · ${result.model.nodes.length} nodes · ${result.model.findings.length} findings`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "failed to parse terraform");
      } finally {
        setBusy(null);
      }
    },
    [discovered],
  );

  const loadGithub = useCallback(async (repo: string) => {
    setBusy("github");
    setNotice(null);
    setTreeChildren({});
    setTreeLoaded(new Set());
    setFilePreview(null);
    try {
      const result = await apiPost<{ model: GithubModel }>("/radion/api/config/parse", { kind: "github", repo });
      setGithubModel(result.model);
      setNotice(
        result.model.mode === "live"
          ? `loaded ${result.model.repo.fullName} from the GitHub API (${result.model.stats.issuesOpen} open issues · ${result.model.stats.issueLinks} issue links)`
          : `GitHub unreachable — using the simulated fixture for ${result.model.repo.fullName}`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "failed to load repository");
    } finally {
      setBusy(null);
    }
  }, []);

  const loadTreeDir = useCallback(
    async (dirPath: string) => {
      if (!githubModel) return;
      try {
        const res = await fetch(`/radion/api/config/github/tree?repo=${encodeURIComponent(githubModel.repo.fullName)}&path=${encodeURIComponent(dirPath)}`, { cache: "no-store" });
        const json = (await res.json()) as { ok: boolean; data?: { directory: { entries: TreeEntry[]; error: string | null } }; error?: string };
        if (!json.ok || !json.data) throw new Error(json.error ?? "tree request failed");
        setTreeChildren((prev) => ({ ...prev, [dirPath]: json.data!.directory.entries }));
        setTreeLoaded((prev) => new Set(prev).add(dirPath));
        setTreeError(json.data.directory.error);
      } catch (error) {
        setTreeError(error instanceof Error ? error.message : "tree request failed");
      }
    },
    [githubModel],
  );

  const openFile = useCallback(
    async (filePath: string) => {
      if (!githubModel) return;
      setBusy(`file:${filePath}`);
      try {
        const res = await fetch(`/radion/api/config/github/tree?repo=${encodeURIComponent(githubModel.repo.fullName)}&path=${encodeURIComponent(filePath)}&file=1`, { cache: "no-store" });
        const json = (await res.json()) as { ok: boolean; data?: { file: { path: string; content: string; mode: string; sizeKb: number } }; error?: string };
        if (!json.ok || !json.data) throw new Error(json.error ?? "file request failed");
        setFilePreview(json.data.file);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "failed to open file");
      } finally {
        setBusy(null);
      }
    },
    [githubModel],
  );

  useEffect(() => {
    void loadCompose({ path: "samples/docker-compose.yml" });
    void loadTerraform({ path: "samples/infra/main.tf" });
    void loadGithub("vercel/next.js");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- derived ---------------- */

  const findings = (tab === "compose" ? composeModel?.findings : tab === "terraform" ? tfModel?.findings : githubModel?.findings) ?? [];
  const filteredFindings = findingsFilter === "all" ? findings : findings.filter((finding) => finding.level === findingsFilter);

  const activeNodes = tab === "compose" ? composeModel?.nodes : tab === "terraform" ? tfModel?.nodes : githubModel?.nodes;
  const activeEdges = tab === "compose" ? composeModel?.edges : tab === "terraform" ? tfModel?.edges : githubModel?.edges;

  const canvasNodes: CanvasNode[] = useMemo(
    () =>
      (activeNodes ?? []).map((node) => ({
        id: node.id,
        title: node.title,
        subtitle: node.subtitle,
        kind: node.kind,
        parentId: node.parentId,
        status: node.status === "ready" ? "up" : node.status,
        accent: node.accent,
        badge: node.badge,
        agg: node.agg,
        meta: node.meta,
        tone: node.status === "degraded" ? "alert" : "normal",
      })),
    [activeNodes],
  );

  const canvasEdges = useMemo(
    () =>
      (activeEdges ?? []).map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, label: edge.label, tone: edge.tone ?? "idle", animated: edge.animated })),
    [activeEdges],
  );

  /** Lazily-expanded repository tree rendered through the same canvas. */
  const treeNodes: CanvasNode[] = useMemo(() => {
    if (!githubModel) return [];
    if (githubView !== "tree") return [];
    const nodes: CanvasNode[] = [
      {
        id: "repo-root",
        title: githubModel.repo.fullName,
        subtitle: `${githubModel.repo.defaultBranch} · ${githubModel.repo.sizeMb} MB`,
        kind: "project",
        parentId: null,
        status: "running",
        accent: "#8b5cf6",
        badge: githubModel.mode === "live" ? "github" : "fixture",
      },
    ];
    const walk = (parentId: string, parentPath: string, depth: number) => {
      if (depth > 6) return;
      for (const entry of treeChildren[parentPath] ?? []) {
        const id = `tree:${entry.path}`;
        const loaded = treeLoaded.has(entry.path);
        const childCount = (treeChildren[entry.path] ?? []).length;
        nodes.push({
          id,
          title: entry.name,
          subtitle: entry.type === "dir" ? (loaded ? `${childCount} entries` : "not loaded") : `${entry.sizeKb ?? 0} KB${entry.language ? ` · ${entry.language}` : ""}`,
          kind: entry.type === "dir" ? "project" : entry.language === "HCL" ? "service" : "image",
          parentId,
          status: "running",
          accent: entry.type === "dir" ? "#38bdf8" : entry.language === "TypeScript" ? "#3178c6" : entry.language === "HCL" ? "#844FBA" : "#64748b",
          badge: entry.type === "dir" ? (loaded ? "loaded" : "dir") : entry.language ?? "file",
          agg: entry.type === "dir" ? [] : [{ label: "size", value: `${entry.sizeKb ?? 0} KB`, tone: "idle" }],
        });
        if (entry.type === "dir") walk(id, entry.path, depth + 1);
      }
    };
    walk("repo-root", "", 0);
    return nodes;
  }, [githubModel, githubView, treeChildren, treeLoaded]);

  const treeEdges = useMemo(
    () => treeNodes.filter((node) => node.parentId).map((node) => ({ id: `e:${node.parentId}->${node.id}`, source: node.parentId as string, target: node.id, tone: "idle" as const })),
    [treeNodes],
  );

  /** GitHub issues are clickable: selecting one opens the issue drawer. */
  const onSelectNode = useCallback(
    (node: CanvasNode | null) => {
      if (!node) {
        setSelected(null);
        setIssueDetail(null);
        return;
      }
      if (githubModel && tab === "github" && githubView === "issues") {
        const match = /^gh:issue:(\d+)$/.exec(node.id);
        if (match) {
          setIssueDetail(githubModel.issues.find((issue) => issue.number === Number(match[1])) ?? null);
          setSelected(null);
          return;
        }
      }
      if (githubModel && tab === "github" && githubView === "tree") {
        const entry = node.id.startsWith("tree:") ? node.id.slice(5) : null;
        if (entry) {
          const isDir = /\/(?:[^/]+)$/.test(entry) ? (treeChildren[entry] ? true : (treeChildren[""] ?? []).concat(Object.values(treeChildren).flat()).some((item) => item.path === entry && item.type === "dir")) : false;
          if (isDir) {
            if (!treeLoaded.has(entry)) void loadTreeDir(entry);
          } else {
            void openFile(entry);
          }
          return;
        }
      }
      const match = (activeNodes ?? []).find((item) => item.id === node.id) ?? null;
      setSelected(match);
    },
    [activeNodes, githubModel, tab, githubView, treeChildren, treeLoaded, loadTreeDir, openFile],
  );

  const toggleTree = useCallback(
    (node: CanvasNode, expanded: boolean) => {
      if (tab !== "github" || githubView !== "tree") return;
      const path = node.id === "repo-root" ? "" : node.id.startsWith("tree:") ? node.id.slice(5) : null;
      if (path === null) return;
      if (expanded && !treeLoaded.has(path)) void loadTreeDir(path);
    },
    [tab, githubView, treeLoaded, loadTreeDir],
  );

  const saveCurrent = async () => {
    if (tab === "compose" && composeModel) {
      await apiPost("/radion/api/config/sources", {
        name: composeModel.file ?? "compose",
        kind: "compose",
        target: composeModel.file ?? "",
        content: composeContent,
        summary: { stats: composeModel.stats, findings: composeModel.findings.length },
        status: composeModel.findings.some((finding) => finding.level === "error") ? "error" : "ready",
      });
    }
    if (tab === "terraform" && tfModel) {
      await apiPost("/radion/api/config/sources", {
        name: tfModel.files?.join(", ") ?? "terraform",
        kind: "terraform",
        target: tfPath,
        content: "",
        summary: { stats: tfModel.stats, findings: tfModel.findings.length },
        status: tfModel.findings.some((finding) => finding.level === "error") ? "error" : "ready",
      });
    }
    if (tab === "github" && githubModel) {
      await apiPost("/radion/api/config/sources", {
        name: githubModel.repo.fullName,
        kind: "github",
        target: githubModel.repo.fullName,
        content: "",
        summary: { stats: githubModel.stats, mode: githubModel.mode },
        status: "ready",
      });
    }
    setNotice("source saved to the SQLite registry");
    await saved.refresh();
  };

  return (
    <div className="space-y-3">
      <div className="panel flex flex-wrap items-center gap-2 px-3 py-2.5">
        <div>
          <div className="text-sm font-semibold text-slate-100">Configuration &amp; repository visualizer</div>
          <div className="text-[11px] text-slate-500">
            Parse docker-compose.yml and terraform HCL into expandable graphs, and map a GitHub repository&apos;s files, issues and cross-references.
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5 text-[11px]">
          {TABS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => {
                setTab(item);
                setSelected(null);
                setIssueDetail(null);
              }}
              className={cls("rounded-lg px-2.5 py-1 transition", tab === item ? "bg-sky-500/15 text-sky-300" : "text-slate-400 hover:text-slate-200")}
            >
              {item === "github" ? "github repo & issues" : item}
            </button>
          ))}
          <button type="button" onClick={() => void saveCurrent()} className="chip border-sky-500/50 bg-sky-500/10 text-sky-300">
            save source
          </button>
        </div>
      </div>

      {notice ? <div className="panel border-sky-500/40 px-3 py-2 text-[12px] text-sky-300">{notice}</div> : null}

      {/* ------------------------- COMPOSE ------------------------- */}
      {tab === "compose" ? (
        <>
          <div className="panel flex flex-wrap items-center gap-2 px-3 py-2">
            <select
              value={composePath}
              onChange={(event) => {
                setComposePath(event.target.value);
                if (event.target.value) void loadCompose({ path: event.target.value });
              }}
              className="mono max-w-[320px] rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-200"
            >
              {(discovered.data?.files ?? []).filter((file) => file.kind === "compose").length ? null : <option value="samples/docker-compose.yml">samples/docker-compose.yml (loaded from disk)</option>}
              {(discovered.data?.files ?? [])
                .filter((file) => file.kind === "compose")
                .map((file) => (
                  <option key={file.path} value={file.path}>
                    {file.relative} · {file.sizeKb} KB
                  </option>
                ))}
            </select>
            <button type="button" disabled={busy !== null} onClick={() => void loadCompose({ content: composeContent || undefined, path: composePath })} className="chip border-sky-500/50 text-sky-300 disabled:opacity-40">
              {busy === "compose" ? "parsing…" : "re-parse file"}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => void loadCompose({ content: composeContent, path: "pasted/docker-compose.yml" })} className="chip text-slate-300 hover:border-sky-500 disabled:opacity-40">
              parse editor
            </button>
            <div className="ml-auto flex gap-1 text-[11px]">
              {(["graph", "table"] as const).map((mode) => (
                <button key={mode} type="button" onClick={() => setComposeView(mode)} className={cls("rounded-lg px-2 py-1", composeView === mode ? "bg-sky-500/15 text-sky-300" : "text-slate-400 hover:text-slate-200")}>
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {composeModel ? (
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <StatTile label="services" value={String(composeModel.stats.services ?? 0)} hint={`${composeModel.stats.buildableServices ?? 0} built locally`} />
              <StatTile label="published ports" value={String(composeModel.stats.publishedPorts ?? 0)} hint={`${composeModel.stats.images ?? 0} distinct images`} />
              <StatTile label="volumes" value={String(composeModel.stats.namedVolumes ?? 0)} hint={`${composeModel.stats.bindMounts ?? 0} bind mounts`} />
              <StatTile label="networks" value={String(composeModel.stats.networks ?? 0)} hint={(composeModel.stats.profiles as string[] | undefined)?.length ? `profiles: ${(composeModel.stats.profiles as string[]).join(",")}` : "no profiles"} />
              <StatTile label="replicas" value={String(composeModel.stats.deployReplicas ?? 0)} hint={`${composeModel.stats.healthchecked ?? 0} healthchecks`} />
              <StatTile label="findings" value={String(findings.length)} tone={findings.some((finding) => finding.level === "error") ? "bad" : findings.length ? "warn" : "good"} hint={`${findings.filter((finding) => finding.level === "error").length} errors`} />
            </div>
          ) : null}

          <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
            <div className="panel p-3">
              {composeView === "graph" ? (
                <>
                  <div className="mb-2 flex items-center gap-2 text-[11px] text-slate-500">
                    <span>project → services → ports / volumes / env / networks / healthchecks (expand per node)</span>
                  </div>
                  <MapCanvas nodes={canvasNodes} edges={canvasEdges} layout="tree" defaultExpandDepth={2} onSelect={onSelectNode} height="600px" legend={[{ label: "service", tone: "#34d399" }, { label: "built locally", tone: "#a855f7" }, { label: "dependency edge", tone: "#fbbf24" }]} />
                </>
              ) : (
                <div className="max-h-[600px] space-y-2 overflow-auto">
                  {(composeModel?.services ?? []).map((service) => (
                    <div key={service.name} className="rounded-lg border border-slate-800 bg-slate-950/40 p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[12px] font-semibold text-slate-100">{service.name}</span>
                        <span className="mono text-[10px] text-slate-500">{service.image ?? `${service.build?.context} (build)`}</span>
                        {service.profiles.length ? <span className="chip text-slate-400">profile {service.profiles.join(",")}</span> : null}
                        {service.restart ? <span className="chip text-slate-400">restart: {service.restart}</span> : null}
                        {service.deploy?.replicas ? <span className="chip text-sky-300">{service.deploy.replicas} replicas</span> : null}
                      </div>
                      <div className="mt-1.5 grid gap-1 text-[10px] sm:grid-cols-2 lg:grid-cols-3">
                        <Cell title="ports" values={service.ports.map((port) => `${port.published || "random"}:${port.target}/${port.protocol}`)} />
                        <Cell title="depends_on" values={service.dependsOn.map((dep) => `${dep.name}${dep.condition ? ` (${dep.condition})` : ""}`)} />
                        <Cell title="networks" values={service.networks.map((net) => `${net.name}${net.ipv4 ? ` @${net.ipv4}` : ""}`)} />
                        <Cell title="volumes" values={service.volumes.map((volume) => `${volume.source}:${volume.target} (${volume.type})`)} />
                        <Cell title="environment" values={service.environment.map((entry) => `${entry.key}=${entry.value}${entry.interpolated ? " *" : ""}`)} />
                        <Cell title="healthcheck" values={service.healthcheck ? [service.healthcheck.test.join(" "), `interval ${service.healthcheck.interval ?? "30s"}`, `retries ${service.healthcheck.retries ?? 3}`] : []} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div className="panel p-3">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] uppercase tracking-wide text-slate-500">findings</span>
                  <div className="ml-auto flex gap-1 text-[10px]">
                    {(["all", "error", "warn", "info"] as const).map((level) => (
                      <button key={level} type="button" onClick={() => setFindingsFilter(level)} className={cls("rounded px-1.5 py-0.5", findingsFilter === level ? "bg-sky-500/15 text-sky-300" : "text-slate-400 hover:text-slate-200")}>
                        {level}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mt-2 max-h-[260px] space-y-1 overflow-auto">
                  {filteredFindings.map((finding, index) => {
                    const palette = TONE_CLASSES[LEVEL_TONE[finding.level]] ?? TONE_CLASSES.idle;
                    return (
                      <div key={`${finding.message}-${index}`} className={cls("rounded-lg border px-2 py-1.5 text-[11px]", palette.border, palette.bg)}>
                        <div className="flex items-start gap-2">
                          <span className={cls("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", palette.dot)} />
                          <div className="min-w-0">
                            <div className="text-slate-200">{finding.message}</div>
                            {finding.path ? <div className="mono text-[10px] text-slate-500">{finding.path}</div> : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {!filteredFindings.length ? <div className="py-4 text-center text-[11px] text-slate-500">no findings at this level — the compose file looks clean</div> : null}
                </div>
              </div>

              <div className="panel p-3">
                <div className="text-[11px] uppercase tracking-wide text-slate-500">compose editor</div>
                <textarea
                  value={composeContent}
                  onChange={(event) => setComposeContent(event.target.value)}
                  placeholder="paste docker-compose.yml here, then press “parse editor”"
                  spellCheck={false}
                  className="mono mt-2 h-[260px] w-full resize-y rounded-lg border border-slate-800 bg-[#04070f] p-2 text-[11px] text-slate-200 outline-none focus:border-sky-600"
                />
              </div>

              <div className="panel p-3">
                <div className="text-[11px] uppercase tracking-wide text-slate-500">saved sources</div>
                <div className="mt-2 space-y-1">
                  {(saved.data?.sources ?? []).slice(0, 8).map((source) => (
                    <div key={source.id} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5 text-[11px]">
                      <span className={cls("chip", source.status === "error" ? "border-rose-500/40 text-rose-300" : "border-emerald-500/40 text-emerald-300")}>{source.kind}</span>
                      <span className="truncate text-slate-300">{source.name}</span>
                      <span className="ml-auto text-[10px] text-slate-600">{source.lastLoadedAt ? timeAgo(source.lastLoadedAt) : "—"}</span>
                      <button type="button" className="text-[10px] text-rose-400 hover:text-rose-300" onClick={async () => { await apiDelete(`/radion/api/config/sources?id=${source.id}`); await saved.refresh(); }}>
                        del
                      </button>
                    </div>
                  ))}
                  {!saved.data?.sources.length ? <div className="py-3 text-center text-[11px] text-slate-500">nothing saved yet</div> : null}
                </div>
                <div className="mt-2 text-[10px] text-slate-600">workspace scan: {discovered.data?.counts.compose ?? 0} compose · {discovered.data?.counts.terraform ?? 0} terraform files under {discovered.data?.root ?? "…"}</div>
              </div>
            </div>
          </div>
        </>
      ) : null}

      {/* ------------------------- TERRAFORM ------------------------- */}
      {tab === "terraform" ? (
        <>
          <div className="panel flex flex-wrap items-center gap-2 px-3 py-2">
            <select
              value={tfPath}
              onChange={(event) => {
                setTfPath(event.target.value);
                if (event.target.value) void loadTerraform({ path: event.target.value });
              }}
              className="mono max-w-[320px] rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-200"
            >
              {(discovered.data?.files ?? [])
                .filter((file) => file.kind === "terraform" && file.relative.endsWith(".tf"))
                .map((file) => (
                  <option key={file.path} value={file.path}>
                    {file.relative} · {file.sizeKb} KB
                  </option>
                ))}
            </select>
            <button type="button" disabled={busy !== null} onClick={() => void loadTerraform({ path: tfPath })} className="chip border-sky-500/50 text-sky-300 disabled:opacity-40">
              {busy === "terraform" ? "parsing…" : "re-parse module dir"}
            </button>
            <span className="text-[10px] text-slate-500">a module directory is parsed as a whole (all sibling .tf files)</span>
            <div className="ml-auto flex gap-1 text-[11px]">
              {(["graph", "table"] as const).map((mode) => (
                <button key={mode} type="button" onClick={() => setTfView(mode)} className={cls("rounded-lg px-2 py-1", tfView === mode ? "bg-sky-500/15 text-sky-300" : "text-slate-400 hover:text-slate-200")}>
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {tfModel ? (
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <StatTile label="resources" value={String(tfModel.stats.resources ?? 0)} hint={`${tfModel.stats.dataSources ?? 0} data sources`} />
              <StatTile label="modules" value={String(tfModel.stats.modules ?? 0)} hint={`${tfModel.stats.blocks ?? 0} blocks total`} />
              <StatTile label="variables" value={String(tfModel.stats.variables ?? 0)} hint={`${(tfModel.variables ?? []).filter((variable) => variable.used === 0).length} unused`} />
              <StatTile label="outputs" value={String(tfModel.stats.outputs ?? 0)} hint={`${(tfModel.outputs ?? []).filter((output) => !output.resolved).length} unresolved`} />
              <StatTile label="references" value={String(tfModel.stats.references ?? 0)} hint={`${tfModel.stats.lines ?? 0} lines parsed`} />
              <StatTile label="findings" value={String(findings.length)} tone={findings.some((finding) => finding.level === "error") ? "bad" : findings.length ? "warn" : "good"} hint={`${findings.filter((finding) => finding.level === "error").length} errors`} />
            </div>
          ) : null}

          <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
            <div className="panel p-3">
              {tfView === "graph" ? (
                <MapCanvas
                  nodes={canvasNodes}
                  edges={canvasEdges}
                  layout="tree"
                  defaultExpandDepth={2}
                  onSelect={onSelectNode}
                  height="620px"
                  legend={[
                    { label: "managed resource", tone: "#22c55e" },
                    { label: "data source", tone: "#f59e0b" },
                    { label: "dependency edge", tone: "#38bdf8" },
                  ]}
                />
              ) : (
                <div className="max-h-[620px] space-y-2 overflow-auto">
                  {(tfModel?.resources ?? []).map((resource) => (
                    <div key={resource.address} className="rounded-lg border border-slate-800 bg-slate-950/40 p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="mono text-[12px] text-slate-100">{resource.address}</span>
                        <span className="chip text-slate-400">{resource.provider}</span>
                        {resource.countExpression ? <span className="chip text-sky-300">count = {resource.countExpression}</span> : null}
                        {resource.forEach ? <span className="chip text-purple-300">for_each = {resource.forEach}</span> : null}
                        <span className="chip text-slate-500">{resource.attributes} attributes</span>
                      </div>
                      <div className="mt-1.5 grid gap-1 text-[10px] sm:grid-cols-2">
                        <Cell title="depends on" values={resource.dependsOn} />
                        <Cell title="referenced by" values={resource.dependents} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div className="panel p-3">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] uppercase tracking-wide text-slate-500">findings</span>
                  <div className="ml-auto flex gap-1 text-[10px]">
                    {(["all", "error", "warn", "info"] as const).map((level) => (
                      <button key={level} type="button" onClick={() => setFindingsFilter(level)} className={cls("rounded px-1.5 py-0.5", findingsFilter === level ? "bg-sky-500/15 text-sky-300" : "text-slate-400 hover:text-slate-200")}>
                        {level}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="mt-2 max-h-[240px] space-y-1 overflow-auto">
                  {filteredFindings.map((finding, index) => {
                    const palette = TONE_CLASSES[LEVEL_TONE[finding.level]] ?? TONE_CLASSES.idle;
                    return (
                      <div key={`${finding.message}-${index}`} className={cls("rounded-lg border px-2 py-1.5 text-[11px]", palette.border, palette.bg)}>
                        <div className="flex items-start gap-2">
                          <span className={cls("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", palette.dot)} />
                          <div className="min-w-0">
                            <div className="text-slate-200">{finding.message}</div>
                            {finding.path ? <div className="mono text-[10px] text-slate-500">{finding.path}</div> : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {!filteredFindings.length ? <div className="py-4 text-center text-[11px] text-slate-500">no findings at this level</div> : null}
                </div>
              </div>

              <div className="panel p-3">
                <div className="text-[11px] uppercase tracking-wide text-slate-500">module inventory</div>
                <div className="mt-2 space-y-1 text-[11px]">
                  {(tfModel?.modules ?? []).map((module) => (
                    <div key={module.name} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5">
                      <span className="text-slate-200">{module.name}</span>
                      <span className="mono truncate text-[10px] text-slate-500">{module.source}</span>
                      {module.version ? <span className="chip text-slate-400">v{module.version}</span> : null}
                    </div>
                  ))}
                  {(tfModel?.providers ?? []).map((provider) => (
                    <div key={provider.name} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5">
                      <span className="text-slate-200">provider {provider.name}</span>
                      <span className="text-[10px] text-slate-500">{provider.region ?? "no region"}</span>
                      {provider.version ? <span className="chip text-slate-400">~&gt; {provider.version}</span> : null}
                      <span className="chip ml-auto text-slate-400">{provider.resources}</span>
                    </div>
                  ))}
                  {!tfModel?.modules?.length && !tfModel?.providers?.length ? <div className="py-3 text-center text-[11px] text-slate-500">no modules or providers detected</div> : null}
                </div>
              </div>

              <div className="panel p-3">
                <div className="text-[11px] uppercase tracking-wide text-slate-500">variables &amp; outputs</div>
                <div className="mt-2 max-h-[220px] space-y-1 overflow-auto text-[11px]">
                  {(tfModel?.variables ?? []).map((variable) => (
                    <div key={variable.name} className="flex items-center gap-2">
                      <span className={cls("h-1.5 w-1.5 rounded-full", variable.used === 0 ? "bg-rose-500" : variable.sensitive ? "bg-amber-400" : "bg-emerald-400")} />
                      <span className="mono w-36 truncate text-slate-300">var.{variable.name}</span>
                      <span className="truncate text-[10px] text-slate-500">{variable.type} · {variable.default ?? "required"}</span>
                      <span className="chip ml-auto text-slate-500">{variable.used} refs</span>
                    </div>
                  ))}
                  {(tfModel?.outputs ?? []).map((output) => (
                    <div key={output.name} className="flex items-center gap-2">
                      <span className={cls("h-1.5 w-1.5 rounded-full", output.resolved ? "bg-sky-400" : "bg-rose-500")} />
                      <span className="mono w-36 truncate text-slate-300">output.{output.name}</span>
                      <span className="mono truncate text-[10px] text-slate-500">{output.value}</span>
                      {output.sensitive ? <span className="chip text-amber-300">sensitive</span> : null}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      ) : null}

      {/* ------------------------- GITHUB ------------------------- */}
      {tab === "github" ? (
        <>
          <div className="panel flex flex-wrap items-center gap-2 px-3 py-2">
            <input
              value={repoInput}
              onChange={(event) => setRepoInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void loadGithub(repoInput);
              }}
              placeholder="owner/name or https://github.com/owner/name"
              className="mono w-[320px] rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-sky-500"
            />
            <button type="button" disabled={busy !== null} onClick={() => void loadGithub(repoInput)} className="chip border-sky-500/50 bg-sky-500/10 text-sky-300 disabled:opacity-40">
              {busy === "github" ? "loading…" : "load repository"}
            </button>
            <button type="button" onClick={() => { setRepoInput("microsoft/vscode"); void loadGithub("microsoft/vscode"); }} className="chip text-slate-400 hover:border-sky-500">
              microsoft/vscode
            </button>
            <button type="button" onClick={() => { setRepoInput("facebook/react"); void loadGithub("facebook/react"); }} className="chip text-slate-400 hover:border-sky-500">
              facebook/react
            </button>
            {githubModel ? (
              <>
                <span className={cls("chip", githubModel.mode === "live" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-amber-500/40 bg-amber-500/10 text-amber-300")}>
                  {githubModel.mode === "live" ? "live github api" : "simulated fixture"}
                </span>
                <span className="chip text-slate-500">
                  {githubModel.requestInfo.token ? "token set" : "no GITHUB_TOKEN"} · {githubModel.requestInfo.remaining ?? "?"} / {githubModel.requestInfo.limit ?? "?"} calls left
                </span>
                <div className="ml-auto flex gap-1 text-[11px]">
                  {(["issues", "tree", "overview"] as const).map((mode) => (
                    <button key={mode} type="button" onClick={() => { setGithubView(mode); setSelected(null); setIssueDetail(null); }} className={cls("rounded-lg px-2 py-1", githubView === mode ? "bg-sky-500/15 text-sky-300" : "text-slate-400 hover:text-slate-200")}>
                      {mode === "tree" ? "file tree" : mode}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>

          {githubModel ? (
            <>
              <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <StatTile label="stars" value={githubModel.repo.stars >= 1000 ? `${(githubModel.repo.stars / 1000).toFixed(1)}k` : String(githubModel.repo.stars)} hint={`${githubModel.repo.forks} forks · ${githubModel.repo.watchers} watchers`} />
                <StatTile label="open issues" value={String(githubModel.stats.issuesOpen)} tone={githubModel.stats.staleIssues > 3 ? "warn" : "good"} hint={`${githubModel.stats.issuesClosed} closed · ${githubModel.stats.pullRequests} PRs`} />
                <StatTile label="stale (>60d)" value={String(githubModel.stats.staleIssues)} tone={githubModel.stats.staleIssues ? "warn" : "good"} hint={`${githubModel.stats.unassigned} unassigned`} />
                <StatTile label="issue links" value={String(githubModel.stats.issueLinks)} hint={`${githubModel.stats.labelCount} labels · ${githubModel.stats.milestones} milestones`} />
                <StatTile label="size / language" value={`${githubModel.repo.sizeMb} MB`} hint={`${githubModel.repo.language ?? "unknown"} · ${githubModel.repo.license ?? "no license"}`} />
                <StatTile label="last push" value={timeAgo(githubModel.repo.pushedAt)} hint={`branch ${githubModel.repo.defaultBranch}`} />
              </div>

              <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
                <div className="panel p-3">
                  {githubView === "issues" ? (
                    <MapCanvas
                      nodes={canvasNodes}
                      edges={canvasEdges}
                      layout="tree"
                      defaultExpandDepth={1}
                      onSelect={onSelectNode}
                      height="620px"
                      legend={[
                        { label: "open", tone: "#34d399" },
                        { label: "closed", tone: "#a855f7" },
                        { label: "cross-reference edge", tone: "#fbbf24" },
                      ]}
                    />
                  ) : null}
                  {githubView === "tree" ? (
                    <>
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                        <span>lazy-loaded directory tree — expanding a folder fetches it from the GitHub contents API</span>
                        {treeError ? <span className="text-amber-400/80">{treeError}</span> : null}
                        <button type="button" onClick={() => void loadTreeDir("")} className="chip ml-auto text-slate-400 hover:border-sky-500">
                          load root
                        </button>
                      </div>
                      <MapCanvas
                        nodes={treeNodes}
                        edges={treeEdges}
                        layout="tree"
                        defaultExpandDepth={1}
                        onSelect={onSelectNode}
                        onToggle={toggleTree}
                        height="620px"
                        legend={[
                          { label: "directory", tone: "#38bdf8" },
                          { label: "typescript", tone: "#3178c6" },
                          { label: "hcl", tone: "#844FBA" },
                        ]}
                      />
                    </>
                  ) : null}
                  {githubView === "overview" ? (
                    <div className="space-y-4">
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-slate-500">commit activity (last 12 weeks)</div>
                        <div className="mt-2">
                          <AreaChart
                            series={[{ label: "commits", color: "#8b5cf6", points: githubModel.commitActivity.map((week) => week.commits), fill: true }]}
                            formatValue={(value) => value.toFixed(0)}
                          />
                        </div>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <div className="text-[11px] uppercase tracking-wide text-slate-500">languages</div>
                          <div className="mt-2 space-y-1">
                            {githubModel.languages.map((language) => (
                              <div key={language.name} className="flex items-center gap-2 text-[11px]">
                                <span className="w-24 shrink-0 truncate text-slate-300">{language.name}</span>
                                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
                                  <span className="block h-full rounded-full bg-sky-400" style={{ width: `${Math.max(2, language.pct)}%` }} />
                                </span>
                                <span className="mono w-14 text-right text-slate-400">{language.pct}%</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-wide text-slate-500">contributors</div>
                          <div className="mt-2 space-y-1">
                            {githubModel.contributors.slice(0, 10).map((contributor) => (
                              <div key={contributor.login} className="flex items-center gap-2 text-[11px]">
                                <span className="text-slate-300">@{contributor.login}</span>
                                <span className="mono ml-auto text-slate-400">{contributor.contributions} commits</span>
                              </div>
                            ))}
                          </div>
                          <div className="mt-3 text-[11px] uppercase tracking-wide text-slate-500">recent commits</div>
                          <div className="mt-2 space-y-1">
                            {githubModel.recentCommits.slice(0, 6).map((commit) => (
                              <div key={commit.sha} className="flex items-center gap-2 text-[11px]">
                                <span className="mono text-slate-500">{commit.sha}</span>
                                <span className="truncate text-slate-300">{commit.message}</span>
                                <span className="ml-auto text-[10px] text-slate-600">{commit.date.slice(0, 10)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-slate-500">issues per label</div>
                        <div className="mt-2 grid gap-1 sm:grid-cols-2">
                          {githubModel.labelBreakdown.map((label) => (
                            <div key={label.label} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5 text-[11px]">
                              <span className="h-2 w-2 rounded-full" style={{ background: label.color }} />
                              <span className="truncate text-slate-300">{label.label}</span>
                              <span className="mono ml-auto text-slate-400">
                                {label.open} open / {label.total}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="space-y-3">
                  <div className="panel p-3">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">repository</div>
                    <div className="mt-2 space-y-1 text-[11px]">
                      <Row k="repo" v={githubModel.repo.fullName} />
                      <Row k="description" v={githubModel.repo.description ?? "—"} />
                      <Row k="default" v={githubModel.repo.defaultBranch} />
                      <Row k="topics" v={githubModel.repo.topics.join(", ") || "—"} />
                      <Row k="created/push" v={`${githubModel.repo.pushedAt.slice(0, 10)}`} />
                      <a href={githubModel.repo.htmlUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[11px] text-sky-400 hover:text-sky-300">
                        open on github.com ↗
                      </a>
                    </div>
                    {githubModel.requestInfo.error ? <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[10px] text-amber-300">GitHub: {githubModel.requestInfo.error}</div> : null}
                  </div>

                  <div className="panel p-3">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">insights</div>
                    <div className="mt-2 max-h-[200px] space-y-1 overflow-auto">
                      {githubModel.findings.map((finding, index) => {
                        const palette = TONE_CLASSES[LEVEL_TONE[finding.level]] ?? TONE_CLASSES.idle;
                        return (
                          <div key={index} className={cls("rounded-lg border px-2 py-1.5 text-[11px]", palette.border, palette.bg)}>
                            <div className="flex items-start gap-2">
                              <span className={cls("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", palette.dot)} />
                              <span className="text-slate-200">{finding.message}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="panel p-3">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">issues ({githubModel.issues.length})</div>
                    <div className="mt-2 max-h-[280px] space-y-1 overflow-auto">
                      {githubModel.issues.map((issue) => (
                        <button
                          key={issue.number}
                          type="button"
                          onClick={() => setIssueDetail(issue)}
                          className={cls("flex w-full items-start gap-2 rounded-lg border px-2 py-1.5 text-left text-[11px] transition", issue.state === "open" ? "border-slate-800 bg-slate-950/40 hover:border-emerald-500/50" : "border-slate-800 bg-slate-950/20 hover:border-purple-500/50")}
                        >
                          <span className={cls("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", issue.state === "open" ? "bg-emerald-400" : "bg-purple-400")} />
                          <span className="min-w-0">
                            <span className="block truncate text-slate-200">
                              #{issue.number} {issue.title}
                            </span>
                            <span className="block truncate text-[10px] text-slate-500">
                              {issue.labels.map((label) => label.name).join(" · ") || "unlabelled"}
                              {issue.references.length ? ` · refs ${issue.references.map((number) => `#${number}`).join(",")}` : ""}
                            </span>
                          </span>
                          <span className="ml-auto shrink-0 text-[10px] text-slate-600">{issue.comments}💬</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="panel grid h-[300px] place-items-center text-[12px] text-slate-500">{busy === "github" ? "contacting api.github.com…" : "enter a repository to visualize"}</div>
          )}
        </>
      ) : null}

      {/* ------------------------- drawers ------------------------- */}
      {selected ? (
        <div className="fixed inset-y-0 right-0 z-30 flex w-full max-w-[520px] flex-col border-l border-slate-800 bg-[#0a1120]/98 p-4 shadow-2xl backdrop-blur">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="chip text-slate-400">{selected.kind}</span>
                <span className="truncate text-sm font-semibold text-slate-100">{selected.title}</span>
                {selected.badge ? <span className="chip text-slate-400">{selected.badge}</span> : null}
              </div>
              {selected.subtitle ? <div className="mono mt-0.5 truncate text-[11px] text-slate-500">{selected.subtitle}</div> : null}
            </div>
            <button type="button" onClick={() => setSelected(null)} className="rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-400 hover:border-rose-500 hover:text-rose-300">
              close
            </button>
          </div>
          <div className="mt-3 flex-1 space-y-2 overflow-auto">
            {Object.entries(selected.detail ?? {}).map(([key, value]) => (
              <div key={key} className="rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">{key}</div>
                <div className="mono mt-0.5 whitespace-pre-wrap break-words text-[11px] text-slate-300">
                  {value === null || value === undefined
                    ? "—"
                    : typeof value === "object"
                      ? Array.isArray(value)
                        ? value.map((entry) => (typeof entry === "object" ? JSON.stringify(entry) : String(entry))).join("\n")
                        : Object.entries(value as Record<string, unknown>).map(([innerKey, innerValue]) => `${innerKey} = ${String(innerValue)}`).join("\n")
                      : String(value)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {issueDetail ? (
        <div className="fixed inset-y-0 right-0 z-30 flex w-full max-w-[560px] flex-col border-l border-slate-800 bg-[#0a1120]/98 p-4 shadow-2xl backdrop-blur">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={cls("chip", issueDetail.state === "open" ? "border-emerald-500/40 text-emerald-300" : "border-purple-500/40 text-purple-300")}>{issueDetail.state}</span>
                {issueDetail.isPullRequest ? <span className="chip border-sky-500/40 text-sky-300">pull request</span> : null}
                <span className="text-[12px] text-slate-400">
                  #{issueDetail.number} · @{issueDetail.author}
                </span>
              </div>
              <div className="mt-1 text-sm font-semibold text-slate-100">{issueDetail.title}</div>
              <div className="mt-1 text-[10px] text-slate-500">
                {issueDetail.comments} comments · updated {timeAgo(issueDetail.updatedAt)}
                {issueDetail.milestone ? ` · milestone ${issueDetail.milestone}` : ""}
                {issueDetail.assignees.length ? ` · assigned ${issueDetail.assignees.map((login) => `@${login}`).join(", ")}` : " · unassigned"}
              </div>
            </div>
            <button type="button" onClick={() => setIssueDetail(null)} className="rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-400 hover:border-rose-500 hover:text-rose-300">
              close
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {issueDetail.labels.map((label) => (
              <span key={label.name} className="chip" style={{ borderColor: `${label.color}66`, color: label.color, background: `${label.color}14` }}>
                {label.name}
              </span>
            ))}
          </div>
          {issueDetail.references.length ? (
            <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[11px]">
              <span className="text-slate-400">linked issues: </span>
              <span className="mono text-amber-300">{issueDetail.references.map((number) => `#${number}`).join(", ")}</span>
              <div className="mt-1 text-[10px] text-slate-500">these links are drawn as edges on the issue graph</div>
            </div>
          ) : null}
          <pre className="terminal mt-3 flex-1 overflow-auto rounded-lg p-3">{issueDetail.body || "(no body)"}</pre>
        </div>
      ) : null}

      {filePreview ? (
        <div className="fixed inset-y-0 right-0 z-30 flex w-full max-w-[640px] flex-col border-l border-slate-800 bg-[#0a1120]/98 p-4 shadow-2xl backdrop-blur">
          <div className="flex items-center gap-2">
            <span className="chip text-slate-400">{filePreview.mode}</span>
            <span className="mono truncate text-[12px] text-slate-200">{filePreview.path}</span>
            <span className="chip text-slate-500">{filePreview.sizeKb} KB</span>
            <button type="button" onClick={() => setFilePreview(null)} className="ml-auto rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-400 hover:border-rose-500 hover:text-rose-300">
              close
            </button>
          </div>
          <pre className="terminal mt-3 flex-1 overflow-auto rounded-lg p-3">{filePreview.content}</pre>
        </div>
      ) : null}
    </div>
  );
}

function Cell({ title, values }: { title: string; values: string[] }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-950/60 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wide text-slate-500">{title}</div>
      <div className="mono mt-0.5 space-y-0.5 text-[10px] text-slate-300">
        {values.length ? values.slice(0, 8).map((value) => <div key={value}>{value}</div>) : <div className="text-slate-600">—</div>}
        {values.length > 8 ? <div className="text-slate-600">+{values.length - 8} more</div> : null}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-24 shrink-0 text-slate-500">{k}</span>
      <span className="min-w-0 flex-1 truncate text-slate-300" title={v}>
        {v}
      </span>
    </div>
  );
}
