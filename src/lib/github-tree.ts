import { githubRateInfo } from "./github";

/**
 * Lazy GitHub directory listing + file preview.
 * Live mode uses the contents API; offline/simulated mode walks a fixture tree so
 * the lazy-expanding repository browser in the UI stays functional.
 */

const API = "https://api.github.com";

const globalForTree = globalThis as typeof globalThis & { __githubTreeCache?: Map<string, { at: number; value: unknown }> };
const cache = globalForTree.__githubTreeCache ?? new Map<string, { at: number; value: unknown }>();
globalForTree.__githubTreeCache = cache;
const TTL_MS = 10 * 60_000;

export interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  sizeKb: number | null;
  language: string | null;
  htmlUrl: string | null;
}

export interface TreeResult {
  repo: string;
  path: string;
  mode: "live" | "simulated";
  entries: TreeEntry[];
  error: string | null;
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".json": "JSON",
  ".md": "Markdown",
  ".yml": "YAML",
  ".yaml": "YAML",
  ".tf": "HCL",
  ".tfvars": "HCL",
  ".go": "Go",
  ".rs": "Rust",
  ".py": "Python",
  ".java": "Java",
  ".rb": "Ruby",
  ".php": "PHP",
  ".css": "CSS",
  ".scss": "SCSS",
  ".html": "HTML",
  ".sh": "Shell",
  ".sql": "SQL",
  ".toml": "TOML",
  ".gradle": "Gradle",
  ".proto": "Protobuf",
  ".dockerfile": "Dockerfile",
};

