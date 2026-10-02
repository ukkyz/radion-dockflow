import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { jvmDumps, jvmTargets } from "@/db/schema";
import { listContainers } from "./docker";
import type {
  JvmAllocation,
  JvmDeadlock,
  JvmDumpSummary,
  JvmFrame,
  JvmGcEvent,
  JvmHistoryPoint,
  JvmHotMethod,
  JvmMBean,
  JvmMemoryPool,
  JvmMethodNode,
  JvmProfile,
  JvmSnapshot,
  JvmTarget,
  JvmTargetKind,
  JvmThread,
  JvmThreadResponse,
} from "./types";

/**
 * Java monitoring engine.
 *
 * Real integration paths (both are what JVisualVM itself uses, minus RMI):
 *  - Jolokia JMX-over-HTTP bridge  -> POST {url} with bulk read/exec requests
 *    (start your JVM with -javaagent:jolokia-jvm.jar=port=8778)
 *  - Spring Boot Actuator          -> {url}/metrics/*, /threaddump, /heapdump
 * Sampling a remote JVM is done by repeatedly pulling thread stacks, which is
 * exactly how jvisualvm's sampler builds a statistical CPU profile.
 *
 * When nothing answers (this sandbox), a simulated JVM model keeps every view
 * live and is labelled as simulated in the UI.
 */

const globalForJvm = globalThis as typeof globalThis & {
  __jvmState?: Map<string, SimState>;
  __jvmHistory?: Map<string, JvmHistoryPoint[]>;
  __jvmGcEvents?: Map<string, JvmGcEvent[]>;
  __jvmProfiles?: Map<string, ProfileSession>;
  __jvmProbeCache?: Map<string, { at: number; online: boolean; version?: string; vendor?: string; error?: string }>;
};

const simStates = globalForJvm.__jvmState ?? new Map<string, SimState>();
globalForJvm.__jvmState = simStates;
const history = globalForJvm.__jvmHistory ?? new Map<string, JvmHistoryPoint[]>();
globalForJvm.__jvmHistory = history;
const gcEventsStore = globalForJvm.__jvmGcEvents ?? new Map<string, JvmGcEvent[]>();
globalForJvm.__jvmGcEvents = gcEventsStore;
const profiles = globalForJvm.__jvmProfiles ?? new Map<string, ProfileSession>();
globalForJvm.__jvmProfiles = profiles;
const probeCache = globalForJvm.__jvmProbeCache ?? new Map<string, { at: number; online: boolean; version?: string; vendor?: string; error?: string }>();
globalForJvm.__jvmProbeCache = probeCache;

const PROBE_TTL_MS = 12_000;
const HISTORY_MAX = 90;
const GC_EVENT_MAX = 120;
const MB = 1024 * 1024;

/* ------------------------------------------------------------------ */
/* targets                                                             */
/* ------------------------------------------------------------------ */

const JAVA_HINTS = /java|jvm|jdk|jre|jar|spring|tomcat|wildfly|quarkus|kotlin|scala|gradle|maven|hadoop|cassandra|elastic|kafka|zookeeper/i;

const APP_CATALOG: { key: string; app: string; heapMb: number; collector: string; version: string; vendor: string; pid: number }[] = [
  { key: "catalog", app: "catalog-service", heapMb: 2048, collector: "G1 Young Generation", version: "21.0.4+7-LTS", vendor: "Eclipse Adoptium", pid: 1 },
  { key: "search", app: "search-indexer", heapMb: 1024, collector: "G1 Young Generation", version: "17.0.11+9-LTS", vendor: "Amazon Corretto", pid: 1 },
];

function pickApp(name: string, index: number) {
  const lower = name.toLowerCase();
  const found = APP_CATALOG.find((entry) => lower.includes(entry.key));
  if (found) return found;
  return {
    app: name,
    heapMb: 1024 + index * 512,
    collector: "G1 Young Generation",
    version: index % 2 === 0 ? "21.0.4+7-LTS" : "17.0.11+9-LTS",
    vendor: index % 2 === 0 ? "Eclipse Adoptium" : "Amazon Corretto",
    pid: 1,
  };
}

function rowToTarget(row: typeof jvmTargets.$inferSelect): JvmTarget {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as JvmTargetKind,
    url: row.url,
    host: row.host,
    app: row.app || row.name,
    containerId: row.containerId,
    project: row.project,
    autoDiscovered: row.autoDiscovered,
    status: row.status as JvmTarget["status"],
    jvmVersion: row.jvmVersion,
    javaVendor: row.javaVendor,
    lastError: row.lastError,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    source: row.source as "manual" | "engine",
    createdAt: row.createdAt.toISOString(),
  };
}

/** Java processes discovered on the engine: containers that look like JVMs. */
export async function discoverJvmProcesses(): Promise<JvmTarget[]> {
  try {
    const { containers } = await listContainers();
    const jvms = containers.filter(
      (c) => JAVA_HINTS.test(`${c.image} ${c.command} ${c.composeService ?? ""} ${c.name}`) || c.labels["com.docker.compose.service"] === "catalog",
    );
    return jvms.map((c, index) => {
      const meta = pickApp(c.composeService ?? c.name, index);
      return {
        id: `auto:${c.id}`,
        name: `${c.name} (engine)`,
        kind: "simulated" as JvmTargetKind,
        url: "",
        host: "container",
        app: meta.app,
        containerId: c.id,
        project: c.composeProject,
        autoDiscovered: true,
        status: "simulated" as const,
        jvmVersion: meta.version,
        javaVendor: meta.vendor,
        lastError: null,
        lastSeenAt: new Date().toISOString(),
        source: "engine" as const,
        createdAt: new Date().toISOString(),
      };
    });
  } catch {
    return [];
  }
}

export async function listJvmTargets(): Promise<JvmTarget[]> {
  const rows = await db.select().from(jvmTargets).orderBy(desc(jvmTargets.createdAt));
  const manual = await Promise.all(rows.map(async (row) => probeTarget(rowToTarget(row), false)));
  const discovered = await discoverJvmProcesses();
  const names = new Set(manual.map((t) => t.name));
  return [...manual, ...discovered.filter((t) => !names.has(t.name))];
}

export async function resolveJvmTarget(id: string): Promise<JvmTarget | null> {
  if (id.startsWith("auto:")) {
    const containerId = id.slice(5);
    const discovered = await discoverJvmProcesses();
    return discovered.find((t) => t.containerId === containerId || t.id === id) ?? null;
  }
  const rows = await db.select().from(jvmTargets).where(eq(jvmTargets.id, id)).limit(1);
  if (rows.length) return rowToTarget(rows[0]);
  const discovered = await discoverJvmProcesses();
  return discovered.find((t) => t.name === id) ?? null;
}

export async function addJvmTarget(input: { name?: string; kind?: string; url?: string; app?: string }): Promise<JvmTarget> {
  const kind = (["jolokia", "actuator", "simulated"].includes(input.kind ?? "") ? input.kind : "simulated") as JvmTargetKind;
  const url = (input.url ?? "").trim();
  if (kind !== "simulated" && !url) throw new Error(`${kind} targets need a url (e.g. http://host:8778/jolokia)`);
  const name = (input.name ?? "").trim() || `${kind}-${new URL(url.startsWith("http") ? url : `http://${url}`).hostname}:${new URL(url.startsWith("http") ? url : `http://${url}`).port}`;
  const existing = await db.select().from(jvmTargets).where(eq(jvmTargets.name, name)).limit(1);
  if (existing.length) {
    await db.update(jvmTargets).set({ url, kind, app: input.app ?? existing[0].app, status: "unknown" }).where(eq(jvmTargets.id, existing[0].id));
    probeCache.delete(existing[0].id);
    return rowToTarget({ ...existing[0], url, kind, status: "unknown" });
  }
  const host = (() => {
    try {
      return new URL(url.startsWith("http") ? url : `http://${url}`).hostname;
    } catch {
      return "localhost";
    }
  })();
  const inserted = await db
    .insert(jvmTargets)
    .values({
      name,
      kind,
      url,
      host,
      app: input.app ?? name,
      status: "unknown",
      source: "manual",
      autoDiscovered: false,
    })
    .returning();
  const target = rowToTarget(inserted[0]);
  probeCache.delete(target.id);
  return probeTarget(target, true);
}

export async function removeJvmTarget(id: string): Promise<void> {
  await db.delete(jvmTargets).where(eq(jvmTargets.id, id));
  await db.delete(jvmDumps).where(eq(jvmDumps.targetId, id));
  simStates.delete(id);
  history.delete(id);
  gcEventsStore.delete(id);
  probeCache.delete(id);
}

/* ------------------------------------------------------------------ */
/* probing                                                             */
/* ------------------------------------------------------------------ */

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 2500): Promise<Record<string, any>> {
  const res = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as Record<string, any>;
}

function jolokiaBase(url: string): string {
  const trimmed = url.replace(/\/$/, "");
  return trimmed.endsWith("/jolokia") ? trimmed : `${trimmed}/jolokia`;
}

function actuatorBase(url: string): string {
  const trimmed = url.replace(/\/$/, "");
  return trimmed.endsWith("/actuator") ? trimmed : `${trimmed}/actuator`;
}

/** Jolokia bulk protocol: an array of read/exec requests in one POST. */
async function jolokia(requests: Record<string, unknown>[], url: string, timeoutMs = 3500): Promise<any[]> {
  const res = await fetch(jolokiaBase(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requests),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`jolokia ${res.status} ${res.statusText}`);
  const json = (await res.json()) as any;
  return Array.isArray(json) ? json : [json];
}

async function probeTarget(target: JvmTarget, force: boolean): Promise<JvmTarget> {
  if (target.kind === "simulated" || target.autoDiscovered) {
    return { ...target, status: "simulated", lastError: null, lastSeenAt: new Date().toISOString() };
  }
  const cached = probeCache.get(target.id);
  if (!force && cached && Date.now() - cached.at < PROBE_TTL_MS) {
    return {
      ...target,
      status: cached.online ? "online" : "offline",
      jvmVersion: cached.version ?? target.jvmVersion,
      javaVendor: cached.vendor ?? target.javaVendor,
      lastError: cached.error ?? null,
    };
  }
  let online = false;
  let version: string | undefined;
  let vendor: string | undefined;
  let error: string | null = null;
  try {
    if (target.kind === "jolokia") {
      const [result] = await jolokia([{ type: "version" }], target.url, 2500);
      if (result?.status !== 200) throw new Error(result?.error ?? "jolokia rejected the request");
      version = result.value?.protocol ? `agent ${result.value.agent} protocol ${result.value.protocol}` : undefined;
      online = true;
    } else {
      const metrics = await fetchJson(`${actuatorBase(target.url)}/metrics/jvm.memory.used`, undefined, 2500);
      online = Array.isArray(metrics?.measurements);
      if (!online) error = "actuator responded but jvm.memory.used is missing";
    }
  } catch (probeError) {
    error = probeError instanceof Error ? probeError.message : String(probeError);
  }
  probeCache.set(target.id, { at: Date.now(), online, version, vendor, error: error ?? undefined });
  try {
    await db
      .update(jvmTargets)
      .set({
        status: online ? "online" : "offline",
        lastError: error,
        lastSeenAt: new Date(),
        jvmVersion: version ?? target.jvmVersion,
        javaVendor: vendor ?? target.javaVendor,
      })
      .where(eq(jvmTargets.id, target.id));
  } catch {
    /* ignore */
  }
  return { ...target, status: online ? "online" : "offline", jvmVersion: version ?? target.jvmVersion, javaVendor: vendor ?? target.javaVendor, lastError: error, lastSeenAt: new Date().toISOString() };
}

/* ------------------------------------------------------------------ */
/* simulated JVM                                                       */
/* ------------------------------------------------------------------ */

interface SimState {
  app: string;
  pid: number;
  version: string;
  vendor: string;
  collector: string;
  uptimeOffsetMs: number;
  heapMaxMb: number;
  edenMaxMb: number;
  survivorMaxMb: number;
  oldMaxMb: number;
  metaspaceMaxMb: number;
  codeCacheMaxMb: number;
  compressedClassMaxMb: number;
  edenUsed: number;
  survivorUsed: number;
  oldUsed: number;
  metaspaceUsed: number;
  codeCacheUsed: number;
  compressedClassUsed: number;
  youngCount: number;
  oldCount: number;
  youngTimeMs: number;
  oldTimeMs: number;
  threadsLive: number;
  threadsDaemon: number;
  threadsPeak: number;
  threadsStarted: number;
  classesLoaded: number;
  classesUnloaded: number;
  cpuProcess: number;
  cpuSystem: number;
  processCpuTimeMs: number;
  lastTick: number;
  allocRateMbPerSec: number;
  hostname: string;
}

