import type { ConfigEdge, ConfigFinding, ConfigNode } from "./compose-parser";

/**
 * GitHub visualizer data layer.
 *
 * Uses the public REST API (api.github.com). A GITHUB_TOKEN env var raises the
 * rate limit from 60 to 5000 requests/hour; without network access or a token
 * the module falls back to a simulated repository fixture so every view stays
 * usable (and is labelled as simulated in the UI).
 */

const API = "https://api.github.com";
const globalForGithub = globalThis as typeof globalThis & {
  __githubCache?: Map<string, { at: number; value: unknown }>;
  __githubStatus?: { at: number; token: boolean; reachable: boolean; remaining: number | null; limit: number | null; error: string | null };
};

const cache = globalForGithub.__githubCache ?? new Map<string, { at: number; value: unknown }>();
globalForGithub.__githubCache = cache;

const TTL_MS = 5 * 60_000;

export interface GithubRepoRef {
  owner: string;
  name: string;
  fullName: string;
}

export interface GithubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  author: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: number;
  labels: { name: string; color: string }[];
  assignees: string[];
  milestone: string | null;
  body: string;
  isPullRequest: boolean;
  draft: boolean;
  references: number[];
  reactions: number;
}

export interface GithubModel {
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
    createdAt: string;
    archived: boolean;
    homepage: string | null;
    htmlUrl: string;
  };
  languages: { name: string; bytes: number; pct: number }[];
  contributors: { login: string; contributions: number; avatar: string | null }[];
  commitActivity: { week: string; commits: number }[];
  recentCommits: { sha: string; message: string; author: string; date: string }[];
  issues: GithubIssue[];
  nodes: ConfigNode[];
  edges: ConfigEdge[];
  findings: ConfigFinding[];
  stats: {
    issuesOpen: number;
    issuesClosed: number;
    pullRequests: number;
    staleIssues: number;
    unassigned: number;
    labelled: number;
    milestones: number;
    issueLinks: number;
    labelCount: number;
    contributors: number;
  };
  labelBreakdown: { label: string; color: string; total: number; open: number }[];
  requestInfo: { token: boolean; remaining: number | null; limit: number | null; reachable: boolean; error: string | null };
}

export function parseRepoRef(input: string): GithubRepoRef | null {
  const text = (input ?? "").trim();
  if (!text) return null;
  const urlMatch = /github\.com[/:]([^/\s]+)\/([^/\s#?]+)/.exec(text);
  const parts = urlMatch ? [urlMatch[1], urlMatch[2].replace(/\.git$/, "")] : text.split("/");
  if (parts.length < 2) return null;
  const [owner, name] = parts;
  if (!owner || !name) return null;
  return { owner, name, fullName: `${owner}/${name}` };
}

async function githubStatus(force = false): Promise<NonNullable<typeof globalForGithub.__githubStatus>> {
  const cached = globalForGithub.__githubStatus;
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached;
  const token = Boolean(process.env.GITHUB_TOKEN);
  try {
    const res = await fetch(`${API}/rate_limit`, {
      headers: headers(),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const remaining = res.headers.get("x-ratelimit-remaining");
    const limit = res.headers.get("x-ratelimit-limit");
    const status = {
      at: Date.now(),
      token,
      reachable: res.ok,
      remaining: remaining ? Number(remaining) : null,
      limit: limit ? Number(limit) : null,
      error: res.ok ? null : `rate_limit returned ${res.status}`,
    };
    globalForGithub.__githubStatus = status;
    return status;
  } catch (error) {
    const status = { at: Date.now(), token, reachable: false, remaining: null, limit: null, error: error instanceof Error ? error.message : String(error) };
    globalForGithub.__githubStatus = status;
    return status;
  }
}

function headers(): Record<string, string> {
  const base: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "dockflow-console",
    "x-github-api-version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) base.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return base;
}

async function gh<T>(path: string, ttlMs = TTL_MS): Promise<T> {
  const key = path;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < ttlMs) return cached.value as T;
  const res = await fetch(`${API}${path}`, { headers: headers(), cache: "no-store", signal: AbortSignal.timeout(12_000) });
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    throw new Error(`GitHub API rate limit reached (remaining=${remaining ?? "0"}). Add a GITHUB_TOKEN env var to raise the limit to 5000 requests/hour.`);
  }
  if (res.status === 404) throw new Error(`not found on GitHub: ${path}`);
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
  const value = (await res.json()) as T;
  cache.set(key, { at: Date.now(), value });
  return value;
}

/* ------------------------------------------------------------------ */
/* issue references                                                    */
/* ------------------------------------------------------------------ */

const REFERENCE_PATTERNS = [
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi,
  /\b(?:refs?|references?|see|blocked by|blocks|depends on)\s+#(\d+)/gi,
  /#(\d+)/g,
];

export function extractReferences(body: string, known: Set<number>): number[] {
  const found = new Set<number>();
  for (const pattern of REFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body ?? ""))) {
      const number = Number(match[1]);
      if (known.has(number)) found.add(number);
    }
  }
  return [...found];
}

