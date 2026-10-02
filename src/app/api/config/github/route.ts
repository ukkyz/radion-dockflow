import { guard } from "@/lib/api";
import { githubRateInfo, loadGithubRepo, parseRepoRef } from "@/lib/github";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** GET /api/config/github?repo=owner/name[&fallback=0] */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const repo = params.get("repo");
  const allowFallback = params.get("fallback") !== "0";
  return guard(async () => {
    const rate = await githubRateInfo();
    if (!repo) {
      return { rate, ref: null, model: null, hint: "pass ?repo=owner/name (or a github.com URL) to build the repository graph" };
    }
    const ref = parseRepoRef(repo);
    if (!ref) throw new Error("provide a repository as owner/name or a github.com URL");
    const model = await loadGithubRepo(repo, allowFallback);
    return { rate: model.requestInfo, ref, model };
  });
}