const GC_CAUSES_YOUNG = ["G1 Evacuation Pause", "G1 Humongous Allocation", "Allocation Failure", "G1 Evacuation Pause (young)"];
const GC_CAUSES_OLD = ["G1 Evacuation Pause (mixed)", "Metadata GC Threshold", "System.gc()", "G1 Compaction Pause", "Heap Dump Initiated GC"];

function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function simFor(target: JvmTarget): SimState {
  const existing = simStates.get(target.id);
  if (existing) return existing;
  const seed = hashSeed(target.name);
  const meta = pickApp(target.app || target.name, seed % 3);
  const heapMaxMb = meta.heapMb;
  const state: SimState = {
    app: meta.app,
    pid: meta.pid,
    version: meta.version,
    vendor: meta.vendor,
    collector: meta.collector,
    uptimeOffsetMs: (seed % 40) * 60_000 + 5 * 60_000,
    heapMaxMb,
    edenMaxMb: Math.round(heapMaxMb * 0.28),
    survivorMaxMb: Math.round(heapMaxMb * 0.05),
    oldMaxMb: Math.round(heapMaxMb * 0.62),
    metaspaceMaxMb: Math.max(256, Math.round(heapMaxMb * 0.25)),
    codeCacheMaxMb: 240,
    compressedClassMaxMb: 1024,
    edenUsed: Math.round(heapMaxMb * 0.12),
    survivorUsed: Math.round(heapMaxMb * 0.01),
    oldUsed: Math.round(heapMaxMb * 0.31),
    metaspaceUsed: Math.round(heapMaxMb * 0.06) + 40,
    codeCacheUsed: 38 + (seed % 40),
    compressedClassUsed: 24 + (seed % 20),
    youngCount: 1200 + (seed % 800),
    oldCount: 3 + (seed % 9),
    youngTimeMs: 9000 + (seed % 6000),
    oldTimeMs: 400 + (seed % 900),
    threadsLive: 46 + (seed % 30),
    threadsDaemon: 32 + (seed % 18),
    threadsPeak: 60 + (seed % 40),
    threadsStarted: 9000 + (seed % 4000),
    classesLoaded: 11600 + (seed % 3000),
    classesUnloaded: 20 + (seed % 60),
    cpuProcess: 0.18 + (seed % 20) / 100,
    cpuSystem: 0.24 + (seed % 15) / 100,
    processCpuTimeMs: 3_000_000 + (seed % 900_000),
    lastTick: Date.now(),
    allocRateMbPerSec: 6 + (seed % 9),
    hostname: `${target.app || "jvm"}-host`,
  };
  simStates.set(target.id, state);
  prefillHistory(target, state);
  return state;
}

function pushGcEvent(target: JvmTarget, event: JvmGcEvent) {
  const list = gcEventsStore.get(target.id) ?? [];
  list.unshift(event);
  gcEventsStore.set(target.id, list.slice(0, GC_EVENT_MAX));
}

function tickSim(target: JvmTarget, state: SimState): void {
  const now = Date.now();
  const dt = Math.max(0, Math.min(20, (now - state.lastTick) / 1000));
  state.lastTick = now;
  if (dt === 0) return;
  const t = (state.uptimeOffsetMs + (now - state.lastTick) + now % 1_000_000) / 1000;

  // allocation into eden
  const alloc = state.allocRateMbPerSec * dt * (0.7 + Math.random() * 0.6);
  state.edenUsed += alloc;
  state.processCpuTimeMs += state.cpuProcess * dt * 1000;

  if (state.edenUsed >= state.edenMaxMb) {
    const pauseMs = +(6 + Math.random() * 34 + (state.edenUsed / state.edenMaxMb) * 12).toFixed(1);
    const reclaimed = +(state.edenUsed * 0.94).toFixed(1);
    const promoted = +(state.edenUsed * (0.05 + Math.random() * 0.05)).toFixed(1);
    state.oldUsed += promoted;
    state.edenUsed = +(state.edenMaxMb * 0.04 + Math.random() * 12).toFixed(1);
    state.survivorUsed = +(state.survivorMaxMb * (0.4 + Math.random() * 0.5)).toFixed(1);
    state.youngCount += 1;
    state.youngTimeMs += pauseMs;
    pushGcEvent(target, {
      at: new Date(now).toISOString(),
      kind: "young",
      cause: GC_CAUSES_YOUNG[Math.floor(Math.random() * GC_CAUSES_YOUNG.length)],
      pauseMs,
      reclaimedMb: reclaimed,
    });
  }

  const oldFull = state.oldUsed / state.oldMaxMb > 0.86;
  const metaPressure = state.metaspaceUsed / state.metaspaceMaxMb > 0.82;
  const periodicFull = Math.random() < dt / 55;
  if (oldFull || metaPressure || periodicFull) {
    const pauseMs = +(120 + Math.random() * 480).toFixed(1);
    const reclaimed = +(state.oldUsed * (0.3 + Math.random() * 0.28)).toFixed(1);
    state.oldUsed = Math.max(state.oldMaxMb * 0.18, state.oldUsed - reclaimed);
    const cause = metaPressure
      ? "Metadata GC Threshold"
      : oldFull
        ? "G1 Evacuation Pause (mixed)"
        : GC_CAUSES_OLD[Math.floor(Math.random() * GC_CAUSES_OLD.length)];
    state.oldCount += 1;
    state.oldTimeMs += pauseMs;
    pushGcEvent(target, {
      at: new Date(now).toISOString(),
      kind: metaPressure ? "meta" : "old",
      cause,
      pauseMs,
      reclaimedMb: reclaimed,
    });
  }

  // metaspace / code cache / classes grow slowly
  state.metaspaceUsed = Math.min(state.metaspaceMaxMb * 0.96, state.metaspaceUsed + dt * 0.045);
  state.codeCacheUsed = Math.min(state.codeCacheMaxMb * 0.92, state.codeCacheUsed + dt * 0.01);
  state.compressedClassUsed = Math.min(state.compressedClassMaxMb * 0.6, state.compressedClassUsed + dt * 0.004);
  if (Math.random() < dt / 2.5) {
    state.classesLoaded += 1 + Math.floor(Math.random() * 3);
    if (Math.random() < 0.25) state.classesUnloaded += 1;
  }

  // threads + cpu
  const wobble = Math.sin(t / 9) * 0.18 + Math.sin(t / 2.7) * 0.08;
  state.threadsLive = Math.max(18, Math.round(state.threadsLive + wobble + (Math.random() - 0.5) * 2));
  state.threadsDaemon = Math.min(state.threadsLive - 4, Math.max(8, Math.round(state.threadsDaemon + (Math.random() - 0.5) * 1.5)));
  state.threadsPeak = Math.max(state.threadsPeak, state.threadsLive);
  if (Math.random() < dt / 6) state.threadsStarted += 1 + Math.floor(Math.random() * 4);
  state.cpuProcess = Math.min(0.97, Math.max(0.03, state.cpuProcess + wobble * 0.6 + (Math.random() - 0.5) * 0.08));
  state.cpuSystem = Math.min(0.98, Math.max(0.05, state.cpuSystem + wobble * 0.4 + (Math.random() - 0.5) * 0.06));
}

/** Seed a plausible back-history so charts render immediately for simulated JVMs. */
function prefillHistory(target: JvmTarget, state: SimState, points = 30, stepMs = 3000): void {
  const existing = history.get(target.id);
  if (existing && existing.length > 4) return;
  const now = Date.now();
  const seeded: JvmHistoryPoint[] = [];
  let eden = state.edenUsed;
  let old = state.oldUsed;
  let metaspace = Math.max(24, state.metaspaceUsed - points * 0.05);
  let classes = state.classesLoaded - points * 2;
  for (let index = points; index >= 0; index -= 1) {
    const t = (now - index * stepMs) / 1000;
    eden = eden + (state.edenMaxMb * 0.05) * (1 + Math.sin(t / 7));
    const youngGc = eden >= state.edenMaxMb;
    if (youngGc) {
      eden = state.edenMaxMb * 0.06;
      old += state.edenMaxMb * 0.06;
    }
    if (old / state.oldMaxMb > 0.82) old = state.oldMaxMb * 0.34;
    metaspace += 0.16;
    classes += 2;
    seeded.push({
      ts: new Date(now - index * stepMs).toISOString(),
      heapUsedMb: +(eden + state.survivorUsed + old).toFixed(1),
      heapCommittedMb: +(state.heapMaxMb * 0.86).toFixed(1),
      nonHeapMb: +(metaspace + state.codeCacheUsed + state.compressedClassUsed).toFixed(1),
      metaspaceMb: +metaspace.toFixed(1),
      edenMb: +eden.toFixed(1),
      survivorMb: +state.survivorUsed.toFixed(1),
      oldMb: +old.toFixed(1),
      threadsLive: Math.max(16, Math.round(state.threadsLive + Math.sin(t / 9) * 5)),
      cpuProcess: +Math.min(97, Math.max(3, state.cpuProcess * 100 + Math.sin(t / 4.5) * 14)).toFixed(1),
      classesLoaded: Math.round(classes),
      gcCount: state.youngCount + state.oldCount - Math.round(index / 3),
      gcTimeMs: Math.round(state.youngTimeMs + state.oldTimeMs - index * 4),
    });
  }
  history.set(target.id, seeded.slice(-HISTORY_MAX));

  const events: JvmGcEvent[] = [];
  for (let index = 12; index >= 1; index -= 1) {
    const mixed = index % 5 === 0;
    events.push({
      at: new Date(now - index * stepMs * 2).toISOString(),
      kind: mixed ? "old" : "young",
      cause: mixed ? "G1 Evacuation Pause (mixed)" : GC_CAUSES_YOUNG[index % GC_CAUSES_YOUNG.length],
      pauseMs: +(mixed ? 140 + Math.random() * 380 : 7 + Math.random() * 30).toFixed(1),
      reclaimedMb: +(mixed ? state.oldMaxMb * 0.2 : state.edenMaxMb * 0.9).toFixed(1),
    });
  }
  gcEventsStore.set(target.id, events.reverse());
}

function recordHistory(target: JvmTarget, state: SimState, point: JvmHistoryPoint) {
  const list = history.get(target.id) ?? [];
  const last = list[list.length - 1];
  if (last && Date.now() - new Date(last.ts).getTime() < 1500) return;
  list.push(point);
  history.set(target.id, list.slice(-HISTORY_MAX));
}

/* ------------------------------------------------------------------ */
/* thread stacks (simulated) + thread dump parsing (real)              */
/* ------------------------------------------------------------------ */

