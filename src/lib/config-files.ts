import fs from "node:fs";
import path from "node:path";

const COMPOSE_NAMES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "docker-compose.override.yml",
  "compose.override.yaml",
];

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".turbo", ".vercel", "out", "vendor", "__pycache__"]);

export interface DiscoveredFile {
  path: string;
  relative: string;
  kind: "compose" | "terraform";
  sizeKb: number;
  modified: string;
}

/** Walks the workspace (bounded) looking for compose + terraform files. */
export function discoverConfigFiles(root = process.cwd(), maxDepth = 4, maxFiles = 120): DiscoveredFile[] {
  const found: DiscoveredFile[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || found.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      const isCompose = COMPOSE_NAMES.includes(lower);
      const isTerraform = lower.endsWith(".tf") || lower.endsWith(".tfvars");
      if (!isCompose && !isTerraform) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.size > 2 * 1024 * 1024) continue;
        found.push({
          path: full,
          relative: path.relative(root, full) || entry.name,
          kind: isCompose ? "compose" : "terraform",
          sizeKb: Math.round(stat.size / 1024),
          modified: stat.mtime.toISOString(),
        });
      } catch {
        /* unreadable file — skip */
      }
    }
  };
  walk(root, 0);
  return found.sort((a, b) => a.relative.localeCompare(b.relative));
}

/** Reads a file, refusing anything outside the workspace root. */
export function readWorkspaceFile(target: string, root = process.cwd()): { path: string; relative: string; content: string } {
  const resolved = path.resolve(root, target);
  const rootResolved = path.resolve(root);
  if (!resolved.startsWith(rootResolved)) throw new Error(`path escapes the workspace root: ${target}`);
  if (!fs.existsSync(resolved)) throw new Error(`file not found: ${target}`);
  const stat = fs.statSync(resolved);
  if (stat.size > 1024 * 1024) throw new Error(`file is larger than 1 MB (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  return { path: resolved, relative: path.relative(rootResolved, resolved), content: fs.readFileSync(resolved, "utf8") };
}

/** Groups .tf files that belong to the same terraform module directory. */
export function siblingTerraformFiles(filePath: string): { name: string; content: string }[] {
  const dir = path.dirname(filePath);
  const out: { name: string; content: string }[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".tf")) continue;
      const full = path.join(dir, entry.name);
      const stat = fs.statSync(full);
      if (stat.size > 1024 * 1024) continue;
      out.push({ name: entry.name, content: fs.readFileSync(full, "utf8") });
    }
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
