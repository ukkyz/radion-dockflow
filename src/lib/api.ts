import { NextResponse } from "next/server";

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data, at: new Date().toISOString() }, init);
}

export function fail(error: unknown, status = 500): NextResponse {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "unexpected error";
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function guard<T>(fn: () => Promise<T>, status = 200): Promise<NextResponse> {
  try {
    const data = await fn();
    return ok(data, { status });
  } catch (error) {
    console.error("[api]", error);
    return fail(error, status === 200 ? 500 : status);
  }
}

export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}