const FRAME_LIBRARY: Record<string, JvmFrame[][]> = {
  web: [
    [
      { className: "com.vega.catalog.web.CatalogController", methodName: "listProducts", fileName: "CatalogController.java", line: 118 },
      { className: "java.base/jdk.internal.reflect.DirectMethodHandleAccessor", methodName: "invoke", fileName: "DirectMethodHandleAccessor.java", line: 103 },
      { className: "org.springframework.web.servlet.DispatcherServlet", methodName: "doDispatch", fileName: "DispatcherServlet.java", line: 1082 },
      { className: "org.apache.catalina.core.ApplicationFilterChain", methodName: "doFilter", fileName: "ApplicationFilterChain.java", line: 183 },
    ],
    [
      { className: "com.vega.catalog.web.CartController", methodName: "checkout", fileName: "CartController.java", line: 87 },
      { className: "org.springframework.transaction.interceptor.TransactionInterceptor", methodName: "invokeWithinTransaction", line: 397 },
      { className: "org.springframework.aop.framework.CglibAopProxy", methodName: "invoke", line: 795 },
    ],
  ],
  repository: [
    [
      { className: "com.vega.catalog.repo.ProductRepository", methodName: "findBySku", fileName: "ProductRepository.java", line: 64 },
      { className: "org.hibernate.query.sqm.internal.ConcreteSqmSelectQueryPlan", methodName: "performList", line: 397 },
      { className: "org.postgresql.core.v3.QueryExecutorImpl", methodName: "execute", line: 1414 },
      { className: "java.base/java.net.SocketInputStream", methodName: "socketRead0", fileName: "SocketInputStream.java", line: 706 },
    ],
    [
      { className: "com.vega.catalog.repo.InventoryRepository", methodName: "decrement", line: 152 },
      { className: "org.hibernate.internal.SessionImpl", methodName: "flush", line: 741 },
      { className: "org.postgresql.jdbc.PgPreparedStatement", methodName: "executeUpdate", line: 346 },
    ],
  ],
  jackson: [
    [
      { className: "com.fasterxml.jackson.databind.ObjectMapper", methodName: "writeValueAsString", fileName: "ObjectMapper.java", line: 3548 },
      { className: "com.fasterxml.jackson.databind.ser.BeanSerializer", methodName: "serialize", line: 479 },
      { className: "com.fasterxml.jackson.core.json.UTF8JsonGenerator", methodName: "writeString", line: 1058 },
    ],
    [
      { className: "com.fasterxml.jackson.databind.ObjectMapper", methodName: "_readMapAndClose", line: 4210 },
      { className: "com.fasterxml.jackson.core.json.UTF8StreamJsonParser", methodName: "nextToken", line: 1049 },
    ],
  ],
  cache: [
    [
      { className: "com.vega.catalog.cache.CatalogCache", methodName: "getWithTtl", fileName: "CatalogCache.java", line: 73 },
      { className: "com.github.benmanes.caffeine.cache.BoundedLocalCache", methodName: "computeIfAbsent", line: 2742 },
      { className: "java.base/java.util.concurrent.ConcurrentHashMap", methodName: "computeIfAbsent", line: 1741 },
    ],
  ],
  kafka: [
    [
      { className: "org.apache.kafka.clients.consumer.internals.ConsumerNetworkClient", methodName: "poll", line: 271 },
      { className: "org.apache.kafka.clients.consumer.KafkaConsumer", methodName: "poll", line: 2110 },
      { className: "com.vega.catalog.events.InventoryProjectionListener", methodName: "onMessage", line: 141 },
    ],
  ],
  json: [
    [
      { className: "java.base/java.lang.String", methodName: "format", fileName: "String.java", line: 3484 },
      { className: "com.vega.catalog.dto.ProductDto", methodName: "toString", fileName: "ProductDto.java", line: 96 },
    ],
  ],
  jvm: [
    [
      { className: "java.base/java.lang.ref.Reference", methodName: "processPendingReferences", fileName: "Reference.java", line: 311 },
      { className: "java.base/java.lang.ref.Reference$ReferenceHandler", methodName: "run", line: 224 },
    ],
    [
      { className: "java.base/java.lang.ref.Finalizer$FinalizerThread", methodName: "run", line: 189 },
    ],
  ],
};

const THREAD_POOLS: { pattern: string; count: (seed: number) => number; scenario: (keyof typeof FRAME_LIBRARY)[]; daemon: boolean }[] = [
  { pattern: "http-nio-8080-exec", count: (s) => 12 + (s % 10), scenario: ["web", "repository", "jackson", "cache"], daemon: false },
  { pattern: "grpc-default-executor", count: (s) => 4 + (s % 4), scenario: ["repository", "cache"], daemon: false },
  { pattern: "kafka-consumer-inventory", count: () => 3, scenario: ["kafka"], daemon: false },
  { pattern: "schedulers-default", count: () => 4, scenario: ["cache", "repository"], daemon: true },
  { pattern: "G1 Young RemSet Sampling", count: () => 2, scenario: ["jvm"], daemon: true },
  { pattern: "GC Thread", count: () => 8, scenario: ["jvm"], daemon: true },
  { pattern: "C2 CompilerThread", count: () => 3, scenario: ["jvm"], daemon: true },
  { pattern: "C1 CompilerThread", count: () => 2, scenario: ["jvm"], daemon: true },
  { pattern: "JMX server connection timeout", count: () => 1, scenario: ["jvm"], daemon: true },
];

const THREAD_STATES = ["RUNNABLE", "WAITING", "TIMED_WAITING", "BLOCKED"] as const;

function simThreads(target: JvmTarget, state: SimState): JvmThread[] {
  const seed = hashSeed(target.name + Math.floor(Date.now() / 700));
  const threads: JvmThread[] = [];
  let id = 20;
  const add = (name: string, scenario: keyof typeof FRAME_LIBRARY, pool: string, threadState: string, daemon: boolean, extra?: Partial<JvmThread>) => {
    const frames = (FRAME_LIBRARY[scenario] ?? FRAME_LIBRARY.web)[seed % (FRAME_LIBRARY[scenario]?.length ?? 1)];
    threads.push({
      id: (id += 3),
      name,
      state: threadState,
      daemon,
      priority: daemon ? 5 : 5 + (seed % 5),
      cpuMs: Math.round(1000 + (seed % 90_000) + (state.cpuProcess * 20_000) % 40_000),
      blockedCount: Math.round(seed % 40),
      waitedCount: Math.round(400 + (seed % 9000)),
      pool,
      frames: frames.map((frame) => ({ ...frame })),
      ...extra,
    });
  };

  for (const pool of THREAD_POOLS) {
    const total = pool.count(seed);
    for (let i = 1; i <= total; i += 1) {
      const name = pool.pattern.endsWith("Thread") || /Sampling|Timeout/.test(pool.pattern) ? `${pool.pattern}-${i}` : `${pool.pattern}-${i}`;
      const roll = (seed + i * 7) % 10;
      const threadState = pool.scenario.includes("jvm")
        ? "RUNNABLE"
        : roll === 0
          ? "BLOCKED"
          : roll < 4
            ? "WAITING"
            : roll < 7
              ? "TIMED_WAITING"
              : "RUNNABLE";
      const scenario = pool.scenario[(seed + i) % pool.scenario.length];
      const lockedMonitor = threadState === "BLOCKED" ? `0x0000000${(seed % 8) + 7}1ab${i.toString(16).padStart(2, "0")}0` : undefined;
      add(
        name,
        scenario,
        pool.pattern,
        threadState,
        pool.daemon,
        lockedMonitor
          ? {
              lockName: lockedMonitor,
              lockOwnerName: `http-nio-8080-exec-${(i % 6) + 1}`,
              waitsOn: lockedMonitor,
              frames: [{ className: "java.base/java.lang.Object", methodName: "wait", fileName: "Object.java", line: 341 }, ...threads[0].frames.slice(0, 2)],
            }
          : undefined,
      );
    }
  }

  add("main", "web", "main", "RUNNABLE", false);
  add("Reference Handler", "jvm", "jvm-internal", "RUNNABLE", true);
  add("Finalizer", "jvm", "jvm-internal", "WAITING", true);
  add("Signal Dispatcher", "jvm", "jvm-internal", "RUNNABLE", true);
  add("VM Thread", "jvm", "jvm-internal", "RUNNABLE", true);
  add("RMI TCP Connection(3)-127.0.0.1", "jvm", "jmx", "RUNNABLE", true, {
    frames: [
      { className: "sun.management.jmxremote.ConnectorBootstrap$PermanentExporterServer", methodName: "start", line: 216 },
      ...(FRAME_LIBRARY.jvm[0].slice(0, 1) as JvmFrame[]),
    ],
  });

  // a planted deadlock so the detector has something real to find
  const monitorA = "0x0000000712ab3c10";
  const monitorB = "0x0000000712ab8f20";
  const deadlockIds = { first: 4711, second: 4717 };
  // the pool loop must not generate the same names, otherwise two threads would share the monitors
  for (const index of [7, 11]) {
    const collision = threads.findIndex((thread) => thread.name === `http-nio-8080-exec-${index}`);
    if (collision >= 0) threads.splice(collision, 1);
  }
  add("http-nio-8080-exec-7", "repository", "http-nio-8080-exec", "BLOCKED", false, {
    id: deadlockIds.first,
    lockName: monitorA,
    lockOwnerName: "http-nio-8080-exec-11",
    lockOwnerId: deadlockIds.second,
    waitsOn: monitorB,
    frames: [
      { className: "com.vega.catalog.service.InventoryService", methodName: "reserve", fileName: "InventoryService.java", line: 210 },
      { className: "com.vega.catalog.repo.InventoryRepository", methodName: "lockForUpdate", fileName: "InventoryRepository.java", line: 88 },
    ],
  });
  add("http-nio-8080-exec-11", "repository", "http-nio-8080-exec", "BLOCKED", false, {
    id: deadlockIds.second,
    lockName: monitorB,
    lockOwnerName: "http-nio-8080-exec-7",
    lockOwnerId: deadlockIds.first,
    waitsOn: monitorA,
    frames: [
      { className: "com.vega.catalog.service.PricingService", methodName: "reprice", fileName: "PricingService.java", line: 154 },
      { className: "com.vega.catalog.repo.ProductRepository", methodName: "lockSku", fileName: "ProductRepository.java", line: 132 },
    ],
  });

  return threads;
}

/** Real thread dumps from Jolokia (dumpAllThreads) or Actuator (/threaddump). */
async function realThreads(target: JvmTarget): Promise<JvmThread[]> {
  if (target.kind === "jolokia") {
    const [result] = await jolokia(
      [{ type: "exec", mbean: "java.lang:type=Threading", operation: "dumpAllThreads", arguments: [true, true] }],
      target.url,
      6000,
    );
    if (result?.status !== 200) throw new Error(result?.error ?? "dumpAllThreads failed");
    const infos: any[] = result.value ?? [];
    return infos.map((info, index) => ({
      id: Number(info.threadId ?? index + 1),
      name: String(info.threadName ?? `thread-${index}`),
      state: String(info.threadState ?? "RUNNABLE"),
      daemon: Boolean(info.daemon),
      priority: Number(info.priority ?? 5),
      cpuMs: Number(info.cpuTime ?? 0) / 1e6,
      blockedCount: Number((info.blockedCount ?? 0) + (info.blockedTime ?? 0) / 1000),
      waitedCount: Number(info.waitedCount ?? 0),
      lockName: info.lockInfo?.className ? `${info.lockInfo.className}@${info.lockInfo.identityHashCode}` : undefined,
      lockOwnerName: info.lockInfo?.lockedStackFrame ? String(info.lockOwnerName ?? "") : undefined,
      lockOwnerId: info.lockOwnerId !== undefined && info.lockOwnerId >= 0 ? Number(info.lockOwnerId) : undefined,
      waitsOn: info.lockInfo?.className ? `${info.lockInfo.className}@${info.lockInfo.identityHashCode}` : undefined,
      pool: String(info.threadName ?? "").replace(/-\d+$/, ""),
      frames: ((info.stackTrace ?? []) as any[]).map((frame) => ({
        className: String(frame.className ?? frame.moduleName ?? "unknown"),
        methodName: String(frame.methodName ?? ""),
        fileName: frame.fileName ? String(frame.fileName) : undefined,
        line: frame.lineNumber !== undefined && frame.lineNumber >= 0 ? Number(frame.lineNumber) : undefined,
      })),
    }));
  }

  const body = await fetchJson(`${actuatorBase(target.url)}/threaddump`, undefined, 8000);
  const list: any[] = body?.threads ?? [];
  return list.map((thread, index) => ({
    id: Number(thread.threadId ?? index + 1),
    name: String(thread.threadName ?? `thread-${index}`),
    state: String(thread.threadState ?? "RUNNABLE"),
    daemon: Boolean(thread.daemon),
    priority: Number(thread.priority ?? 5),
    cpuMs: Number(thread.cpuTime ?? 0),
    blockedCount: Number(thread.blockedCount ?? 0),
    waitedCount: Number(thread.waitedCount ?? 0),
    lockName: thread.lockInfo?.className ? `${thread.lockInfo.className}@${thread.lockInfo.identityHashCode ?? ""}` : undefined,
    lockOwnerName: thread.lockOwnerName ? String(thread.lockOwnerName) : undefined,
    lockOwnerId: thread.lockOwnerId !== undefined && thread.lockOwnerId >= 0 ? Number(thread.lockOwnerId) : undefined,
    waitsOn: thread.lockInfo?.identityHashCode ? String(thread.lockInfo.identityHashCode) : undefined,
    pool: String(thread.threadName ?? "").replace(/-\d+$/, ""),
    frames: ((thread.stackTrace ?? []) as any[]).map((frame) => ({
      className: String(frame.className ?? "unknown"),
      methodName: String(frame.methodName ?? ""),
      fileName: frame.fileName ? String(frame.fileName) : undefined,
      line: Number(frame.lineNumber) >= 0 ? Number(frame.lineNumber) : undefined,
    })),
  }));
}

