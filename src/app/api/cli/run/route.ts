import { eq } from "drizzle-orm";
import { db } from "@/db";
import { cliTools } from "@/db/schema";
import { guard, readJson } from "@/lib/api";
import { CANDIDATE_BINARIES, detectBinaries, runCli, tokenizeArgs } from "@/lib/cli";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return guard(async () => {
    if (params.get("detect") === "1") {
      const requested = params.get("binaries");
      const candidates = requested ? requested.split(",").map((b) => b.trim()).filter(Boolean) : CANDIDATE_BINARIES;
      return { available: await detectBinaries(candidates) };
    }
    return { candidates: CANDIDATE_BINARIES };
  });
}

export async function POST(request: Request) {
  const body = await readJson<{
    toolId?: string;
    binary?: string;
    args?: string | string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }>(request);
  return guard(async () => {
    let binary = body.binary ?? "";
    let args: string[] = Array.isArray(body.args) ? body.args : tokenizeArgs(body.args ?? "");
    let cwd = body.cwd;
    let env = body.env ?? {};

    if (body.toolId) {
      const rows = await db.select().from(cliTools).where(eq(cliTools.id, body.toolId)).limit(1);
      if (!rows.length) throw new Error("cli tool not found");
      const tool = rows[0];
      binary = binary || tool.binary;
      if (!Array.isArray(body.args) && body.args === undefined) args = tokenizeArgs(tool.baseArgs);
      else if (tool.baseArgs) args = [...tokenizeArgs(tool.baseArgs), ...args];
      cwd = cwd || tool.cwd;
      env = { ...tool.envVars, ...env };
    }
    if (!binary) throw new Error("binary or toolId is required");

    const result = await runCli({
      binary,
      args,
      cwd: cwd || process.cwd(),
      env,
      timeoutMs: Math.min(120_000, Number(body.timeoutMs ?? 30_000) || 30_000),
    });
    return result;
  });
}
