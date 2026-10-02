import { guard } from "@/lib/api";
import { listGithubDir, readGithubFile } from "@/lib/github-tree";
import { parseRepoRef } from "@/lib/github";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** GET /api/config/github/tree?repo=owner/name&path=dir[&file=1] */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const repoInput = params.get("repo") ?? "";
  const dirPath = (params.get("path") ?? "").replace(/^\/+/, "");
  const allowFallback = params.get("fallback") !== "0";
  return guard(async () => {
    const ref = parseRepoRef(repoInput);
    if (!ref) throw new Error("provide a repository as owner/name or a github.com URL");
    if (params.get("file") === "1") {
      const file = await readGithubFile(ref.fullName, dirPath, allowFallback);
      return { file, directory: null };
    }
    const directory = await listGithubDir(ref.fullName, dirPath, allowFallback);
    return { directory, file: null };
  });
}