/** Cycle detection over the wait-for graph (same idea JVisualVM uses). */
export function detectDeadlocks(threads: JvmThread[]): JvmDeadlock[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const byName = new Map(threads.map((thread) => [thread.name, thread]));
  const ownerOf = new Map<string, JvmThread>();
  for (const thread of threads) {
    if (thread.lockName) ownerOf.set(thread.lockName, thread);
  }
  const waitFor = new Map<number, JvmThread>();
  for (const thread of threads) {
    if (!thread.waitsOn) continue;
    const owner = ownerOf.get(thread.waitsOn) ?? (thread.lockOwnerName ? byName.get(thread.lockOwnerName) : undefined) ?? (thread.lockOwnerId !== undefined ? byId.get(thread.lockOwnerId) : undefined);
    if (owner && owner.id !== thread.id) waitFor.set(thread.id, owner);
  }

  const deadlocks: JvmDeadlock[] = [];
  const seen = new Set<number>();
  for (const thread of threads) {
    if (seen.has(thread.id)) continue;
    const chain: JvmThread[] = [];
    const onPath = new Map<number, number>();
    let current: JvmThread | undefined = thread;
    while (current && !seen.has(current.id)) {
      if (onPath.has(current.id)) {
        const cycle = chain.slice(onPath.get(current.id));
        const members = cycle.map((member, index) => ({
          id: member.id,
          name: member.name,
          state: member.state,
          holds: member.lockName,
          waitsFor: cycle[(index + 1) % cycle.length]?.lockName,
        }));
        deadlocks.push({
          description: `Found ${members.length} threads in a Java-level deadlock: ${members.map((m) => m.name).join(" -> ")}`,
          threads: members,
        });
        for (const member of cycle) seen.add(member.id);
        break;
      }
      onPath.set(current.id, chain.length);
      chain.push(current);
      current = waitFor.get(current.id);
    }
    seen.add(thread.id);
  }
  return deadlocks;
}