export function referenceKind(body: string, otherNumber: number): string {
  const text = body ?? "";
  const closing = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${otherNumber}\\b`, "i");
  if (closing.test(text)) return "closes";
  const blocking = new RegExp(`\\b(?:blocked by|blocks|depends on)\\s+#${otherNumber}\\b`, "i");
  if (blocking.test(text)) return "blocks";
  return "mentions";
}

/* ------------------------------------------------------------------ */
/* live model                                                          */
/* ------------------------------------------------------------------ */

async function liveModel(ref: GithubRepoRef): Promise<GithubModel> {
  const [repo, languagesRaw, contributorsRaw, issuesRaw, pullsRaw, commitsRaw, activityRaw] = await Promise.all([
    gh<Record<string, any>>(`/repos/${ref.fullName}`),
    gh<Record<string, number>>(`/repos/${ref.fullName}/languages`),
    gh<any[]>(`/repos/${ref.fullName}/contributors?per_page=30`).catch(() => []),
    gh<any[]>(`/repos/${ref.fullName}/issues?state=all&per_page=100&sort=updated&direction=desc`),
    gh<any[]>(`/repos/${ref.fullName}/pulls?state=all&per_page=100`).catch(() => []),
    gh<any[]>(`/repos/${ref.fullName}/commits?per_page=30`).catch(() => []),
    gh<any[]>(`/repos/${ref.fullName}/stats/commit_activity`).catch(() => []),
  ]);

  return buildModel({
    mode: "live",
    repo: {
      fullName: repo.full_name,
      description: repo.description,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      watchers: repo.subscribers_count ?? repo.watchers_count ?? 0,
      openIssues: repo.open_issues_count,
      sizeMb: Math.round((repo.size ?? 0) / 1024),
      language: repo.language,
      license: repo.license?.spdx_id ?? null,
      topics: repo.topics ?? [],
      defaultBranch: repo.default_branch,
      pushedAt: repo.pushed_at,
      createdAt: repo.created_at,
      archived: Boolean(repo.archived),
      homepage: repo.homepage ?? null,
      htmlUrl: repo.html_url,
    },
    languagesRaw,
    contributorsRaw,
    issuesRaw,
    pullsRaw,
    commitsRaw,
    activityRaw,
  });
}

interface BuildInput {
  mode: "live" | "simulated";
  repo: GithubModel["repo"];
  languagesRaw: Record<string, number>;
  contributorsRaw: any[];
  issuesRaw: any[];
  pullsRaw: any[];
  commitsRaw: any[];
  activityRaw: any[];
}