function languageOf(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return "Dockerfile";
  if (lower === "makefile") return "Makefile";
  const ext = lower.slice(lower.lastIndexOf("."));
  return LANGUAGE_BY_EXT[ext] ?? null;
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

/* --------------------------- fixture tree --------------------------- */

const FIXTURE_TREE: Record<string, TreeEntry[]> = {
  "": [
    { name: "app", path: "app", type: "dir", sizeKb: null, language: null, htmlUrl: null },
    { name: "packages", path: "packages", type: "dir", sizeKb: null, language: null, htmlUrl: null },
    { name: "infra", path: "infra", type: "dir", sizeKb: null, language: null, htmlUrl: null },
    { name: "docs", path: "docs", type: "dir", sizeKb: null, language: null, htmlUrl: null },
    { name: "docker-compose.yml", path: "docker-compose.yml", type: "file", sizeKb: 4, language: "YAML", htmlUrl: null },
    { name: "package.json", path: "package.json", type: "file", sizeKb: 3, language: "JSON", htmlUrl: null },
    { name: "README.md", path: "README.md", type: "file", sizeKb: 12, language: "Markdown", htmlUrl: null },
    { name: "next.config.ts", path: "next.config.ts", type: "file", sizeKb: 1, language: "TypeScript", htmlUrl: null },
  ],
  app: [
    { name: "(marketing)", path: "app/(marketing)", type: "dir", sizeKb: null, language: null, htmlUrl: null },
    { name: "dashboard", path: "app/dashboard", type: "dir", sizeKb: null, language: null, htmlUrl: null },
    { name: "layout.tsx", path: "app/layout.tsx", type: "file", sizeKb: 1, language: "TypeScript", htmlUrl: null },
    { name: "page.tsx", path: "app/page.tsx", type: "file", sizeKb: 6, language: "TypeScript", htmlUrl: null },
    { name: "globals.css", path: "app/globals.css", type: "file", sizeKb: 2, language: "CSS", htmlUrl: null },
  ],
  "app/dashboard": [
    { name: "analytics", path: "app/dashboard/analytics", type: "dir", sizeKb: null, language: null, htmlUrl: null },
    { name: "page.tsx", path: "app/dashboard/page.tsx", type: "file", sizeKb: 4, language: "TypeScript", htmlUrl: null },
    { name: "loading.tsx", path: "app/dashboard/loading.tsx", type: "file", sizeKb: 1, language: "TypeScript", htmlUrl: null },
  ],
  "app/dashboard/analytics": [
    { name: "chart.tsx", path: "app/dashboard/analytics/chart.tsx", type: "file", sizeKb: 3, language: "TypeScript", htmlUrl: null },
    { name: "queries.ts", path: "app/dashboard/analytics/queries.ts", type: "file", sizeKb: 2, language: "TypeScript", htmlUrl: null },
  ],
  packages: [
    { name: "ui", path: "packages/ui", type: "dir", sizeKb: null, language: null, htmlUrl: null },
    { name: "core", path: "packages/core", type: "dir", sizeKb: null, language: null, htmlUrl: null },
  ],
  "packages/ui": [
    { name: "button.tsx", path: "packages/ui/button.tsx", type: "file", sizeKb: 2, language: "TypeScript", htmlUrl: null },
    { name: "table.tsx", path: "packages/ui/table.tsx", type: "file", sizeKb: 5, language: "TypeScript", htmlUrl: null },
    { name: "package.json", path: "packages/ui/package.json", type: "file", sizeKb: 1, language: "JSON", htmlUrl: null },
  ],
  "packages/core": [
    { name: "client.ts", path: "packages/core/client.ts", type: "file", sizeKb: 9, language: "TypeScript", htmlUrl: null },
    { name: "otel.ts", path: "packages/core/otel.ts", type: "file", sizeKb: 3, language: "TypeScript", htmlUrl: null },
    { name: "package.json", path: "packages/core/package.json", type: "file", sizeKb: 1, language: "JSON", htmlUrl: null },
  ],
  infra: [
    { name: "modules", path: "infra/modules", type: "dir", sizeKb: null, language: null, htmlUrl: null },
    { name: "main.tf", path: "infra/main.tf", type: "file", sizeKb: 8, language: "HCL", htmlUrl: null },
    { name: "variables.tf", path: "infra/variables.tf", type: "file", sizeKb: 3, language: "HCL", htmlUrl: null },
    { name: "outputs.tf", path: "infra/outputs.tf", type: "file", sizeKb: 2, language: "HCL", htmlUrl: null },
  ],
  "infra/modules": [
    { name: "eks", path: "infra/modules/eks", type: "dir", sizeKb: null, language: null, htmlUrl: null },
    { name: "rds", path: "infra/modules/rds", type: "dir", sizeKb: null, language: null, htmlUrl: null },
  ],
  "infra/modules/eks": [
    { name: "main.tf", path: "infra/modules/eks/main.tf", type: "file", sizeKb: 6, language: "HCL", htmlUrl: null },
    { name: "variables.tf", path: "infra/modules/eks/variables.tf", type: "file", sizeKb: 2, language: "HCL", htmlUrl: null },
  ],
  "infra/modules/rds": [{ name: "main.tf", path: "infra/modules/rds/main.tf", type: "file", sizeKb: 5, language: "HCL", htmlUrl: null }],
  docs: [
    { name: "architecture.md", path: "docs/architecture.md", type: "file", sizeKb: 14, language: "Markdown", htmlUrl: null },
    { name: "runbook.md", path: "docs/runbook.md", type: "file", sizeKb: 7, language: "Markdown", htmlUrl: null },
  ],
};

const FIXTURE_CONTENT: Record<string, string> = {
  "docker-compose.yml": "services:\n  api:\n    image: vega/api:2.14.3\n    ports:\n      - \"3001:3000\"\n  db:\n    image: postgres:16.4-alpine\n",
  "infra/main.tf": "resource \"aws_vpc\" \"main\" {\n  cidr_block = var.vpc_cidr\n}\n",
  "README.md": "# DockFlow demo repository\n\nThis file comes from the simulated repository fixture (GitHub was unreachable).\n",
};

export async function listGithubDir(repo: string, dirPath: string, allowFallback = true): Promise<TreeResult> {
  const key = `tree:${repo}:${dirPath}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value as TreeResult;

  const rate = await githubRateInfo();
  if (rate.reachable) {
    try {
      const res = await fetch(`${API}/repos/${repo}/contents/${dirPath}`, { headers: headers(), cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (res.status === 403 || res.status === 429) throw new Error("GitHub API rate limit reached — add a GITHUB_TOKEN env var");
      if (!res.ok) throw new Error(`contents API returned ${res.status} for ${dirPath || "/"}`);
      const raw = (await res.json()) as Record<string, any> | Record<string, any>[];
      const list = Array.isArray(raw) ? raw : [raw];
      const entries: TreeEntry[] = list.map((entry) => ({
        name: String(entry.name ?? ""),
        path: String(entry.path ?? ""),
        type: entry.type === "dir" ? "dir" : "file",
        sizeKb: entry.size !== undefined ? Math.max(0, Math.round(Number(entry.size) / 1024)) : null,
        language: entry.type === "dir" ? null : languageOf(String(entry.name ?? "")),
        htmlUrl: entry.html_url ? String(entry.html_url) : null,
      }));
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
      const value: TreeResult = { repo, path: dirPath, mode: "live", entries, error: null };
      cache.set(key, { at: Date.now(), value });
      return value;
    } catch (error) {
      if (!allowFallback) throw error;
      const value: TreeResult = {
        repo,
        path: dirPath,
        mode: "simulated",
        entries: FIXTURE_TREE[dirPath] ?? [],
        error: error instanceof Error ? error.message : String(error),
      };
      return value;
    }
  }

  const path = FIXTURE_TREE[dirPath] ? dirPath : "";
  return {
    repo,
    path,
    mode: "simulated",
    entries: FIXTURE_TREE[path] ?? [],
    error: rate.error ?? "GitHub API unreachable",
  };
}

export async function readGithubFile(repo: string, filePath: string, allowFallback = true): Promise<{ repo: string; path: string; mode: "live" | "simulated"; sizeKb: number; content: string; truncated: boolean; error: string | null }> {
  const key = `file:${repo}:${filePath}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value as { repo: string; path: string; mode: "live" | "simulated"; sizeKb: number; content: string; truncated: boolean; error: string | null };

  const rate = await githubStatusSafe();
  if (rate) {
    try {
      const res = await fetch(`${API}/repos/${repo}/contents/${filePath}`, { headers: headers(), cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`contents API returned ${res.status}`);
      const raw = (await res.json()) as Record<string, any>;
      const size = Number(raw.size ?? 0);
      if (size > 400_000) {
        const value = { repo, path: filePath, mode: "live" as const, sizeKb: Math.round(size / 1024), content: `file is ${Math.round(size / 1024)} KB — too large to preview here. Open it on GitHub instead.`, truncated: true, error: null };
        cache.set(key, { at: Date.now(), value });
        return value;
      }
      const content = raw.content ? Buffer.from(String(raw.content), "base64").toString("utf8") : "";
      const value = { repo, path: filePath, mode: "live" as const, sizeKb: Math.round(size / 1024), content: content.slice(0, 200_000), truncated: content.length > 200_000, error: null };
      cache.set(key, { at: Date.now(), value });
      return value;
    } catch (error) {
      if (!allowFallback) throw error;
      return fixtureFile(repo, filePath, error instanceof Error ? error.message : String(error));
    }
  }
  return fixtureFile(repo, filePath, "GitHub API unreachable");
}

async function githubStatusSafe(): Promise<boolean> {
  try {
    const rate = await githubRateInfo();
    return rate.reachable;
  } catch {
    return false;
  }
}

function fixtureFile(repo: string, filePath: string, error: string) {
  const content = FIXTURE_CONTENT[filePath] ?? `// simulated preview for ${filePath}\n// (GitHub was unreachable or this repository is private)\n`;
  return { repo, path: filePath, mode: "simulated" as const, sizeKb: Math.max(1, Math.round(content.length / 1024)), content, truncated: false, error };
}