function threadsToText(target: JvmTarget, threads: JvmThread[], deadlocks: JvmDeadlock[]): string {
  const lines: string[] = [
    `${new Date().toISOString()} Full thread dump (captured via ${target.kind}${target.url ? ` ${target.url}` : ""})`,
    "",
  ];
  if (deadlocks.length) {
    lines.push("Found one Java-level deadlock:");
    for (const deadlock of deadlocks) lines.push(`  ${deadlock.description}`);
    lines.push("");
  }
  for (const thread of threads) {
    lines.push(`"${thread.name}"${thread.daemon ? " daemon" : ""} prio=${thread.priority} Id=${thread.id} ${thread.state}`);
    for (const frame of thread.frames) {
      const location = frame.fileName ? `${frame.fileName}${frame.line !== undefined ? `:${frame.line}` : ""}` : "Unknown Source";
      lines.push(`\tat ${frame.className}.${frame.methodName}(${location})`);
    }
    if (thread.lockName) lines.push(`\t- waiting to lock <${thread.lockName}>${thread.lockOwnerName ? ` owned by "${thread.lockOwnerName}"` : ""}`);
    lines.push("");
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* snapshot                                                            */
/* ------------------------------------------------------------------ */

function mb(bytes: number): number {
  return +(bytes / MB).toFixed(1);
}

function pool(poolName: string, type: "heap" | "nonheap", used: number, committed: number, max: number): JvmMemoryPool {
  return {
    name: poolName,
    type,
    usedMb: +used.toFixed(1),
    committedMb: +committed.toFixed(1),
    maxMb: +max.toFixed(1),
    usagePct: max > 0 ? +((used / max) * 100).toFixed(1) : 0,
  };
}

function actorMetric(raw: Record<string, any>, name: string): number {
  const measurement = (raw?.measurements ?? []).find((entry: any) => entry.statistic === "VALUE");
  return Number(measurement?.value ?? 0);
}

async function jolokiaSnapshot(target: JvmTarget, historyPoints: JvmHistoryPoint[]): Promise<JvmSnapshot> {
  const [memory, pools, threading, classLoading, operatingSystem, runtime, gc, buffers] = await jolokia(
    [
      { type: "read", mbean: "java.lang:type=Memory" },
      { type: "read", mbean: "java.lang:type=MemoryPool,name=*" },
      { type: "read", mbean: "java.lang:type=Threading" },
      { type: "read", mbean: "java.lang:type=ClassLoading" },
      { type: "read", mbean: "java.lang:type=OperatingSystem" },
      { type: "read", mbean: "java.lang:type=Runtime" },
      { type: "read", mbean: "java.lang:type=GarbageCollector,name=*" },
      { type: "read", mbean: "java.nio:type=BufferPool,name=*" },
    ],
    target.url,
    6000,
  );
  const value = (result: any) => (result?.status === 200 ? result.value : undefined);
  const mem = value(memory) ?? {};
  const thread = value(threading) ?? {};
  const classes = value(classLoading) ?? {};
  const system = value(operatingSystem) ?? {};
  const rt = value(runtime) ?? {};
  const poolMap: Record<string, any> = value(pools) ?? {};
  const gcMap: Record<string, any> = value(gc) ?? {};
  const bufferMap: Record<string, any> = value(buffers) ?? {};

  const heapUsage = mem.HeapMemoryUsage ?? { used: 0, committed: 0, max: -1 };
  const nonHeapUsage = mem.NonHeapMemoryUsage ?? { used: 0, committed: 0, max: -1 };
  const poolsOut: JvmMemoryPool[] = Object.entries(poolMap).map(([key, poolValue]) => {
    const usage = (poolValue as any)?.Usage ?? {};
    const type = String((poolValue as any)?.Type ?? "HEAP").toLowerCase() === "heap" ? "heap" : "nonheap";
    return pool(String((poolValue as any)?.Name ?? key.split("name=")[1] ?? key), type, mb(usage.used ?? 0), mb(usage.committed ?? 0), mb(usage.max && usage.max > 0 ? usage.max : usage.committed ?? 0));
  });
  const collectors = Object.entries(gcMap).map(([key, gcValue]) => {
    const count = Number((gcValue as any)?.CollectionCount ?? 0);
    const timeMs = Number((gcValue as any)?.CollectionTime ?? 0);
    return {
      name: String((gcValue as any)?.Name ?? key.split("name=")[1] ?? key),
      count,
      timeMs,
      avgPauseMs: count > 0 ? +(timeMs / count).toFixed(2) : 0,
      poolNames: ((gcValue as any)?.MemoryPoolNames ?? []) as string[],
    };
  });
  const young = collectors.filter((collector) => /young|scavenge|copy|parnew/i.test(collector.name));
  const old = collectors.filter((collector) => !/young|scavenge|copy|parnew/i.test(collector.name));
  const youngCount = young.reduce((sum, collector) => sum + collector.count, 0);

  const point: JvmHistoryPoint = {
    ts: new Date().toISOString(),
    heapUsedMb: mb(heapUsage.used ?? 0),
    heapCommittedMb: mb(heapUsage.committed ?? 0),
    nonHeapMb: mb(nonHeapUsage.used ?? 0),
    metaspaceMb: poolsOut.filter((entry) => /metaspace/i.test(entry.name)).reduce((sum, entry) => sum + entry.usedMb, 0),
    edenMb: poolsOut.filter((entry) => /eden/i.test(entry.name)).reduce((sum, entry) => sum + entry.usedMb, 0),
    survivorMb: poolsOut.filter((entry) => /survivor/i.test(entry.name)).reduce((sum, entry) => sum + entry.usedMb, 0),
    oldMb: poolsOut.filter((entry) => /old gen|tenured/i.test(entry.name)).reduce((sum, entry) => sum + entry.usedMb, 0),
    threadsLive: Number(thread.ThreadCount ?? 0),
    cpuProcess: +(Number(system.ProcessCpuLoad ?? 0) * 100).toFixed(1),
    classesLoaded: Number(classes.LoadedClassCount ?? 0),
    gcCount: collectors.reduce((sum, collector) => sum + collector.count, 0),
    gcTimeMs: collectors.reduce((sum, collector) => sum + collector.timeMs, 0),
  };

  const gcEventList = gcEventsStore.get(target.id) ?? [];
  return {
    target,
    jvm: {
      version: String(rt.VmVersion ?? target.jvmVersion ?? "unknown"),
      vendor: String(rt.VmVendor ?? target.javaVendor ?? "unknown"),
      name: String(rt.VmName ?? "HotSpot"),
      specVersion: String(rt.SpecVersion ?? "unknown"),
      uptimeMs: Number(rt.Uptime ?? 0),
      startTime: new Date(Date.now() - Number(rt.Uptime ?? 0)).toISOString(),
      pid: Number(rt.Name?.split("@")[0] ?? 0),
      hostname: String(rt.Name?.split("@")[1] ?? target.host),
      osName: String(system.Arch ?? "unknown"),
      osArch: String(system.Arch ?? "unknown"),
      cpus: Number(system.AvailableProcessors ?? 0),
      gcCollector: collectors[0]?.name ?? "unknown",
      args: ((rt.InputArguments ?? []) as string[]).filter((arg) => !arg.startsWith("-Djava.class.path")),
      classPath: String(rt.ClassPath ?? "").length > 400 ? `${String(rt.ClassPath).slice(0, 400)}…` : String(rt.ClassPath ?? ""),
      systemProperties: Object.fromEntries(
        Object.entries((rt.SystemProperties ?? {}) as Record<string, unknown>).map(([key, val]) => [key, String(val).slice(0, 240)]),
      ),
    },
    memory: {
      heap: {
        usedMb: point.heapUsedMb,
        committedMb: mb(heapUsage.committed ?? 0),
        maxMb: mb(heapUsage.max && heapUsage.max > 0 ? heapUsage.max : heapUsage.committed ?? 0),
        usagePct: heapUsage.max > 0 ? +((heapUsage.used / heapUsage.max) * 100).toFixed(1) : 0,
      },
      nonHeap: {
        usedMb: point.nonHeapMb,
        committedMb: mb(nonHeapUsage.committed ?? 0),
        maxMb: mb(nonHeapUsage.max && nonHeapUsage.max > 0 ? nonHeapUsage.max : nonHeapUsage.committed ?? 0),
        usagePct: nonHeapUsage.max > 0 ? +((nonHeapUsage.used / nonHeapUsage.max) * 100).toFixed(1) : 0,
      },
      pools: poolsOut,
    },
    gc: {
      collectors,
      totalCount: collectors.reduce((sum, collector) => sum + collector.count, 0),
      totalTimeMs: collectors.reduce((sum, collector) => sum + collector.timeMs, 0),
      youngCount,
      oldCount: old.reduce((sum, collector) => sum + collector.count, 0),
      avgPauseMs:
        collectors.reduce((sum, collector) => sum + collector.count, 0) > 0
          ? +(collectors.reduce((sum, collector) => sum + collector.timeMs, 0) / collectors.reduce((sum, collector) => sum + collector.count, 0)).toFixed(2)
          : 0,
      lastEvent: gcEventList[0] ?? null,
    },
    threads: {
      live: Number(thread.ThreadCount ?? 0),
      daemon: Number(thread.DaemonThreadCount ?? 0),
      peak: Number(thread.PeakThreadCount ?? 0),
      started: Number(thread.TotalStartedThreadCount ?? 0),
      blocked: Number(thread.ThreadCount ?? 0) - Number(thread.ThreadCount ?? 0),
      waiting: 0,
      deadlocked: 0,
    },
    classes: {
      loaded: Number(classes.LoadedClassCount ?? 0),
      unloaded: Number(classes.UnloadedClassCount ?? 0),
      total: Number(classes.TotalLoadedClassCount ?? 0),
    },
    cpu: {
      processLoad: +(Number(system.ProcessCpuLoad ?? 0) * 100).toFixed(1),
      systemLoad: +(Number(system.SystemCpuLoad ?? 0) * 100).toFixed(1),
      loadAverage: Number(system.SystemLoadAverage ?? 0),
      processCpuTimeMs: Number(system.ProcessCpuTime ?? 0) / 1e6,
      availableProcessors: Number(system.AvailableProcessors ?? 0),
    },
    buffers: Object.entries(bufferMap).map(([key, bufferValue]) => ({
      name: String((bufferValue as any)?.Name ?? key),
      usedMb: mb((bufferValue as any)?.MemoryUsed ?? 0),
      capacityMb: mb((bufferValue as any)?.TotalCapacity ?? 0),
      count: Number((bufferValue as any)?.Count ?? 0),
    })),
    history: [...historyPoints, point].slice(-HISTORY_MAX),
    gcEvents: gcEventList.slice(0, 40),
    sampledAt: new Date().toISOString(),
  };
}

async function actuatorSnapshot(target: JvmTarget, historyPoints: JvmHistoryPoint[]): Promise<JvmSnapshot> {
  const base = actuatorBase(target.url);
  const names = [
    "jvm.memory.used",
    "jvm.memory.committed",
    "jvm.memory.max",
    "jvm.threads.live",
    "jvm.threads.daemon",
    "jvm.threads.peak",
    "jvm.threads.states",
    "jvm.classes.loaded",
    "jvm.classes.unloaded",
    "jvm.gc.pause",
    "jvm.gc.memory.promoted",
    "process.cpu.usage",
    "system.cpu.usage",
    "process.uptime",
    "process.start.time",
    "system.load.average.1m",
  ];
  const results = await Promise.all(
    names.map(async (name) => {
      try {
        return [name, await fetchJson(`${base}/metrics/${name}`, undefined, 3000)] as const;
      } catch {
        return [name, null] as const;
      }
    }),
  );
  const metrics = new Map(results);
  const metric = (name: string) => {
    const raw = metrics.get(name);
    if (!raw) return null;
    return actorMetric(raw as Record<string, any>, name);
  };
  const tagged = (name: string, tag: string) => {
    const raw = metrics.get(name);
    const available = (raw as any)?.availableTags?.find((entry: any) => entry.tag === tag);
    return (available?.values ?? []) as string[];
  };

  const heapAreas = tagged("jvm.memory.used", "area");
  const heapUsed = metric("jvm.memory.used") ?? 0;
  const poolNames = tagged("jvm.memory.used", "id");
  const poolsOut: JvmMemoryPool[] = poolNames.slice(0, 14).map((id) => {
    const isHeap = !/metaspace|code.?cache|compressed|class/i.test(id);
    return pool(id, isHeap ? "heap" : "nonheap", isHeap ? (metric("jvm.memory.used") ?? 0) / Math.max(1, poolNames.length) : 0, heapUsed, metric("jvm.memory.max") ?? 0);
  });
  const pauseCount = metric("jvm.gc.pause") ?? 0;
  const pauseTotalMs = Number((metrics.get("jvm.gc.pause") as any)?.measurements?.find((entry: any) => entry.statistic === "TOTAL_TIME")?.value ?? 0) * 1000;
  const uptimeSec = metric("process.uptime") ?? 0;
  const startTime = metric("process.start.time") ?? Date.now() / 1000 - uptimeSec;
  const live = metric("jvm.threads.live") ?? 0;

  const point: JvmHistoryPoint = {
    ts: new Date().toISOString(),
    heapUsedMb: mb(heapUsed),
    heapCommittedMb: mb(metric("jvm.memory.committed") ?? 0),
    nonHeapMb: mb((metric("jvm.memory.used") ?? 0) * (heapAreas.includes("nonheap") ? 1 : 0.18)),
    metaspaceMb: 0,
    edenMb: 0,
    survivorMb: 0,
    oldMb: 0,
    threadsLive: live,
    cpuProcess: +((metric("process.cpu.usage") ?? 0) * 100).toFixed(1),
    classesLoaded: metric("jvm.classes.loaded") ?? 0,
    gcCount: pauseCount,
    gcTimeMs: pauseTotalMs,
  };

  return {
    target,
    jvm: {
      version: "spring-boot-actuator",
      vendor: target.url,
      name: "HotSpot (via actuator)",
      specVersion: "unknown",
      uptimeMs: uptimeSec * 1000,
      startTime: new Date(startTime * 1000).toISOString(),
      pid: 0,
      hostname: target.host,
      osName: "unknown",
      osArch: "unknown",
      cpus: 0,
      gcCollector: "G1 Young Generation",
      args: [],
      classPath: "",
      systemProperties: {
        "management.endpoints.web.exposure.include": "health,info,metrics,threaddump,heapdump",
        note: "Actuator exposes fewer attributes than JMX; add a Jolokia endpoint for the full picture.",
      },
    },
    memory: {
      heap: {
        usedMb: point.heapUsedMb,
        committedMb: point.heapCommittedMb,
        maxMb: mb(metric("jvm.memory.max") ?? 0),
        usagePct: (metric("jvm.memory.max") ?? 0) > 0 ? +((heapUsed / (metric("jvm.memory.max") ?? 1)) * 100).toFixed(1) : 0,
      },
      nonHeap: { usedMb: point.nonHeapMb, committedMb: point.nonHeapMb, maxMb: 0, usagePct: 0 },
      pools: poolsOut,
    },
    gc: {
      collectors: [
        { name: "jvm.gc.pause", count: pauseCount, timeMs: Math.round(pauseTotalMs), avgPauseMs: pauseCount > 0 ? +(pauseTotalMs / pauseCount).toFixed(2) : 0, poolNames: [] },
      ],
      totalCount: pauseCount,
      totalTimeMs: Math.round(pauseTotalMs),
      youngCount: pauseCount,
      oldCount: 0,
      avgPauseMs: pauseCount > 0 ? +(pauseTotalMs / pauseCount).toFixed(2) : 0,
      lastEvent: gcEventsStore.get(target.id)?.[0] ?? null,
    },
    threads: {
      live,
      daemon: metric("jvm.threads.daemon") ?? 0,
      peak: metric("jvm.threads.peak") ?? 0,
      started: 0,
      blocked: 0,
      waiting: 0,
      deadlocked: 0,
    },
    classes: { loaded: metric("jvm.classes.loaded") ?? 0, unloaded: metric("jvm.classes.unloaded") ?? 0, total: metric("jvm.classes.loaded") ?? 0 },
    cpu: {
      processLoad: +((metric("process.cpu.usage") ?? 0) * 100).toFixed(1),
      systemLoad: +((metric("system.cpu.usage") ?? 0) * 100).toFixed(1),
      loadAverage: metric("system.load.average.1m") ?? 0,
      processCpuTimeMs: 0,
      availableProcessors: 0,
    },
    buffers: [],
    history: [...historyPoints, point].slice(-HISTORY_MAX),
    gcEvents: (gcEventsStore.get(target.id) ?? []).slice(0, 40),
    sampledAt: new Date().toISOString(),
  };
}

function simulatedSnapshot(target: JvmTarget, state: SimState, historyPoints: JvmHistoryPoint[]): JvmSnapshot {
  tickSim(target, state);
  const oldGenPools = [
    pool("G1 Eden Space", "heap", state.edenUsed, state.edenMaxMb, state.edenMaxMb),
    pool("G1 Survivor Space", "heap", state.survivorUsed, state.survivorMaxMb, state.survivorMaxMb),
    pool("G1 Old Gen", "heap", state.oldUsed, state.oldMaxMb, state.oldMaxMb),
    pool("Metaspace", "nonheap", state.metaspaceUsed, state.metaspaceMaxMb, state.metaspaceMaxMb),
    pool("Compressed Class Space", "nonheap", state.compressedClassUsed, state.compressedClassMaxMb, state.compressedClassMaxMb),
    pool("CodeCache", "nonheap", state.codeCacheUsed, state.codeCacheMaxMb, state.codeCacheMaxMb),
  ];
  const heapUsed = +(state.edenUsed + state.survivorUsed + state.oldUsed).toFixed(1);
  const heapCommitted = +(state.heapMaxMb * 0.86).toFixed(1);
  const nonHeapUsed = +(state.metaspaceUsed + state.compressedClassUsed + state.codeCacheUsed).toFixed(1);
  const threadsLive = state.threadsLive;
  const point: JvmHistoryPoint = {
    ts: new Date().toISOString(),
    heapUsedMb: heapUsed,
    heapCommittedMb: heapCommitted,
    nonHeapMb: nonHeapUsed,
    metaspaceMb: +state.metaspaceUsed.toFixed(1),
    edenMb: +state.edenUsed.toFixed(1),
    survivorMb: +state.survivorUsed.toFixed(1),
    oldMb: +state.oldUsed.toFixed(1),
    threadsLive,
    cpuProcess: +(state.cpuProcess * 100).toFixed(1),
    classesLoaded: state.classesLoaded,
    gcCount: state.youngCount + state.oldCount,
    gcTimeMs: Math.round(state.youngTimeMs + state.oldTimeMs),
  };
  recordHistory(target, state, point);

  return {
    target,
    jvm: {
      version: state.version,
      vendor: state.vendor,
      name: "OpenJDK 64-Bit Server VM",
      specVersion: "21",
      uptimeMs: Date.now() - (Date.now() - state.uptimeOffsetMs),
      startTime: new Date(Date.now() - state.uptimeOffsetMs).toISOString(),
      pid: state.pid,
      hostname: state.hostname,
      osName: "Linux",
      osArch: "amd64",
      cpus: 8,
      gcCollector: state.collector,
      args: [
        `-Xms${Math.round(state.heapMaxMb / 2)}m`,
        `-Xmx${state.heapMaxMb}m`,
        "-XX:+UseG1GC",
        "-XX:MaxGCPauseMillis=200",
        "-XX:+HeapDumpOnOutOfMemoryError",
        "-Dspring.profiles.active=prod",
        "-javaagent:/opt/jolokia/jolokia-jvm.jar=port=8778",
      ],
      classPath: `/opt/app/${state.app}-0.0.1-SNAPSHOT.jar:/opt/app/libs/*`,
      systemProperties: {
        "java.vm.name": "OpenJDK 64-Bit Server VM",
        "java.version": state.version,
        "java.vendor": state.vendor,
        "os.name": "Linux",
        "os.arch": "amd64",
        "user.dir": `/opt/app`,
        "spring.profiles.active": "prod",
        "server.port": "8080",
        "management.endpoints.web.exposure.include": "health,info,metrics,threaddump",
        "management.jmxremote.authenticate": "false",
        "datasource.url": "jdbc:postgresql://vega-postgres:5432/vega",
        "kafka.bootstrap.servers": "vega-rabbitmq:9092",
      },
    },
    memory: {
      heap: {
        usedMb: heapUsed,
        committedMb: heapCommitted,
        maxMb: state.heapMaxMb,
        usagePct: +((heapUsed / state.heapMaxMb) * 100).toFixed(1),
      },
      nonHeap: {
        usedMb: nonHeapUsed,
        committedMb: +(nonHeapUsed * 1.12).toFixed(1),
        maxMb: state.metaspaceMaxMb + state.codeCacheMaxMb + state.compressedClassMaxMb,
        usagePct: +((nonHeapUsed / (state.metaspaceMaxMb + state.codeCacheMaxMb + state.compressedClassMaxMb)) * 100).toFixed(1),
      },
      pools: oldGenPools,
    },
    gc: {
      collectors: [
        { name: "G1 Young Generation", count: state.youngCount, timeMs: Math.round(state.youngTimeMs), avgPauseMs: +(state.youngTimeMs / Math.max(1, state.youngCount)).toFixed(2), poolNames: ["G1 Eden Space", "G1 Survivor Space"] },
        { name: "G1 Old Generation", count: state.oldCount, timeMs: Math.round(state.oldTimeMs), avgPauseMs: +(state.oldTimeMs / Math.max(1, state.oldCount)).toFixed(2), poolNames: ["G1 Old Gen"] },
      ],
      totalCount: state.youngCount + state.oldCount,
      totalTimeMs: Math.round(state.youngTimeMs + state.oldTimeMs),
      youngCount: state.youngCount,
      oldCount: state.oldCount,
      avgPauseMs: +((state.youngTimeMs + state.oldTimeMs) / Math.max(1, state.youngCount + state.oldCount)).toFixed(2),
      lastEvent: gcEventsStore.get(target.id)?.[0] ?? null,
    },
    threads: {
      live: threadsLive,
      daemon: state.threadsDaemon,
      peak: state.threadsPeak,
      started: state.threadsStarted,
      blocked: Math.max(2, Math.round(threadsLive * 0.07)),
      waiting: Math.round(threadsLive * 0.2),
      deadlocked: detectDeadlocks(simThreads(target, state)).reduce((sum, deadlock) => sum + deadlock.threads.length, 0),
    },
    classes: { loaded: state.classesLoaded, unloaded: state.classesUnloaded, total: state.classesLoaded + state.classesUnloaded },
    cpu: {
      processLoad: +(state.cpuProcess * 100).toFixed(1),
      systemLoad: +(state.cpuSystem * 100).toFixed(1),
      loadAverage: +(state.cpuSystem * 3.2).toFixed(2),
      processCpuTimeMs: Math.round(state.processCpuTimeMs),
      availableProcessors: 8,
    },
    buffers: [
      { name: "direct", usedMb: +(46 + (state.heapMaxMb % 30)).toFixed(1), capacityMb: 128, count: 640 },
      { name: "mapped", usedMb: 4.2, capacityMb: 16, count: 12 },
    ],
    history: history.get(target.id) ?? historyPoints,
    gcEvents: (gcEventsStore.get(target.id) ?? []).slice(0, 40),
    sampledAt: new Date().toISOString(),
  };
}

export async function jvmSnapshot(id: string): Promise<JvmSnapshot> {
  const target = await resolveJvmTarget(id);
  if (!target) throw new Error(`JVM target ${id} not found`);
  const historyPoints = history.get(target.id) ?? [];
  if (target.kind === "simulated" || target.autoDiscovered) {
    const state = simFor(target);
    const snapshot = simulatedSnapshot(target, state, historyPoints);
    history.set(target.id, snapshot.history.slice(-HISTORY_MAX));
    return snapshot;
  }
  const probed = await probeTarget(target, false);
  if (probed.status !== "online") {
    throw new Error(`target ${target.name} is offline: ${probed.lastError ?? "no response"}`);
  }
  const snapshot = probed.kind === "jolokia" ? await jolokiaSnapshot(probed, historyPoints) : await actuatorSnapshot(probed, historyPoints);
  history.set(target.id, snapshot.history.slice(-HISTORY_MAX));
  // derive GC events from counter deltas so the timeline stays meaningful for real JVMs too
  const previous = historyPoints[historyPoints.length - 1];
  if (previous) {
    const countDelta = snapshot.gc.totalCount - previous.gcCount;
    const timeDelta = snapshot.gc.totalTimeMs - previous.gcTimeMs;
    if (countDelta > 0 && snapshot.gc.avgPauseMs > 0) {
      pushGcEvent(probed, {
        at: new Date().toISOString(),
        kind: timeDelta > 250 ? "old" : "young",
        cause: timeDelta > 250 ? "Full GC (JMX counter delta)" : "Young GC (JMX counter delta)",
        pauseMs: +(timeDelta / Math.max(1, countDelta)).toFixed(1),
        reclaimedMb: Math.max(0, +(previous.heapUsedMb - snapshot.memory.heap.usedMb).toFixed(1)),
      });
      snapshot.gcEvents = (gcEventsStore.get(probed.id) ?? []).slice(0, 40);
    }
  }
  return snapshot;
}

/* ------------------------------------------------------------------ */
/* threads + dumps                                                     */
/* ------------------------------------------------------------------ */

export async function jvmThreads(id: string): Promise<JvmThreadResponse> {
  const target = await resolveJvmTarget(id);
  if (!target) throw new Error(`JVM target ${id} not found`);
  let threads: JvmThread[];
  if (target.kind === "simulated" || target.autoDiscovered) {
    threads = simThreads(target, simFor(target));
  } else {
    const probed = await probeTarget(target, false);
    if (probed.status !== "online") throw new Error(`target ${target.name} is offline: ${probed.lastError ?? "no response"}`);
    threads = await realThreads(probed);
  }
  const deadlocks = detectDeadlocks(threads);
  const summary = {
    total: threads.length,
    runnable: threads.filter((thread) => thread.state === "RUNNABLE").length,
    waiting: threads.filter((thread) => thread.state === "WAITING").length,
    blocked: threads.filter((thread) => thread.state === "BLOCKED").length,
    timedWaiting: threads.filter((thread) => thread.state === "TIMED_WAITING").length,
    daemon: threads.filter((thread) => thread.daemon).length,
    deadlocked: deadlocks.reduce((sum, deadlock) => sum + deadlock.threads.length, 0),
  };
  return { target, threads, deadlocks, summary, capturedAt: new Date().toISOString() };
}

/* ------------------------------------------------------------------ */
/* profiler (statistical CPU sampling over thread stacks)              */
/* ------------------------------------------------------------------ */

interface ProfileSession {
  id: string;
  targetId: string;
  targetName: string;
  status: JvmProfile["status"];
  startedAt: number;
  finishedAt: number | null;
  /** configured sampling window (immutable) */
  durationMs: number;
  /** elapsed sampling time so far */
  elapsedMs: number;
  intervalMs: number;
  /** number of sampling ticks */
  samples: number;
  /** number of thread stacks observed (denominator for percentages) */
  stackSamples: number;
  inFlight: boolean;
  selfCounts: Map<string, { className: string; methodName: string; count: number; frames: Set<string> }>;
  tree: MutableTreeNode;
  allocationCounts: Map<string, { instances: number; bytes: number }>;
  error: string | null;
  note: string | null;
  maxSamples: number;
}

interface MutableTreeNode {
  key: string;
  className: string;
  methodName: string;
  samples: number;
  children: Map<string, MutableTreeNode>;
}

const ALLOCATION_CLASSES = [
  ["java.util.HashMap$Node", 512],
  ["java.lang.String", 240],
  ["byte[]", 1024],
  ["com.vega.catalog.dto.ProductDto", 384],
  ["java.util.ArrayList", 96],
  ["java.lang.Integer", 16],
  ["com.fasterxml.jackson.databind.node.ObjectNode", 168],
  ["java.util.LinkedHashMap", 128],
] as const;

function profileSummary(session: ProfileSession, targetId: string): JvmProfile {
  const totalSamples = Math.max(1, session.stackSamples || session.samples);
  const intervalMs = session.intervalMs;
  const hotMethods: JvmHotMethod[] = [...session.selfCounts.entries()]
    .map(([key, entry]) => {
      const selfSampleTotal = entry.count;
      return {
        className: entry.className,
        methodName: entry.methodName,
        samples: entry.count,
        selfMs: +(selfSampleTotal * intervalMs).toFixed(1),
        totalMs: +(selfSampleTotal * intervalMs).toFixed(1),
        selfPct: +((selfSampleTotal / totalSamples) * 100).toFixed(2),
        totalPct: +((selfSampleTotal / totalSamples) * 100).toFixed(2),
      };
    })
    .sort((a, b) => b.selfPct - a.selfPct)
    .slice(0, 40);

  const toNode = (node: MutableTreeNode, depth: number, parentKey: string): JvmMethodNode => {
    const nodeKey = `${parentKey}>${node.key}`;
    const children = [...node.children.values()]
      .sort((a, b) => b.samples - a.samples)
      .filter((child) => child.samples > 0)
      .slice(0, 24)
      .map((child) => toNode(child, depth + 1, nodeKey));
    return {
      id: nodeKey,
      className: node.className,
      methodName: node.methodName,
      samples: node.samples,
      selfMs: +(node.samples * intervalMs).toFixed(1),
      totalMs: +((node.samples + children.reduce((sum, child) => sum + child.samples, 0)) * intervalMs).toFixed(1),
      selfPct: +((node.samples / totalSamples) * 100).toFixed(2),
      totalPct: +(((node.samples + children.reduce((sum, child) => sum + child.samples, 0)) / totalSamples) * 100).toFixed(2),
      depth,
      children,
    };
  };

  const allocationTotal = [...session.allocationCounts.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  const allocations: JvmAllocation[] = [...session.allocationCounts.entries()]
    .map(([className, entry]) => ({
      className,
      instances: entry.instances,
      bytesMb: +(entry.bytes / MB).toFixed(2),
      pct: allocationTotal > 0 ? +((entry.bytes / allocationTotal) * 100).toFixed(1) : 0,
    }))
    .sort((a, b) => b.bytesMb - a.bytesMb)
    .slice(0, 15);

  return {
    targetId,
    status: session.status,
    startedAt: new Date(session.startedAt).toISOString(),
    finishedAt: session.finishedAt ? new Date(session.finishedAt).toISOString() : null,
    durationMs: session.elapsedMs,
    windowMs: session.durationMs,
    intervalMs,
    samples: session.samples,
    hotMethods,
    allocations,
    callTree: toNode(session.tree, 0, "root"),
    error: session.error,
    note: session.note,
  };
}

async function sampleStacks(_session: ProfileSession, target: JvmTarget): Promise<{ stacks: JvmFrame[][]; allocation: Map<string, { instances: number; bytes: number }>; note: string | null }> {
  if (target.kind === "simulated" || target.autoDiscovered) {
    const threads = simThreads(target, simFor(target)).filter((thread) => !thread.daemon);
    const allocation = new Map<string, { instances: number; bytes: number }>();
    for (const [className, size] of ALLOCATION_CLASSES) {
      const instances = Math.floor(Math.random() * 40_000 * (1024 / size));
      allocation.set(className, { instances, bytes: instances * size });
    }
    return { stacks: threads.filter((thread) => thread.state === "RUNNABLE").map((thread) => thread.frames), allocation, note: null };
  }
  const response = await jvmThreads(target.id);
  return { stacks: response.threads.filter((thread) => !thread.daemon && thread.state === "RUNNABLE").map((thread) => thread.frames), allocation: new Map(), note: null };
}

export async function jvmProfileAction(id: string, action: "start" | "stop" | "status" | "save", options?: { durationMs?: number; intervalMs?: number }): Promise<JvmProfile> {
  const target = await resolveJvmTarget(id);
  if (!target) throw new Error(`JVM target ${id} not found`);
  const key = `profile:${target.id}`;

  if (action === "start") {
    const existing = profiles.get(key);
    if (existing?.status === "running") return profileSummary(existing, target.id);
    const durationMs = Math.min(60_000, Math.max(3000, options?.durationMs ?? 12_000));
    const intervalMs = Math.max(50, Math.min(1000, options?.intervalMs ?? (target.kind === "simulated" || target.autoDiscovered ? 120 : 400)));
    const session: ProfileSession = {
      id: `${target.id}:${Date.now()}`,
      targetId: target.id,
      targetName: target.name,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      durationMs,
      elapsedMs: 0,
      intervalMs,
      samples: 0,
      stackSamples: 0,
      inFlight: false,
      selfCounts: new Map(),
      tree: { key: "root", className: "all", methodName: "threads", samples: 0, children: new Map() },
      allocationCounts: new Map(),
      error: null,
      note: target.kind === "simulated" || target.autoDiscovered ? "Simulated sampler: synthetic stacks from the demo JVM model." : null,
      maxSamples: Math.ceil(durationMs / intervalMs),
    };
    profiles.set(key, session);

    const tick = async (): Promise<void> => {
      const current = profiles.get(key);
      if (!current || current.status !== "running") {
        clearInterval(timer);
        return;
      }
      current.elapsedMs = Date.now() - current.startedAt;
      if (current.inFlight) return;
      current.inFlight = true;
      if (current.elapsedMs > current.durationMs || current.samples >= current.maxSamples) {
        current.inFlight = false;
        clearInterval(timer);
        current.status = current.samples > 0 ? "stopped" : "failed";
        current.finishedAt = Date.now();
        if (current.samples === 0 && !current.error) current.error = "no samples captured";
        return;
      }
      try {
        const { stacks, allocation } = await sampleStacks(current, target);
        current.samples += 1;
        current.stackSamples += Math.max(1, stacks.length);
        current.elapsedMs = Date.now() - current.startedAt;
        for (const stack of stacks) {
          if (!stack.length) continue;
          // topmost frame = self time, whole path = call tree
          const top = stack[0];
          const topKey = `${top.className}.${top.methodName}`;
          const entry = current.selfCounts.get(topKey) ?? { className: top.className, methodName: top.methodName, count: 0, frames: new Set<string>() };
          entry.count += 1;
          entry.frames.add(topKey);
          current.selfCounts.set(topKey, entry);

          let node = current.tree;
          for (const frame of [...stack].reverse().slice(0, 18)) {
            const frameKey = `${frame.className}.${frame.methodName}`;
            let child = node.children.get(frameKey);
            if (!child) {
              child = { key: frameKey, className: frame.className, methodName: frame.methodName, samples: 0, children: new Map() };
              node.children.set(frameKey, child);
            }
            child.samples += 1;
            node = child;
          }
        }
        for (const [className, entry] of allocation) {
          const currentEntry = current.allocationCounts.get(className) ?? { instances: 0, bytes: 0 };
          currentEntry.instances = entry.instances;
          currentEntry.bytes = entry.bytes;
          current.allocationCounts.set(className, currentEntry);
        }
      } catch (error) {
        // keep whatever was already collected: a partial profile is still useful
        current.error = error instanceof Error ? error.message : String(error);
        current.status = current.samples > 0 ? "stopped" : "failed";
        current.finishedAt = Date.now();
        clearInterval(timer);
      } finally {
        current.inFlight = false;
      }
    };
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref?.();
    void tick();

    return profileSummary(session, target.id);
  }

  const session = profiles.get(key);
  if (!session) {
    return {
      targetId: target.id,
      status: "idle",
      startedAt: null,
      finishedAt: null,
      durationMs: 0,
      windowMs: 0,
      intervalMs: 0,
      samples: 0,
      hotMethods: [],
      allocations: [],
      callTree: null,
      error: null,
      note: "start a sampling session to collect hot methods and a call tree",
    };
  }
  if (action === "stop" && session.status === "running") {
    session.status = session.samples > 0 ? "stopped" : "failed";
    session.finishedAt = Date.now();
    session.elapsedMs = Date.now() - session.startedAt;
  }
  const summary = profileSummary(session, target.id);

  if (action === "save") {
    if (!summary.hotMethods.length) throw new Error("nothing to save: the session has no samples yet");
    await db
      .insert(jvmDumps)
      .values({
        targetId: target.id,
        targetName: target.name,
        kind: "profile",
        sizeKb: Math.max(1, Math.round(JSON.stringify(summary).length / 1024)),
        path: null,
        summary: {
          samples: summary.samples,
          durationMs: summary.durationMs,
          intervalMs: summary.intervalMs,
          topMethod: summary.hotMethods[0] ? `${summary.hotMethods[0].className}.${summary.hotMethods[0].methodName}` : null,
          hotMethods: summary.hotMethods.slice(0, 25),
          allocations: summary.allocations,
        },
        content: JSON.stringify(summary.callTree ?? {}, null, 1).slice(0, 400_000),
      });
  }
  return summary;
}

/* ------------------------------------------------------------------ */
/* MBeans, operations, dumps                                           */
/* ------------------------------------------------------------------ */

const APP_MBEANS = [
  { mbean: "com.vega.catalog:type=Cache,name=productCache", domain: "com.vega.catalog" },
  { mbean: "com.vega.catalog:type=Datasource,name=primary", domain: "com.vega.catalog" },
  { mbean: "com.vega.catalog:type=Scheduler,name=inventorySync", domain: "com.vega.catalog" },
  { mbean: "com.vega.catalog:type=RateLimiter,name=publicApi", domain: "com.vega.catalog" },
];

export async function jvmMBeans(id: string, mbean?: string): Promise<{ target: JvmTarget; domains: { domain: string; mbeans: string[] }[]; attributes: JvmMBean["attributes"]; selected: string | null; operations: JvmMBean["operations"] }> {
  const target = await resolveJvmTarget(id);
  if (!target) throw new Error(`JVM target ${id} not found`);

  if (target.kind === "jolokia" && !target.autoDiscovered) {
    const probed = await probeTarget(target, false);
    if (probed.status !== "online") throw new Error(`target ${target.name} is offline: ${probed.lastError ?? "no response"}`);
    if (mbean) {
      const [result] = await jolokia([{ type: "read", mbean }], probed.url, 6000);
      if (result?.status !== 200) throw new Error(result?.error ?? "read failed");
      const attributes = flattenAttributes((result.value ?? {}) as Record<string, unknown>);
      return { target: probed, domains: [], attributes, selected: mbean, operations: [] };
    }
    const [listing] = await jolokia([{ type: "list" }], probed.url, 8000);
    const domainsRaw = (listing?.value ?? {}) as Record<string, Record<string, unknown>>;
    const domains = Object.entries(domainsRaw).map(([domain, beans]) => ({
      domain,
      mbeans: Object.keys(beans ?? {})
        .filter((key) => !key.startsWith("openedBy"))
        .map((key) => {
          const props = beans[key] as Record<string, unknown>;
          const suffix = Object.entries(props ?? {})
            .map(([prop, value]) => `${prop}=${value}`)
            .join(",");
          return suffix ? `${domain}:${suffix}` : domain;
        })
        .slice(0, 60),
    }));
    return { target: probed, domains, attributes: [], selected: null, operations: [] };
  }

  tickSim(target, simFor(target));
  const state = simFor(target);
  const catalog = [
    { mbean: "java.lang:type=Memory", domain: "java.lang" },
    { mbean: "java.lang:type=Threading", domain: "java.lang" },
    { mbean: "java.lang:type=ClassLoading", domain: "java.lang" },
    { mbean: "java.lang:type=OperatingSystem", domain: "java.lang" },
    { mbean: "java.lang:type=GarbageCollector,name=G1 Young Generation", domain: "java.lang" },
    { mbean: "java.lang:type=GarbageCollector,name=G1 Old Generation", domain: "java.lang" },
    { mbean: "java.lang:type=Runtime", domain: "java.lang" },
    { mbean: "java.nio:type=BufferPool,name=direct", domain: "java.nio" },
    { mbean: "java.util.logging:type=Logging", domain: "java.util.logging" },
    { mbean: "com.sun.management:type=DiagnosticCommand", domain: "com.sun.management" },
    ...APP_MBEANS,
  ];
  const domains = [...new Set(catalog.map((entry) => entry.domain))].map((domain) => ({
    domain,
    mbeans: catalog.filter((entry) => entry.domain === domain).map((entry) => entry.mbean),
  }));
  if (!mbean) return { target, domains, attributes: [], selected: null, operations: [] };

  const attributes = simulatedAttributes(mbean, target, state);
  const operations = simulatedOperations(mbean);
  return { target, domains, attributes, selected: mbean, operations };
}

function flattenAttributes(value: Record<string, unknown>, prefix = ""): JvmMBean["attributes"] {
  const out: JvmMBean["attributes"] = [];
  for (const [key, raw] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      out.push(...flattenAttributes(raw as Record<string, unknown>, name));
      continue;
    }
    const text = Array.isArray(raw) ? raw.slice(0, 12).join(", ") : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
    out.push({
      name,
      type: Array.isArray(raw) ? "list" : typeof raw,
      value: text.length > 400 ? `${text.slice(0, 400)}…` : text,
      numeric: typeof raw === "number" ? raw : undefined,
    });
  }
  return out.slice(0, 120);
}

function simulatedAttributes(mbean: string, target: JvmTarget, state: SimState): JvmMBean["attributes"] {
  const snapshotMemory = () => {
    const heapUsed = state.edenUsed + state.survivorUsed + state.oldUsed;
    return [
      { name: "HeapMemoryUsage.used", type: "number", value: `${heapUsed.toFixed(0)} bytes`, numeric: heapUsed * MB },
      { name: "HeapMemoryUsage.committed", type: "number", value: `${(state.heapMaxMb * 0.86).toFixed(0)} MB`, numeric: state.heapMaxMb * 0.86 * MB },
      { name: "HeapMemoryUsage.max", type: "number", value: `${state.heapMaxMb} MB`, numeric: state.heapMaxMb * MB },
      { name: "NonHeapMemoryUsage.used", type: "number", value: `${(state.metaspaceUsed + state.codeCacheUsed).toFixed(1)} MB`, numeric: (state.metaspaceUsed + state.codeCacheUsed) * MB },
      { name: "ObjectPendingFinalizationCount", type: "number", value: String(Math.round(Math.random() * 4)), numeric: 0 },
    ];
  };
  if (mbean === "java.lang:type=Memory") return snapshotMemory();
  if (mbean === "java.lang:type=Threading") {
    return [
      { name: "ThreadCount", type: "number", value: String(state.threadsLive), numeric: state.threadsLive },
      { name: "DaemonThreadCount", type: "number", value: String(state.threadsDaemon), numeric: state.threadsDaemon },
      { name: "PeakThreadCount", type: "number", value: String(state.threadsPeak), numeric: state.threadsPeak },
      { name: "TotalStartedThreadCount", type: "number", value: String(state.threadsStarted), numeric: state.threadsStarted },
      { name: "CurrentThreadCpuTime", type: "number", value: `${(state.processCpuTimeMs * 1e6).toFixed(0)} ns`, numeric: state.processCpuTimeMs },
    ];
  }
  if (mbean === "java.lang:type=ClassLoading") {
    return [
      { name: "LoadedClassCount", type: "number", value: String(state.classesLoaded), numeric: state.classesLoaded },
      { name: "UnloadedClassCount", type: "number", value: String(state.classesUnloaded), numeric: state.classesUnloaded },
      { name: "TotalLoadedClassCount", type: "number", value: String(state.classesLoaded + state.classesUnloaded), numeric: state.classesLoaded + state.classesUnloaded },
    ];
  }
  if (mbean === "java.lang:type=OperatingSystem") {
    return [
      { name: "Name", type: "string", value: "Linux" },
      { name: "Arch", type: "string", value: "amd64" },
      { name: "AvailableProcessors", type: "number", value: "8", numeric: 8 },
      { name: "ProcessCpuLoad", type: "number", value: state.cpuProcess.toFixed(4), numeric: state.cpuProcess },
      { name: "SystemCpuLoad", type: "number", value: state.cpuSystem.toFixed(4), numeric: state.cpuSystem },
      { name: "SystemLoadAverage", type: "number", value: (state.cpuSystem * 3.2).toFixed(2), numeric: state.cpuSystem * 3.2 },
      { name: "ProcessCpuTime", type: "number", value: `${(state.processCpuTimeMs * 1e6).toFixed(0)} ns`, numeric: state.processCpuTimeMs },
    ];
  }
  if (mbean.includes("GarbageCollector")) {
    const young = mbean.includes("Young");
    return [
      { name: "CollectionCount", type: "number", value: String(young ? state.youngCount : state.oldCount), numeric: young ? state.youngCount : state.oldCount },
      { name: "CollectionTime", type: "number", value: String(Math.round(young ? state.youngTimeMs : state.oldTimeMs)), numeric: young ? state.youngTimeMs : state.oldTimeMs },
      { name: "Name", type: "string", value: young ? "G1 Young Generation" : "G1 Old Generation" },
      { name: "MemoryPoolNames", type: "list", value: young ? "G1 Eden Space, G1 Survivor Space" : "G1 Old Gen" },
    ];
  }
  if (mbean === "java.lang:type=Runtime") {
    return [
      { name: "VmName", type: "string", value: "OpenJDK 64-Bit Server VM" },
      { name: "VmVersion", type: "string", value: state.version },
      { name: "VmVendor", type: "string", value: state.vendor },
      { name: "SpecVersion", type: "string", value: "21" },
      { name: "Uptime", type: "number", value: `${Math.round(state.uptimeOffsetMs / 1000)} s`, numeric: state.uptimeOffsetMs / 1000 },
      { name: "StartTime", type: "number", value: new Date(Date.now() - state.uptimeOffsetMs).toISOString() },
      { name: "InputArguments", type: "list", value: `-Xmx${state.heapMaxMb}m, -XX:+UseG1GC, -javaagent:jolokia` },
      { name: "ClassPath", type: "string", value: `/opt/app/${state.app}.jar` },
      { name: "Name", type: "string", value: `${state.pid}@${state.hostname}` },
    ];
  }
  if (mbean.startsWith("java.nio")) {
    return [
      { name: "Name", type: "string", value: mbean.split("name=")[1] ?? "direct" },
      { name: "Count", type: "number", value: "640", numeric: 640 },
      { name: "MemoryUsed", type: "number", value: `${(48 * MB).toFixed(0)} bytes`, numeric: 48 * MB },
      { name: "TotalCapacity", type: "number", value: `${(128 * MB).toFixed(0)} bytes`, numeric: 128 * MB },
    ];
  }
  if (mbean.startsWith("java.util.logging")) {
    return [
      { name: "LoggerNames", type: "list", value: "root, com.vega.catalog, org.springframework.web" },
      { name: "DefaultLevel", type: "string", value: "INFO" },
    ];
  }
  if (mbean.startsWith("com.sun.management")) {
    return [
      { name: "DiagnosticCommands", type: "list", value: "gc_heap_dump, thread_dump, vm.system_properties, compiler.c2" },
      { name: "CommandCount", type: "number", value: "58", numeric: 58 },
    ];
  }
  if (mbean.includes("type=Cache")) {
    const hitRatio = 0.78 + (state.cpuProcess % 0.2);
    return [
      { name: "Name", type: "string", value: mbean.split("name=")[1] ?? "productCache" },
      { name: "Size", type: "number", value: String(12_000 + (Math.round(state.oldUsed) % 9000)), numeric: 12_000 },
      { name: "HitRatio", type: "number", value: hitRatio.toFixed(4), numeric: +hitRatio.toFixed(4) },
      { name: "EvictionCount", type: "number", value: String(Math.round(state.youngCount / 3)), numeric: Math.round(state.youngCount / 3) },
      { name: "AverageLoadPenaltyMs", type: "number", value: (2 + (state.cpuProcess % 4)).toFixed(2), numeric: 2.1 },
    ];
  }
  if (mbean.includes("type=Datasource")) {
    const active = 6 + Math.round(state.cpuProcess * 14);
    return [
      { name: "ActiveConnections", type: "number", value: String(active), numeric: active },
      { name: "IdleConnections", type: "number", value: String(Math.max(0, 20 - active)), numeric: Math.max(0, 20 - active) },
      { name: "MaxPoolSize", type: "number", value: "20", numeric: 20 },
      { name: "WaitingThreads", type: "number", value: String(state.threadsLive > 70 ? 2 : 0), numeric: 0 },
      { name: "JdbcUrl", type: "string", value: "jdbc:postgresql://vega-postgres:5432/vega" },
    ];
  }
  if (mbean.includes("type=Scheduler")) {
    return [
      { name: "LastRunAt", type: "string", value: new Date(Date.now() - 45_000).toISOString() },
      { name: "RunsCompleted", type: "number", value: String(1840 + (Math.round(state.uptimeOffsetMs / 60_000) % 200)), numeric: 1840 },
      { name: "Failures", type: "number", value: "2", numeric: 2 },
      { name: "CronExpression", type: "string", value: "0 */5 * * * *" },
    ];
  }
  if (mbean.includes("type=RateLimiter")) {
    return [
      { name: "PermitsPerSecond", type: "number", value: "500", numeric: 500 },
      { name: "ThrottledRequests", type: "number", value: String(Math.round(state.youngCount / 2)), numeric: 0 },
      { name: "AvailablePermits", type: "number", value: String(400 + Math.round(state.cpuProcess * 90)), numeric: 400 },
    ];
  }
  return [
    { name: "Target", type: "string", value: target.name },
    { name: "Kind", type: "string", value: target.kind },
    { name: "Note", type: "string", value: "attributes unavailable for this mbean in the simulated model" },
  ];
}

function simulatedOperations(mbean: string): JvmMBean["operations"] {
  if (mbean === "java.lang:type=Memory") return [{ name: "gc", description: "Runs System.gc() (a hint to the JVM)" }];
  if (mbean === "java.lang:type=Threading") {
    return [
      { name: "dumpAllThreads", description: "Returns stack traces of all live threads" },
      { name: "resetPeakThreadCount", description: "Resets the peak live thread count" },
    ];
  }
  if (mbean === "java.lang:type=HotSpotDiagnostic" || mbean.startsWith("com.sun.management")) {
    return [{ name: "dumpHeap", description: "Dumps the heap to an hprof file on the JVM host" }];
  }
  if (mbean.includes("type=Cache")) return [{ name: "clear", description: "Invalidates every entry in the cache" }];
  if (mbean.includes("type=RateLimiter")) return [{ name: "reset", description: "Restores the configured permit rate" }];
  return [];
}

const OPERATIONS: Record<string, { mbean: string; op: string; label: string; danger?: boolean }> = {
  gc: { mbean: "java.lang:type=Memory", op: "gc", label: "Run GC" },
  resetPeakThreads: { mbean: "java.lang:type=Threading", op: "resetPeakThreadCount", label: "Reset peak thread count" },
  clearCache: { mbean: "com.vega.catalog:type=Cache,name=productCache", op: "clear", label: "Clear catalog cache" },
  resetRateLimiter: { mbean: "com.vega.catalog:type=RateLimiter,name=publicApi", op: "reset", label: "Reset rate limiter" },
};

export async function jvmOperation(id: string, op: keyof typeof OPERATIONS | string, args?: unknown[]): Promise<{ message: string; detail: string }> {
  const target = await resolveJvmTarget(id);
  if (!target) throw new Error(`JVM target ${id} not found`);
  const definition = OPERATIONS[op] ?? { mbean: String(op), op: "run", label: String(op) };
  if (target.kind === "jolokia" && !target.autoDiscovered) {
    const probed = await probeTarget(target, false);
    if (probed.status !== "online") throw new Error(`target ${target.name} is offline: ${probed.lastError ?? "no response"}`);
    const [result] = await jolokia(
      [{ type: "exec", mbean: definition.mbean, operation: definition.op, arguments: args ?? [] }],
      probed.url,
      15_000,
    );
    if (result?.status !== 200) throw new Error(result?.error ?? `${definition.op} failed`);
    return { message: `${definition.label} → ok on ${probed.name}`, detail: JSON.stringify(result.value ?? null) };
  }
  const state = simFor(target);
  tickSim(target, state);
  if (definition.op === "gc") {
    const reclaimed = +(state.oldUsed * 0.22).toFixed(1);
    state.oldUsed = Math.max(state.oldMaxMb * 0.15, state.oldUsed - reclaimed);
    state.edenUsed = +(state.edenMaxMb * 0.05).toFixed(1);
    state.oldCount += 1;
    pushGcEvent(target, { at: new Date().toISOString(), kind: "old", cause: "System.gc()", pauseMs: +(140 + Math.random() * 260).toFixed(1), reclaimedMb: reclaimed });
    return { message: `Run GC → reclaimed ${reclaimed} MB on ${target.name}`, detail: `System.gc() invoked (simulated full GC)` };
  }
  if (definition.op === "resetPeakThreadCount") {
    state.threadsPeak = state.threadsLive;
    return { message: `Reset peak thread count → ${state.threadsPeak} on ${target.name}`, detail: "java.lang:type=Threading.resetPeakThreadCount" };
  }
  if (definition.op === "clear") {
    return { message: `Clear catalog cache → evicted ~12k entries on ${target.name}`, detail: "com.vega.catalog:type=Cache,name=productCache.clear" };
  }
  return { message: `${definition.label} → ok on ${target.name}`, detail: `${definition.mbean}.${definition.op}` };
}

export async function captureJvmDump(id: string, kind: "thread" | "heap"): Promise<JvmDumpSummary> {
  const target = await resolveJvmTarget(id);
  if (!target) throw new Error(`JVM target ${id} not found`);

  if (kind === "thread") {
    const response = await jvmThreads(target.id);
    const content = threadsToText(target, response.threads, response.deadlocks);
    const inserted = await db
      .insert(jvmDumps)
      .values({
        targetId: target.id,
        targetName: target.name,
        kind: "thread",
        sizeKb: Math.max(1, Math.round(content.length / 1024)),
        path: null,
        summary: {
          threads: response.summary.total,
          runnable: response.summary.runnable,
          blocked: response.summary.blocked,
          deadlocks: response.deadlocks.length,
        },
        content: content.slice(0, 500_000),
      })
      .returning();
    return toDumpSummary(inserted[0]);
  }

  // heap dump
  const historyPoints = history.get(target.id) ?? [];
  if (target.kind === "simulated" || target.autoDiscovered) {
    const state = simFor(target);
    const usedMb = +(state.edenUsed + state.survivorUsed + state.oldUsed).toFixed(1);
    const content = [
      `Simulated hprof: ${usedMb} MB live set`,
      "Top retained size histogram (derived from the sampler's allocation profile):",
      ...["java.util.HashMap$Node", "com.vega.catalog.dto.ProductDto", "java.lang.String", "byte[]"].map(
        (className, index) => `  ${index + 1}: ${Math.round(usedMb * 1024 * (0.28 / (index + 1)))} KB  ${Math.round(usedMb * 12_000 * (0.3 / (index + 1)))}  ${className}`,
      ),
      "",
      "Note: for a real JVM connect a Jolokia endpoint (HotSpotDiagnostic.dumpHeap) or expose the Spring Actuator heapdump endpoint.",
    ].join("\n");
    const inserted = await db
      .insert(jvmDumps)
      .values({
        targetId: target.id,
        targetName: target.name,
        kind: "heap",
        sizeKb: Math.round(usedMb * 1024),
        path: `/tmp/heapdump-${target.app}-${Date.now()}.hprof (simulated)`,
        summary: { heapUsedMb: usedMb, heapMaxMb: state.heapMaxMb, simulated: true, analysed: true },
        content,
      })
      .returning();
    return toDumpSummary(inserted[0]);
  }

  const probed = await probeTarget(target, false);
  if (probed.status !== "online") throw new Error(`target ${target.name} is offline: ${probed.lastError ?? "no response"}`);

  if (probed.kind === "actuator") {
    const dir = path.join(os.tmpdir(), "dockflow-heapdumps");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${probed.name.replace(/[^\w.-]/g, "_")}-${Date.now()}.hprof`);
    const res = await fetch(`${actuatorBase(probed.url)}/heapdump`, { cache: "no-store" });
    if (!res.ok || !res.body) throw new Error(`heapdump endpoint returned ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(file, buffer);
    const inserted = await db
      .insert(jvmDumps)
      .values({
        targetId: probed.id,
        targetName: probed.name,
        kind: "heap",
        sizeKb: Math.round(buffer.byteLength / 1024),
        path: file,
        summary: { bytes: buffer.byteLength, path: file, endpoint: `${actuatorBase(probed.url)}/heapdump`, analysed: false },
        content: `heap dump downloaded to ${file} (${(buffer.byteLength / MB).toFixed(1)} MB).\nThis console stores metadata only; open the file in Eclipse MAT or jvisualvm for a full analysis.`,
      })
      .returning();
    return toDumpSummary(inserted[0]);
  }

  const fileName = `/tmp/heapdump-${probed.app || "jvm"}-${Date.now()}.hprof`;
  const [result] = await jolokia(
    [{ type: "exec", mbean: "com.sun.management:type=HotSpotDiagnostic", operation: "dumpHeap", arguments: [fileName, true] }],
    probed.url,
    60_000,
  );
  if (result?.status !== 200) throw new Error(result?.error ?? "dumpHeap failed");
  const heapUsedMb = historyPoints[historyPoints.length - 1]?.heapUsedMb ?? 0;
  const inserted = await db
    .insert(jvmDumps)
    .values({
      targetId: probed.id,
      targetName: probed.name,
      kind: "heap",
      sizeKb: Math.round(heapUsedMb * 1024),
      path: `${fileName} (on the JVM host)`,
      summary: { fileOnTarget: fileName, liveOnly: true, endpoint: `${jolokiaBase(probed.url)} (HotSpotDiagnostic.dumpHeap)`, heapUsedMb },
      content: `hprof written inside the target JVM host at ${fileName} (live objects only).\nCopy it out with: docker cp <container>:${fileName} ./\nThen open it in Eclipse MAT or jvisualvm for dominator/leak analysis.`,
    })
    .returning();
  return toDumpSummary(inserted[0]);
}

function toDumpSummary(row: typeof jvmDumps.$inferSelect): JvmDumpSummary {
  return {
    id: row.id,
    targetId: row.targetId,
    targetName: row.targetName,
    kind: row.kind as JvmDumpSummary["kind"],
    sizeKb: row.sizeKb,
    path: row.path,
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listJvmDumps(targetId?: string): Promise<JvmDumpSummary[]> {
  const query = db.select().from(jvmDumps).orderBy(desc(jvmDumps.createdAt)).limit(60);
  const rows = targetId ? await db.select().from(jvmDumps).where(eq(jvmDumps.targetId, targetId)).orderBy(desc(jvmDumps.createdAt)).limit(60) : await query;
  return rows.map(toDumpSummary);
}

export async function getJvmDump(dumpId: string): Promise<{ dump: JvmDumpSummary; content: string } | null> {
  const rows = await db.select().from(jvmDumps).where(eq(jvmDumps.id, dumpId)).limit(1);
  if (!rows.length) return null;
  return { dump: toDumpSummary(rows[0]), content: rows[0].content };
}

export async function removeJvmDump(dumpId: string): Promise<void> {
  await db.delete(jvmDumps).where(eq(jvmDumps.id, dumpId));
}
