import { spawn } from "node:child_process";
import type { CliRunResult } from "./types";

/**
 * Runs a CLI process without a shell so arguments can never be interpreted as
 * shell syntax. A small deny-list blocks obvious self-destructive commands while
 * everything else (docker, compose, kubectl, psql, terraform, ...) is allowed -
 * this console is meant to drive local tooling the same way a terminal would.
 */

const DENY_PATTERNS: RegExp[] = [
  /\brm\s+-rf\s+\/(\s|$)/,
  /\bmkfs(\.[a-z0-9]+)?\b/i,
  /\bdd\s+if=.*of=\/dev\/(sd|nvme|disk)/i,
  /:\(\)\s*\{\s*:\|:&\s*\}/,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bdiskpart\b/i,
  /\bformat\s+[a-z]:/i,
];

export interface RunCliOptions {
  binary: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

export function assertSafeCommand(binary: string, args: string[]): void {
  if (!binary || /[;&|`$><\n]/.test(binary)) {
    throw new Error("binary name contains shell metacharacters");
  }
  const line = `${binary} ${args.join(" ")}`;
  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(line)) throw new Error(`command blocked by safety policy: ${line}`);
  }
}

export async function runCli(options: RunCliOptions): Promise<CliRunResult> {
  const args = options.args ?? [];
  assertSafeCommand(options.binary, args);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? 400_000;
  const startedAt = Date.now();
  const command = [options.binary, ...args].join(" ");

  return new Promise<CliRunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        exitCode,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        truncated,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.binary, args, {
        cwd: options.cwd && options.cwd.trim() ? options.cwd : process.cwd(),
        env: { ...process.env, ...(options.env ?? {}) },
        shell: false,
      });
    } catch (error) {
      resolve({
        command,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        truncated: false,
      });
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n[console] command exceeded ${timeoutMs}ms and was killed`;
      finish(null);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length + stderr.length > maxBytes) {
        truncated = true;
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stdout.length + stderr.length > maxBytes) {
        truncated = true;
        return;
      }
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      stderr += `${error.message}${(error as NodeJS.ErrnoException).code === "ENOENT" ? ` (binary "${options.binary}" not found on PATH)` : ""}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/** Which of the interesting local CLIs actually exist on this host. */
/** Split a command line into argv, honouring single/double quotes. */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of input) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Shortlist of CLIs worth probing for on this host. */
export const CANDIDATE_BINARIES = ["docker", "kubectl", "psql", "node", "npm", "git", "python3", "terraform", "helm", "curl"];

export async function detectBinaries(candidates: string[]): Promise<Record<string, string | null>> {
  const entries = await Promise.all(
    candidates.map(async (binary) => {
      const result = await runCli({ binary, args: ["--version"], timeoutMs: 4000 });
      const missing = /ENOENT|not found on PATH|command not found/i.test(`${result.stderr} ${result.stdout}`);
      if (!missing && (result.exitCode === 0 || result.stdout || result.stderr)) {
        const line = (result.stdout || result.stderr).split("\n").find((l) => l.trim());
        return [binary, line?.trim().slice(0, 120) ?? "available"] as const;
      }
      return [binary, null] as const;
    }),
  );
  return Object.fromEntries(entries);
}