function buildModel(input: BuildInput): GithubModel {
  const issues: GithubIssue[] = input.issuesRaw.map((raw) => ({
    number: Number(raw.number),
    title: String(raw.title ?? ""),
    state: raw.state === "closed" ? "closed" : "open",
    author: String(raw.user?.login ?? "unknown"),
    createdAt: String(raw.created_at ?? new Date().toISOString()),
    updatedAt: String(raw.updated_at ?? raw.created_at ?? new Date().toISOString()),
    closedAt: raw.closed_at ? String(raw.closed_at) : null,
    comments: Number(raw.comments ?? 0),
    labels: ((raw.labels ?? []) as any[]).map((label) => ({ name: String(label.name ?? ""), color: `#${String(label.color ?? "64748b")}` })),
    assignees: ((raw.assignees ?? []) as any[]).map((assignee) => String(assignee.login)),
    milestone: raw.milestone?.title ? String(raw.milestone.title) : null,
    body: String(raw.body ?? "").slice(0, 4000),
    isPullRequest: Boolean(raw.pull_request),
    draft: Boolean(raw.draft),
    reactions: Number(raw.reactions?.total_count ?? 0),
    references: [],
  }));

  const known = new Set(issues.map((issue) => issue.number));
  for (const issue of issues) {
    issue.references = extractReferences(`${issue.body} ${issue.title}`, known).filter((number) => number !== issue.number);
  }

  const totalBytes = Object.values(input.languagesRaw).reduce((sum, value) => sum + Number(value ?? 0), 0) || 1;
  const languages = Object.entries(input.languagesRaw)
    .map(([name, bytes]) => ({ name, bytes: Number(bytes ?? 0), pct: +((Number(bytes ?? 0) / totalBytes) * 100).toFixed(1) }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10);

  const contributors = input.contributorsRaw
    .map((raw) => ({ login: String(raw.login ?? "unknown"), contributions: Number(raw.contributions ?? 0), avatar: raw.avatar_url ? String(raw.avatar_url) : null }))
    .slice(0, 20);

  const commitActivity = (Array.isArray(input.activityRaw) ? input.activityRaw : [])
    .slice(-12)
    .map((week) => ({ week: new Date(Number(week.week) * 1000).toISOString().slice(0, 10), commits: Number(week.total ?? 0) }));

  const recentCommits = input.commitsRaw
    .map((raw) => ({
      sha: String(raw.sha ?? "").slice(0, 8),
      message: String(raw.commit?.message ?? "").split("\n")[0].slice(0, 120),
      author: String(raw.commit?.author?.name ?? raw.author?.login ?? "unknown"),
      date: String(raw.commit?.author?.date ?? new Date().toISOString()),
    }))
    .slice(0, 20);

  const realIssues = issues.filter((issue) => !issue.isPullRequest);
  const pullRequests = issues.filter((issue) => issue.isPullRequest);

  /* ------------- graph ------------- */
  const ROOT = "gh:repo";
  const nodes: ConfigNode[] = [];
  const edges: ConfigEdge[] = [];
  const findings: ConfigFinding[] = [];

  nodes.push({
    id: ROOT,
    title: input.repo.fullName,
    subtitle: input.repo.description ?? "GitHub repository",
    kind: "host",
    parentId: null,
    status: input.repo.archived ? "degraded" : "ready",
    accent: "#8b5cf6",
    badge: input.mode === "live" ? "github api" : "simulated fixture",
    agg: [
      { label: "issues", value: `${realIssues.filter((issue) => issue.state === "open").length}/${realIssues.length}`, tone: "info" },
      { label: "prs", value: String(pullRequests.length), tone: "idle" },
      { label: "stars", value: formatCount(input.repo.stars), tone: "warn" },
      { label: "forks", value: formatCount(input.repo.forks), tone: "idle" },
    ],
    meta: [input.repo.license ? `license ${input.repo.license}` : "", input.repo.defaultBranch ? `branch ${input.repo.defaultBranch}` : "", input.repo.topics.length ? input.repo.topics.slice(0, 4).join(", ") : ""].filter(Boolean),
    detail: {
      url: input.repo.htmlUrl,
      stars: input.repo.stars,
      forks: input.repo.forks,
      watchers: input.repo.watchers,
      openIssues: input.repo.openIssues,
      sizeMb: input.repo.sizeMb,
      language: input.repo.language,
      license: input.repo.license,
      defaultBranch: input.repo.defaultBranch,
      createdAt: input.repo.createdAt,
      pushedAt: input.repo.pushedAt,
      archived: input.repo.archived,
      homepage: input.repo.homepage,
      topics: input.repo.topics,
    },
  });

  /* --- issues, grouped by state then by primary label --- */
  const issuesRoot = "gh:issues";
  const openIssues = realIssues.filter((issue) => issue.state === "open");
  const closedIssues = realIssues.filter((issue) => issue.state === "closed");
  nodes.push({
    id: issuesRoot,
    title: "issues",
    subtitle: `${realIssues.length} issues · ${openIssues.length} open`,
    kind: "project",
    parentId: ROOT,
    status: openIssues.length > 25 ? "degraded" : "ready",
    accent: "#22c55e",
    badge: `${openIssues.length} open`,
    agg: [
      { label: "closed", value: String(closedIssues.length), tone: "idle" },
      { label: "unassigned", value: String(openIssues.filter((issue) => issue.assignees.length === 0).length), tone: "warn" },
    ],
  });

  const groupOf = (issue: GithubIssue) => {
    const labels = issue.labels.map((label) => label.name.toLowerCase());
    const primary = issue.labels[0];
    if (labels.includes("bug")) return { id: "bug", title: "bug", accent: "#f43f5e" };
    if (labels.some((label) => label.includes("security") || label === "cve")) return { id: "security", title: "security", accent: "#dc2626" };
    if (labels.some((label) => label.includes("feature") || label.includes("enhancement"))) return { id: "feature", title: "feature", accent: "#38bdf8" };
    if (labels.some((label) => label.includes("doc"))) return { id: "docs", title: "documentation", accent: "#14b8a6" };
    if (labels.some((label) => label.includes("perf"))) return { id: "performance", title: "performance", accent: "#f59e0b" };
    if (labels.some((label) => label.includes("tech") || label.includes("refactor") || label.includes("chore"))) return { id: "chore", title: "tech debt", accent: "#a855f7" };
    return primary ? { id: primary.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title: primary.name, accent: primary.color } : { id: "untriaged", title: "untriaged", accent: "#64748b" };
  };

  const stateGroups = new Map<string, GithubIssue[]>();
  for (const issue of realIssues) {
    const key = `${issue.state}:${groupOf(issue).id}`;
    stateGroups.set(key, [...(stateGroups.get(key) ?? []), issue]);
  }

  for (const state of ["open", "closed"] as const) {
    const stateId = `gh:state:${state}`;
    const bucket = realIssues.filter((issue) => issue.state === state);
    if (!bucket.length) continue;
    nodes.push({
      id: stateId,
      title: state,
      subtitle: `${bucket.length} issues`,
      kind: "service",
      parentId: issuesRoot,
      status: state === "open" ? "up" : "ready",
      accent: state === "open" ? "#22c55e" : "#a855f7",
      badge: `${bucket.length}`,
    });
    for (const [key, members] of [...stateGroups.entries()].filter(([key]) => key.startsWith(`${state}:`))) {
      const group = groupOf(members[0]);
      const groupId = `${stateId}:${group.id}`;
      nodes.push({
        id: groupId,
        title: group.title,
        subtitle: `${members.length} ${state} issues`,
        kind: "project",
        parentId: stateId,
        status: state === "open" ? "up" : "ready",
        accent: group.accent,
        badge: String(members.length),
      });
      for (const issue of members) {
        const staleDays = (Date.now() - new Date(issue.updatedAt).getTime()) / 86_400_000;
        nodes.push({
          id: `gh:issue:${issue.number}`,
          title: `#${issue.number} ${issue.title.slice(0, 60)}`,
          subtitle: `${issue.author} · updated ${issue.updatedAt.slice(0, 10)}${issue.milestone ? ` · ${issue.milestone}` : ""}`,
          kind: issue.isPullRequest ? "container" : "service",
          parentId: groupId,
          status: issue.state === "open" ? (staleDays > 60 ? "degraded" : "up") : "ready",
          accent: issue.isPullRequest ? "#8b5cf6" : issue.labels[0]?.color ?? (issue.state === "open" ? "#22c55e" : "#a855f7"),
          badge: issue.isPullRequest ? "PR" : `#${issue.number}`,
          agg: [
            { label: "comments", value: String(issue.comments), tone: "info" },
            ...(issue.assignees.length ? [{ label: "assignee", value: issue.assignees.join(","), tone: "idle" }] : [{ label: "assignee", value: "none", tone: "warn" }]),
            ...(staleDays > 60 && issue.state === "open" ? [{ label: "stale", value: `${Math.round(staleDays)}d`, tone: "warn" }] : []),
          ],
          meta: [issue.labels.map((label) => label.name).join(" ") || "no labels", issue.reactions ? `${issue.reactions} reactions` : ""].filter(Boolean),
          detail: {
            number: issue.number,
            title: issue.title,
            state: issue.state,
            author: issue.author,
            createdAt: issue.createdAt,
            updatedAt: issue.updatedAt,
            closedAt: issue.closedAt,
            comments: issue.comments,
            labels: issue.labels.map((label) => label.name),
            assignees: issue.assignees,
            milestone: issue.milestone,
            isPullRequest: issue.isPullRequest,
            body: issue.body,
            references: issue.references,
          },
        });
      }
    }
  }

  let issueLinks = 0;
  const byNumber = new Map(realIssues.map((issue) => [issue.number, issue]));
  for (const issue of realIssues) {
    for (const target of issue.references) {
      const other = byNumber.get(target);
      if (!other) continue;
      issueLinks += 1;
      edges.push({
        id: `gh:ref:${issue.number}->${target}`,
        source: `gh:issue:${issue.number}`,
        target: `gh:issue:${other.number}`,
        label: `#${issue.number} ${referenceKind(`${issue.body} ${issue.title}`, target)} #${target}`,
        tone: referenceKind(`${issue.body} ${issue.title}`, target) === "mentions" ? "idle" : "warn",
      });
    }
  }

  /* --- labels / milestones / people overview --- */
  const labelsRoot = "gh:labels";
  if (input.mode === "live" || realIssues.length) {
    nodes.push({ id: labelsRoot, title: "labels & milestones", subtitle: "triage overview", kind: "project", parentId: ROOT, status: "ready", accent: "#f59e0b", badge: `${new Set(realIssues.flatMap((issue) => issue.labels.map((label) => label.name))).size} labels` });
    const labelCounts = new Map<string, { color: string; total: number; open: number }>();
    for (const issue of realIssues) {
      for (const label of issue.labels) {
        const current = labelCounts.get(label.name) ?? { color: label.color, total: 0, open: 0 };
        current.total += 1;
        if (issue.state === "open") current.open += 1;
        labelCounts.set(label.name, current);
      }
    }
    for (const [name, entry] of [...labelCounts.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 18)) {
      nodes.push({
        id: `gh:label:${name}`,
        title: name,
        subtitle: `${entry.total} issues · ${entry.open} open`,
        kind: "network",
        parentId: labelsRoot,
        status: "up",
        accent: entry.color,
        badge: String(entry.total),
        agg: [
          { label: "open", value: String(entry.open), tone: "warn" },
          { label: "done", value: String(entry.total - entry.open), tone: "good" },
        ],
      });
    }
    const milestones = new Map<string, { total: number; open: number }>();
    for (const issue of realIssues) {
      if (!issue.milestone) continue;
      const current = milestones.get(issue.milestone) ?? { total: 0, open: 0 };
      current.total += 1;
      if (issue.state === "open") current.open += 1;
      milestones.set(issue.milestone, current);
    }
    for (const [name, entry] of milestones) {
      nodes.push({
        id: `gh:milestone:${name}`,
        title: name,
        subtitle: `${entry.total} issues · ${entry.open} open`,
        kind: "image",
        parentId: labelsRoot,
        status: "up",
        accent: "#f472b6",
        badge: `${Math.round(((entry.total - entry.open) / entry.total) * 100)}% done`,
        agg: [
          { label: "open", value: String(entry.open), tone: "warn" },
          { label: "closed", value: String(entry.total - entry.open), tone: "good" },
        ],
      });
    }
    const people = new Map<string, { open: number; done: number }>();
    for (const issue of realIssues) {
      for (const assignee of issue.assignees) {
        const current = people.get(assignee) ?? { open: 0, done: 0 };
        if (issue.state === "open") current.open += 1;
        else current.done += 1;
        people.set(assignee, current);
      }
    }
    for (const [login, entry] of people) {
      nodes.push({
        id: `gh:assignee:${login}`,
        title: `@${login}`,
        subtitle: `${entry.open} open · ${entry.done} closed`,
        kind: "agent",
        parentId: labelsRoot,
        status: entry.open > 6 ? "degraded" : "up",
        accent: "#38bdf8",
        badge: `${entry.open} open`,
        agg: [{ label: "load", value: String(entry.open), tone: entry.open > 6 ? "warn" : "good" }],
      });
    }
  }

  const codeRoot = "gh:code";
  const topLanguages = languages.filter((language) => language.pct > 1).slice(0, 6);
  nodes.push({
    id: codeRoot,
    title: "code base",
    subtitle: `${languages.length} languages · ${input.repo.sizeMb} MB`,
    kind: "project",
    parentId: ROOT,
    status: "ready",
    accent: "#6366f1",
    badge: `${input.repo.sizeMb} MB`,
    agg: topLanguages.slice(0, 2).map((language) => ({ label: language.name, value: `${language.pct}%`, tone: "info" })),
  });
  for (const language of languages.slice(0, 10)) {
    nodes.push({
      id: `gh:lang:${language.name}`,
      title: language.name,
      subtitle: `${(language.bytes / 1024).toFixed(0)} KB · ${language.pct}%`,
      kind: "image",
      parentId: codeRoot,
      status: "up",
      accent: languageColor(language.name),
      badge: `${language.pct}%`,
      detail: { language: language.name, bytes: language.bytes, percentage: language.pct },
    });
  }
  const contributorsGroup = `${codeRoot}:contributors`;
  nodes.push({ id: contributorsGroup, title: "contributors", subtitle: `${contributors.length} people`, kind: "service", parentId: codeRoot, status: "up", accent: "#14b8a6", badge: String(contributors.length) });
  for (const contributor of contributors.slice(0, 12)) {
    nodes.push({
      id: `gh:contributor:${contributor.login}`,
      title: contributor.login,
      subtitle: `${contributor.contributions} commits`,
      kind: "agent",
      parentId: contributorsGroup,
      status: "up",
      accent: "#14b8a6",
      badge: String(contributor.contributions),
    });
  }
  for (const commit of recentCommits.slice(0, 6)) {
    nodes.push({
      id: `gh:commit:${commit.sha}`,
      title: commit.message.slice(0, 54),
      subtitle: `${commit.sha} · ${commit.author} · ${commit.date.slice(0, 10)}`,
      kind: "container",
      parentId: codeRoot,
      status: "up",
      accent: "#64748b",
      badge: commit.sha,
      detail: { sha: commit.sha, message: commit.message, author: commit.author, date: commit.date },
    });
  }

  /* --- findings --- */
  const stale = openIssues.filter((issue) => (Date.now() - new Date(issue.updatedAt).getTime()) / 86_400_000 > 60);
  if (stale.length) findings.push({ level: "warn", message: `${stale.length} open issues have not been touched for over 60 days (oldest #${stale[stale.length - 1].number})` });
  const unassigned = openIssues.filter((issue) => issue.assignees.length === 0);
  if (unassigned.length) findings.push({ level: "info", message: `${unassigned.length} open issues have no assignee` });
  const noLabels = openIssues.filter((issue) => issue.labels.length === 0);
  if (noLabels.length) findings.push({ level: "warn", message: `${noLabels.length} open issues are unlabelled — they will not appear in a triage group` });
  if (pullRequests.filter((pull) => pull.state === "open").length > 20) findings.push({ level: "info", message: `${pullRequests.filter((pull) => pull.state === "open").length} pull requests are open` });
  if (input.repo.archived) findings.push({ level: "warn", message: "repository is archived (read-only)" });
  if (!input.repo.license) findings.push({ level: "info", message: "no license detected" });
  if (!recentCommits.length) findings.push({ level: "info", message: "no commit data returned (activity statistics may still be computing)" });
  const highChurn = commitActivity.reduce((sum, entry) => sum + entry.commits, 0);
  if (highChurn > 0) findings.push({ level: "info", message: `${highChurn} commits in the last ${commitActivity.length} weeks` });
  for (const issue of realIssues.filter((entry) => entry.state === "open")) {
    if (openIssues.some((other) => other.number !== issue.number && referenceKind(`${other.body} ${other.title}`, issue.number) === "blocks")) {
      findings.push({ level: "warn", message: `#${issue.number} is referenced as a blocking dependency` });
      break;
    }
  }

  const labelBreakdown = [...new Map(realIssues.flatMap((issue) => issue.labels.map((label) => [label.name, label]))).keys()]
    .map((name) => {
      const members = realIssues.filter((issue) => issue.labels.some((label) => label.name === name));
      const color = members[0]?.labels.find((label) => label.name === name)?.color ?? "#64748b";
      return { label: name, color, total: members.length, open: members.filter((issue) => issue.state === "open").length };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);

  return {
    kind: "github",
    mode: input.mode,
    repo: input.repo,
    languages,
    contributors,
    commitActivity,
    recentCommits,
    issues,
    nodes,
    edges,
    findings,
    labelBreakdown,
    stats: {
      issuesOpen: openIssues.length,
      issuesClosed: closedIssues.length,
      pullRequests: pullRequests.length,
      staleIssues: stale.length,
      unassigned: unassigned.length,
      labelled: realIssues.filter((issue) => issue.labels.length > 0).length,
      milestones: new Set(realIssues.map((issue) => issue.milestone).filter(Boolean)).size,
      issueLinks,
      labelCount: labelBreakdown.length,
      contributors: contributors.length,
    },
    requestInfo: {
      token: Boolean(process.env.GITHUB_TOKEN),
      remaining: null,
      limit: null,
      reachable: true,
      error: null,
    },
  };
}

function formatCount(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function languageColor(name: string): string {
  const colors: Record<string, string> = {
    TypeScript: "#3178c6",
    JavaScript: "#f1e05a",
    Python: "#3572A5",
    Go: "#00ADD8",
    Rust: "#dea584",
    Java: "#b07219",
    Ruby: "#701516",
    "C++": "#f34b7d",
    C: "#555555",
    Shell: "#89e051",
    HCL: "#844FBA",
    HTML: "#e34c26",
    CSS: "#563d7c",
    Vue: "#41b883",
    Svelte: "#ff3e00",
    Kotlin: "#A97BFF",
    PHP: "#4F5D95",
  };
  return colors[name] ?? "#8b949e";
}

/* ------------------------------------------------------------------ */
/* simulated fixture                                                   */
/* ------------------------------------------------------------------ */

interface FixtureSpec {
  fullName: string;
  languages: Record<string, number>;
  issues: {
    number: number;
    title: string;
    state: "open" | "closed";
    author: string;
    labels: string[];
    assignees: string[];
    milestone?: string;
    comments: number;
    daysAgo: number;
    body: string;
    isPullRequest?: boolean;
  }[];
  contributors: { login: string; contributions: number }[];
}

const FIXTURES: FixtureSpec[] = [
  {
    fullName: "vercel/next.js",
    languages: { TypeScript: 61_200_000, JavaScript: 18_400_000, Rust: 6_100_000, CSS: 2_400_000, Shell: 320_000 },
    contributors: [
      { login: "ijjk", contributions: 4210 },
      { login: "timneutkens", contributions: 3180 },
      { login: "shuding", contributions: 2140 },
      { login: "huozhi", contributions: 1820 },
      { login: "ztanner", contributions: 1240 },
      { login: "sokra", contributions: 980 },
      { login: "wyattjoh", contributions: 640 },
    ],
    issues: [
      { number: 71204, title: "App router: prefetch on hover causes duplicate RSC requests", state: "open", author: "reporter-a", labels: ["bug", "app-router"], assignees: ["ijjk"], milestone: "v15.2", comments: 14, daysAgo: 3, body: "Hovering a Link fires two requests. Reproduced on 15.1.6. Closes #71002? no — related to #70988 which regressed prefetch caching." },
      { number: 71101, title: "Turbopack: ESM-only dependency fails to resolve in edge runtime", state: "open", author: "reporter-b", labels: ["bug", "turbopack", "edge"], assignees: ["sokra"], milestone: "v15.2", comments: 8, daysAgo: 11, body: "Blocked by #70990 (external module handling). Mentioned in #71100." },
      { number: 70990, title: "Missing support for external ESM modules in edge bundles", state: "open", author: "reporter-c", labels: ["tech debt", "turbopack"], assignees: ["sokra"], comments: 19, daysAgo: 26, body: "Long-standing gap. Blocks #71101." },
      { number: 70988, title: "Prefetch cache ignores staleTime for dynamic routes", state: "closed", author: "reporter-d", labels: ["bug", "app-router"], assignees: ["huozhi"], milestone: "v15.1", comments: 6, daysAgo: 61, body: "Fixed in #70980. Related to #71204." },
      { number: 71100, title: "Docs: document revalidateTag interplay with fetch cache", state: "open", author: "reporter-e", labels: ["documentation"], assignees: [], comments: 2, daysAgo: 9, body: "Would unblock support questions in #71101." },
      { number: 70877, title: "Image optimisation retries forever on 404 upstream", state: "open", author: "reporter-f", labels: ["bug", "image"], assignees: ["ztanner"], comments: 21, daysAgo: 88, body: "Stale issue: still reproducible on 15.1.x. Refs #70120." },
      { number: 70812, title: "CVE-2026-1188: middleware bypass with encoded paths", state: "closed", author: "security-bot", labels: ["security"], assignees: ["ijjk"], milestone: "v15.1.1", comments: 4, daysAgo: 42, body: "Patched. Advisory published." },
      { number: 71320, title: "Perf: reduce client bundle by 12% via tree-shaken router entries", state: "open", author: "reporter-g", labels: ["performance", "enhancement"], assignees: [], comments: 5, daysAgo: 1, body: "Benchmarks attached. Depends on #70990 landing first." },
      { number: 71333, title: "feat: add partial prerendering diagnostics panel", state: "open", author: "reporter-h", labels: ["enhancement", "dx"], assignees: ["shuding"], comments: 0, daysAgo: 0, body: "Adds a dev overlay section for PPR boundaries." , isPullRequest: true },
      { number: 71288, title: "fix: cache middleware matcher regex compilation", state: "open", author: "reporter-i", labels: ["bug"], assignees: ["timneutkens"], comments: 3, daysAgo: 4, body: "Regression from #71200. Closes #71204." , isPullRequest: true },
      { number: 70750, title: "Untriaged: strange error when using two root layouts", state: "open", author: "reporter-j", labels: [], assignees: [], comments: 1, daysAgo: 74, body: "No reproduction yet." },
      { number: 70690, title: "Refactor server actions serialization layer", state: "open", author: "reporter-k", labels: ["tech debt"], assignees: ["wyattjoh"], comments: 12, daysAgo: 95, body: "Largest remaining piece before removal of the legacy encoder." },
    ],
  },
];

function simulatedModel(ref: GithubRepoRef): GithubModel {
  const fixture = FIXTURES.find((entry) => entry.fullName.toLowerCase() === ref.fullName.toLowerCase()) ?? FIXTURES[0];
  const now = Date.now();
  const issuesRaw = fixture.issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    user: { login: issue.author },
    created_at: new Date(now - (issue.daysAgo + 30) * 86_400_000).toISOString(),
    updated_at: new Date(now - issue.daysAgo * 86_400_000).toISOString(),
    closed_at: issue.state === "closed" ? new Date(now - (issue.daysAgo - 1) * 86_400_000).toISOString() : null,
    comments: issue.comments,
    labels: issue.labels.map((label) => ({ name: label, color: labelColor(label) })),
    assignees: issue.assignees.map((login) => ({ login })),
    milestone: issue.milestone ? { title: issue.milestone } : null,
    body: issue.body,
    pull_request: issue.isPullRequest ? {} : undefined,
    draft: false,
    reactions: { total_count: issue.comments * 2 },
  }));

  const commitsRaw = Array.from({ length: 14 }, (_, index) => ({
    sha: `${(index + 1).toString(16).repeat(8)}`,
    commit: {
      message: ["fix(router): dedupe prefetch requests", "feat(ppr): diagnostics panel", "chore(deps): bump turbopack", "test(e2e): stabilise flaky suite", "perf(bundle): tree-shake router entries"][index % 5],
      author: { name: fixture.contributors[index % fixture.contributors.length].login, date: new Date(now - index * 26 * 3_600_000).toISOString() },
    },
  }));

  const activityRaw = Array.from({ length: 12 }, (_, index) => ({
    week: Math.floor((now - (11 - index) * 7 * 86_400_000) / 1000),
    total: 20 + ((index * 7) % 45),
  }));

  return buildModel({
    mode: "simulated",
    repo: {
      fullName: fixture.fullName,
      description: "Simulated repository fixture — GitHub was unreachable (or the repo is private) so every view uses local sample data. Attach a GITHUB_TOKEN or pick a reachable public repo to load live data.",
      stars: 128_400,
      forks: 27_300,
      watchers: 1_840,
      openIssues: fixture.issues.filter((issue) => issue.state === "open").length,
      sizeMb: 486,
      language: "TypeScript",
      license: "MIT",
      topics: ["react", "nextjs", "ssr", "turbopack"],
      defaultBranch: "canary",
      pushedAt: new Date(now - 3_600_000).toISOString(),
      createdAt: new Date(now - 400 * 86_400_000).toISOString(),
      archived: false,
      homepage: "https://nextjs.org",
      htmlUrl: `https://github.com/${fixture.fullName}`,
    },
    languagesRaw: fixture.languages,
    contributorsRaw: fixture.contributors.map((contributor) => ({ login: contributor.login, contributions: contributor.contributions })),
    issuesRaw,
    pullsRaw: [],
    commitsRaw,
    activityRaw,
  });
}

