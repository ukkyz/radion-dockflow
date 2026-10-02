"use client";

import useSWR, { mutate as globalMutate } from "swr";

export interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
  error?: string;
  at: string;
}

export async function fetcher<T>(url: string): Promise<ApiEnvelope<T>> {
  const res = await fetch(url, { cache: "no-store" });
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !json.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json;
}

export async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !json.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json.data;
}

export async function apiPut<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !json.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json.data;
}

export async function apiDelete<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "DELETE" });
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !json.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json.data;
}

export function useApi<T>(url: string | null, refreshMs = 0) {
  const { data, error, isLoading, mutate } = useSWR<ApiEnvelope<T>>(url, fetcher, {
    refreshInterval: refreshMs,
    revalidateOnFocus: false,
    keepPreviousData: true,
  });
  return {
    data: data?.data,
    error: error instanceof Error ? error.message : data?.error,
    loading: isLoading,
    refresh: mutate,
    revalidate: () => globalMutate(url ?? ""),
  };
}

export function cls(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

export function timeAgo(input: string | null | undefined): string {
  if (!input) return "—";
  const diff = Date.now() - new Date(input).getTime();
  if (!Number.isFinite(diff)) return "—";
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [1000, "s"],
    [60_000, "m"],
    [3_600_000, "h"],
    [86_400_000, "d"],
  ];
  if (abs < 1000) return "just now";
  if (abs < 60_000) return `${Math.round(abs / units[0][0])}s ago`;
  if (abs < 3_600_000) return `${Math.round(abs / units[1][0])}m ago`;
  if (abs < 86_400_000) return `${Math.round(abs / units[2][0])}h ago`;
  return `${Math.round(abs / units[3][0])}d ago`;
}

export function fmtNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value.toFixed(digits);
}

export function fmtMb(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (value >= 1024) return `${(value / 1024).toFixed(2)} GB`;
  return `${value.toFixed(value < 10 ? 1 : 0)} MB`;
}

export function fmtMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${value.toFixed(value < 10 ? 1 : 0)} ms`;
}

export function stateTone(state: string | undefined, health?: string | null): "good" | "warn" | "bad" | "idle" {
  if (state === "running" || state === "up") {
    if (health === "unhealthy") return "bad";
    if (health === "starting") return "warn";
    return "good";
  }
  if (state === "restarting" || state === "paused" || state === "warn") return "warn";
  if (state === "exited" || state === "dead" || state === "down" || state === "created") return "idle";
  if (state === "demo" || state === "unknown") return "idle";
  return "idle";
}

export const TONE_CLASSES: Record<string, { dot: string; text: string; bg: string; border: string }> = {
  good: { dot: "bg-emerald-400", text: "text-emerald-300", bg: "bg-emerald-500/10", border: "border-emerald-500/30" },
  warn: { dot: "bg-amber-400", text: "text-amber-300", bg: "bg-amber-500/10", border: "border-amber-500/30" },
  bad: { dot: "bg-rose-500", text: "text-rose-300", bg: "bg-rose-500/10", border: "border-rose-500/30" },
  idle: { dot: "bg-slate-500", text: "text-slate-400", bg: "bg-slate-500/10", border: "border-slate-500/30" },
  info: { dot: "bg-sky-400", text: "text-sky-300", bg: "bg-sky-500/10", border: "border-sky-500/30" },
};

export function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
}
