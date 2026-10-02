import { guard, readJson } from "@/lib/api";
import { parseCompose } from "@/lib/compose-parser";
import { parseTerraform } from "@/lib/terraform-parser";
import { discoverConfigFiles, readWorkspaceFile, siblingTerraformFiles } from "@/lib/config-files";
import { loadGithubRepo } from "@/lib/github";
import { ensureSeed } from "@/lib/seed";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Parse (and optionally persist) a configuration source. */
export async function POST(request: Request) {
  const body = await readJson<{
    kind?: string;
    content?: string;
    path?: string;
    files?: { name: string; content: string }[];
    repo?: string;
    save?: boolean;
    name?: string;
    allowFallback?: boolean;
  }>(request);

  return guard(async () => {
    await ensureSeed();
    const kind = body.kind ?? "compose";

    if (kind === "compose") {
      let content = body.content;
      let file = body.path ?? body.name ?? "docker-compose.yml";
      if (!content && body.path) {
        const read = readWorkspaceFile(body.path);
        content = read.content;
        file = read.relative;
      }
      if (!content) throw new Error("provide yaml content or a workspace path");
      const model = parseCompose(content, file);
      const status = model.findings.some((finding) => finding.level === "error") ? "error" : "ready";
      return {
        model,
        kind: model.kind,
        saved: body.save
          ? {
              status,
              lastError: model.findings.find((finding) => finding.level === "error")?.message ?? null,
            }
          : null,
        files: body.path ? discoverConfigFiles() : [],
      };
    }

    if (kind === "terraform") {
      let files = body.files ?? [];
      if (!files.length && body.path) {
        const read = readWorkspaceFile(body.path);
        files = siblingTerraformFiles(read.path);
        if (!files.length) files = [{ name: read.relative, content: read.content }];
      }
      if (!files.length && body.content) files = [{ name: body.name ?? "main.tf", content: body.content }];
      if (!files.length) throw new Error("provide HCL content, files[] or a workspace path");
      const model = parseTerraform(files);
      return {
        model,
        kind: model.kind,
        saved: body.save
          ? {
              status: model.findings.some((finding) => finding.level === "error") ? "error" : "ready",
              lastError: model.findings.find((finding) => finding.level === "error")?.message ?? null,
            }
          : null,
        files: body.path ? discoverConfigFiles() : [],
      };
    }

    if (kind === "github") {
      const model = await loadGithubRepo(body.repo ?? "", body.allowFallback ?? true);
      return { model, kind: model.kind, saved: null, files: [] };
    }

    throw new Error(`unsupported kind "${kind}" (compose | terraform | github)`);
  });
}

/** Discover compose/terraform files in the workspace. */
export async function GET() {
  return guard(async () => {
    const files = discoverConfigFiles();
    return {
      files,
      root: process.cwd(),
      counts: {
        compose: files.filter((file) => file.kind === "compose").length,
        terraform: files.filter((file) => file.kind === "terraform").length,
        total: files.length,
      },
    };
  });
}