function labelColor(name: string): string {
  const colors: Record<string, string> = {
    bug: "d73a4a",
    security: "b60205",
    enhancement: "a2eeef",
    documentation: "0075ca",
    performance: "fbca04",
    "tech debt": "d4c5f9",
    turbopack: "5319e7",
    "app-router": "1d76db",
    image: "c5def5",
    edge: "bfd4f2",
    dx: "fef2c0",
  };
  return colors[name] ?? "64748b";
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

export async function loadGithubRepo(input: string, allowFallback = true): Promise<GithubModel> {
  const ref = parseRepoRef(input);
  if (!ref) throw new Error("provide a repository as owner/name or a github.com URL");

  const status = await githubStatus();
  if (status.reachable) {
    try {
      const model = await liveModel(ref);
      const refreshed = await githubStatus(true);
      model.requestInfo = { token: refreshed.token, remaining: refreshed.remaining, limit: refreshed.limit, reachable: true, error: null };
      return model;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!allowFallback) throw error;
      const fallback = simulatedModel(ref);
      fallback.requestInfo = { token: status.token, remaining: status.remaining, limit: status.limit, reachable: false, error: message };
      fallback.findings.unshift({ level: "warn", message: `live GitHub request failed (${message}) — showing the simulated fixture instead` });
      return fallback;
    }
  }

  if (!allowFallback) throw new Error(status.error ?? "GitHub API unreachable");
  const fallback = simulatedModel(ref);
  fallback.requestInfo = { token: status.token, remaining: status.remaining, limit: status.limit, reachable: false, error: status.error };
  fallback.findings.unshift({ level: "warn", message: `GitHub API unreachable (${status.error ?? "network error"}) — showing the simulated fixture instead` });
  return fallback;
}

export async function githubRateInfo(): Promise<{ token: boolean; reachable: boolean; remaining: number | null; limit: number | null; error: string | null }> {
  const status = await githubStatus();
  return { token: status.token, reachable: status.reachable, remaining: status.remaining, limit: status.limit, error: status.error };
}
