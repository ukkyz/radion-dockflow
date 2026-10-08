import fs from "node:fs";
import { Writable } from "node:stream";
import Docker from "dockerode";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dockerHosts } from "@/db/schema";
import type {
  ContainerInfo,
  ContainerStats,
  DockerEndpoint,
  DockerMode,
  DockerOverview,
  EngineInfo,
  HierarchyNode,
  HierarchyPayload,
  ImageInfo,
  NetworkInfo,
  VolumeInfo,
} from "./types";
import { demoContainerAction, demoEngine, demoLogs, demoState, demoStats, demoTick, demoExec } from "./demo";

type Loose = Record<string, any>;

export interface ResolvedEndpoint extends DockerEndpoint {
  socketPath?: string;
  host?: string;
  port?: number;
}

interface ProbeResult {
  endpoint: ResolvedEndpoint;
  mode: DockerMode;
  error: string | null;
  engine: EngineInfo;
  at: number;
}

const globalForDocker = globalThis as typeof globalThis & {
  __dockerProbe?: ProbeResult;
  __dockerStatsCache?: Map<string, { at: number; value: ContainerStats }>;
  __dockerInfoCache?: Map<string, { at: number; value: ContainerInfo }>;
  __dockerEndpoints?: { at: number; value: ResolvedEndpoint[] };
};

const statsCache = globalForDocker.__dockerStatsCache ?? new Map();
globalForDocker.__dockerStatsCache = statsCache;
const infoCache = globalForDocker.__dockerInfoCache ?? new Map();
globalForDocker.__dockerInfoCache = infoCache;

const PROBE_TTL_MS = 15_000;
const STATS_TTL_MS = 5_000;
const INFO_TTL_MS = 4_000;

export function parseEndpointAddress(raw: string): ResolvedEndpoint | null {
  const address = raw.trim();
  if (!address) return null;
  if (address.startsWith("unix://")) {
    return {
      id: "unix",
      name: `unix://${address.replace("unix://", "")}`,
      kind: "unix",
      address,
      socketPath: address.replace("unix://", ""),
      isDefault: true,
      status: "unknown",
    };
  }
  if (address.startsWith("/")) {
    return { id: "unix", name: address, kind: "unix", address, socketPath: address, isDefault: true, status: "unknown" };
  }
  if (address.startsWith("tcp://") || address.startsWith("http://")) {
    const url = new URL(address.replace("tcp://", "http://"));
    return {
      id: "tcp",
      name: address,
      kind: "tcp",
      address,
      host: url.hostname,
      port: Number(url.port || 2375),
      isDefault: true,
      status: "unknown",
    };
  }
  if (address.startsWith("npipe://")) {
    return { id: "npipe", name: address, kind: "npipe", address, isDefault: true, status: "unknown" };
  }
  const [host, port] = address.split(":");
  return {
    id: "tcp",
    name: address,
    kind: "tcp",
    address,
    host,
    port: Number(port ?? 2375),
    isDefault: true,
    status: "unknown",
  };
}

/** Drops the endpoint/probe caches so new or removed hosts are picked up immediately. */
export function invalidateEndpointCache(): void {
  globalForDocker.__dockerEndpoints = undefined;
  globalForDocker.__dockerProbe = undefined;
}

export async function listEndpoints(): Promise<ResolvedEndpoint[]> {
  const cached = globalForDocker.__dockerEndpoints;
  if (cached && Date.now() - cached.at < 10_000) return cached.value;

  const out: ResolvedEndpoint[] = [];
  try {
    const rows = await db.select().from(dockerHosts);
    for (const row of rows) {
      const parsed = parseEndpointAddress(row.address);
      if (!parsed) continue;
      out.push({
        ...parsed,
        id: row.id,
        name: row.name || parsed.name,
        kind: (row.kind as ResolvedEndpoint["kind"]) ?? parsed.kind,
        isDefault: row.isDefault,
        status: row.status === "online" ? "online" : row.status === "offline" ? "offline" : "unknown",
      });
    }
  } catch (error) {
    // DB may not be ready yet - fall through to env defaults, but say why.
    console.warn("[docker] stored endpoint lookup failed:", error instanceof Error ? error.message : error);
  }

  const envAddress =
    process.env.DOCKER_HOST ||
    process.env.DOCKER_SOCKET ||
    (fs.existsSync("/var/run/docker.sock") ? "unix:///var/run/docker.sock" : "tcp://127.0.0.1:2375");
  const envEndpoint = parseEndpointAddress(envAddress);
  if (envEndpoint && !out.some((e) => e.address === envEndpoint.address)) {
    envEndpoint.isDefault = out.length === 0;
    out.push(envEndpoint);
  }
  if (out.length === 0 && envEndpoint) out.push(envEndpoint);

  globalForDocker.__dockerEndpoints = { at: Date.now(), value: out };
  return out;
}

function clientFor(endpoint: ResolvedEndpoint): Docker {
  if (endpoint.kind === "tcp" && endpoint.host) {
    return new Docker({ host: endpoint.host, port: endpoint.port ?? 2375 });
  }
  return new Docker({ socketPath: endpoint.socketPath ?? "/var/run/docker.sock" });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`docker request timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function engineFromLive(info: Loose, version: Loose): EngineInfo {
  const memBytes = Number(info.MemTotal ?? 0);
  return {
    serverVersion: String(version?.Version ?? info.ServerVersion ?? "unknown"),
    apiVersion: String(version?.ApiVersion ?? "unknown"),
    os: String(info.OperatingSystem ?? info.OSType ?? "unknown"),
    arch: String(info.Architecture ?? "unknown"),
    kernelVersion: String(info.KernelVersion ?? "unknown"),
    cpus: Number(info.NCPU ?? 0),
    totalMemoryMb: Math.round(memBytes / (1024 * 1024)),
    driver: String(info.Driver ?? "unknown"),
    runtime: String(info.DefaultRuntime ?? "runc"),
    name: String(info.Name ?? "local"),
    warnings: Array.isArray(info.Warnings) ? info.Warnings.map(String) : [],
  };
}

export interface EngineConnection {
  endpoint: ResolvedEndpoint;
  mode: DockerMode;
  error: string | null;
  engine: EngineInfo;
  docker: Docker | null;
}

export async function connectEngine(force = false): Promise<EngineConnection> {
  const cached = globalForDocker.__dockerProbe;
  if (!force && cached && Date.now() - cached.at < PROBE_TTL_MS) {
    return {
      endpoint: cached.endpoint,
      mode: cached.mode,
      error: cached.error,
      engine: cached.engine,
      docker: cached.mode === "live" ? clientFor(cached.endpoint) : null,
    };
  }

  const endpoints = await listEndpoints();
  const ordered = [...endpoints].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  let lastError: string | null = null;

  for (const endpoint of ordered) {
    if (endpoint.kind === "npipe") {
      lastError = "npipe endpoints require a Windows host";
      continue;
    }
    if (endpoint.kind === "unix" && endpoint.socketPath && !fs.existsSync(endpoint.socketPath)) {
      lastError = `no docker socket at ${endpoint.socketPath}`;
      continue;
    }
    try {
      const docker = clientFor(endpoint);
      await withTimeout(docker.ping(), 2500);
      const [version, info] = await Promise.all([
        withTimeout(docker.version(), 3000) as Promise<Loose>,
        withTimeout(docker.info(), 4000) as Promise<Loose>,
      ]);
      const engine = engineFromLive(info, version);
      const result: ProbeResult = { endpoint, mode: "live", error: null, engine, at: Date.now() };
      globalForDocker.__dockerProbe = result;
      void markHost(endpoint.id, "online", engine.serverVersion);
      return { endpoint, mode: "live", error: null, engine, docker };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  const endpoint = ordered[0] ?? parseEndpointAddress("unix:///var/run/docker.sock")!;
  const result: ProbeResult = {
    endpoint,
    mode: "demo",
    error: lastError,
    engine: demoEngine(),
    at: Date.now(),
  };
  globalForDocker.__dockerProbe = result;
  return { endpoint, mode: "demo", error: lastError, engine: result.engine, docker: null };
}

async function markHost(id: string, status: string, serverVersion?: string): Promise<void> {
  if (!id || id === "unix" || id === "tcp" || id === "npipe") return;
  try {
    await db.update(dockerHosts).set({ status, serverVersion, lastSeenAt: new Date(), lastError: null }).where(eq(dockerHosts.id, id));
  } catch {
    /* ignore */
  }
}

export async function pingDocker(force = true): Promise<{
  mode: DockerMode;
  endpoint: DockerEndpoint;
  error: string | null;
  engine: EngineInfo;
}> {
  const conn = await connectEngine(force);
  const { docker: _docker, ...rest } = conn;
  return rest;
}

/* ------------------------------------------------------------------ */
/* normalisation                                                       */
/* ------------------------------------------------------------------ */

function healthOf(status: string, raw?: string): ContainerInfo["health"] {
  const text = `${status} ${raw ?? ""}`.toLowerCase();
  if (text.includes("(healthy)")) return "healthy";
  if (text.includes("(unhealthy)")) return "unhealthy";
  if (text.includes("(health: starting)")) return "starting";
  return null;
}

function statsToSnapshot(stats: Loose): Omit<ContainerStats, "id" | "history"> {
  const cpuTotal = Number(stats.cpu_stats?.cpu_usage?.total_usage ?? 0);
  const preTotal = Number(stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta = Number(stats.cpu_stats?.system_cpu_usage ?? 0) - Number(stats.precpu_stats?.system_cpu_usage ?? 0);
  const cpuCount =
    Number(stats.cpu_stats?.online_cpus ?? 0) ||
    Number(stats.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 0) ||
    1;
  const cpuPercent =
    systemDelta > 0 && cpuTotal >= preTotal ? +(((cpuTotal - preTotal) / systemDelta) * cpuCount * 100).toFixed(2) : 0;

  const memUsage = Number(stats.memory_stats?.usage ?? 0) - Number(stats.memory_stats?.stats?.inactive_file ?? stats.memory_stats?.stats?.cache ?? 0);
  const memLimit = Number(stats.memory_stats?.limit ?? 0);
  const memUsageMb = +(Math.max(0, memUsage) / (1024 * 1024)).toFixed(1);
  const memLimitMb = +(memLimit / (1024 * 1024)).toFixed(1);

  let rx = 0;
  let tx = 0;
  for (const iface of Object.values(stats.networks ?? {}) as Loose[]) {
    rx += Number(iface?.rx_bytes ?? 0);
    tx += Number(iface?.tx_bytes ?? 0);
  }
  let read = 0;
  let write = 0;
  for (const entry of (stats.blkio_stats?.io_service_bytes_recursive ?? []) as Loose[]) {
    const op = String(entry?.op ?? "").toLowerCase();
    if (op === "read") read += Number(entry?.value ?? 0);
    if (op === "write") write += Number(entry?.value ?? 0);
  }

  return {
    cpuPercent,
    memUsageMb,
    memLimitMb,
    memPercent: memLimitMb > 0 ? +((memUsageMb / memLimitMb) * 100).toFixed(1) : 0,
    netRxMb: +(rx / (1024 * 1024)).toFixed(2),
    netTxMb: +(tx / (1024 * 1024)).toFixed(2),
    blockReadMb: +(read / (1024 * 1024)).toFixed(2),
    blockWriteMb: +(write / (1024 * 1024)).toFixed(2),
    pids: Number(stats.pids_stats?.current ?? 0),
  };
}

function normalizeContainer(list: Loose, inspect: Loose | undefined, snapshot?: Omit<ContainerStats, "id" | "history">): ContainerInfo {
  const state = inspect?.State ?? {};
  const labels: Record<string, string> = (inspect?.Config?.Labels ?? list.Labels ?? {}) as Record<string, string>;
  const name = (list.Names?.[0] ?? inspect?.Name ?? "unknown").replace(/^\//, "");
  const networks: Loose = inspect?.NetworkSettings?.Networks ?? list.NetworkSettings?.Networks ?? {};
  const mounts = ((inspect?.Mounts ?? list.Mounts ?? []) as Loose[]).map((m) => ({
    type: String(m.Type ?? "volume"),
    source: String(m.Source ?? m.Name ?? ""),
    target: String(m.Destination ?? ""),
    mode: m.Mode ? String(m.Mode) : m.RW === false ? "ro" : "rw",
    sizeMb: m.UsageData?.Size ? +(Number(m.UsageData.Size) / 1048576).toFixed(1) : undefined,
  }));

  const status = String(list.Status ?? inspect?.State?.Status ?? "");
  const stateName = String(list.State ?? inspect?.State?.Status ?? "unknown");

  return {
    id: String(list.Id),
    shortId: String(list.Id).slice(0, 12),
    name,
    image: String(list.Image ?? inspect?.Config?.Image ?? ""),
    imageId: String(list.ImageID ?? inspect?.Image ?? ""),
    command: String(inspect?.Config?.Cmd?.join(" ") ?? list.Command ?? ""),
    platform: String(inspect?.Platform ?? "linux"),
    state: stateName,
    status: stateName === "running" ? `Up ${status.replace("Up ", "")}` : status || stateName,
    health: healthOf(status, state.Health?.Status),
    createdAt: new Date(Number(list.Created ?? 0) * 1000 || Date.now()).toISOString(),
    startedAt: state.StartedAt && !String(state.StartedAt).startsWith("0001") ? String(state.StartedAt) : null,
    finishedAt: state.FinishedAt && !String(state.FinishedAt).startsWith("0001") ? String(state.FinishedAt) : null,
    restartCount: Number(inspect?.RestartCount ?? 0),
    exitCode: state.ExitCode ?? null,
    labels,
    composeProject: labels["com.docker.compose.project"] ?? null,
    composeService: labels["com.docker.compose.service"] ?? null,
    ports: ((list.Ports ?? []) as Loose[])
      .filter((p) => p && p.PublicPort)
      .map((p) => ({
        host: p.PublicPort ? Number(p.PublicPort) : null,
        container: Number(p.PrivatePort ?? 0),
        protocol: String(p.Type ?? "tcp"),
        hostIp: p.IP ? String(p.IP) : undefined,
      })),
    networks: Object.entries(networks).map(([netName, cfg]) => ({
      name: netName,
      id: (cfg as Loose)?.NetworkID ? String((cfg as Loose).NetworkID) : undefined,
      ip: (cfg as Loose)?.IPAddress ? String((cfg as Loose).IPAddress) : undefined,
      aliases: ((cfg as Loose)?.Aliases ?? []) as string[],
    })),
    mounts,
    cpuPercent: snapshot?.cpuPercent ?? 0,
    memUsageMb: snapshot?.memUsageMb ?? 0,
    memLimitMb: snapshot?.memLimitMb ?? +(Number(inspect?.HostConfig?.Memory ?? 0) / 1048576).toFixed(1),
    memPercent: snapshot?.memPercent ?? 0,
    netRxMb: snapshot?.netRxMb ?? 0,
    netTxMb: snapshot?.netTxMb ?? 0,
    blockReadMb: snapshot?.blockReadMb ?? 0,
    blockWriteMb: snapshot?.blockWriteMb ?? 0,
    pids: snapshot?.pids ?? 0,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      out[current] = await fn(items[current]);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------ */
/* read APIs                                                           */
/* ------------------------------------------------------------------ */

export async function listContainers(): Promise<{ mode: DockerMode; containers: ContainerInfo[] }> {
  const conn = await connectEngine();
  if (conn.mode === "demo" || !conn.docker) {
    demoTick();
    return { mode: "demo", containers: demoState().containers.map((c) => ({ ...c })) };
  }
  const docker = conn.docker;
  const list = (await docker.listContainers({ all: true })) as unknown as Loose[];
  const containers = await mapLimit(list, 8, async (item) => {
    const id = String(item.Id);
    const cached = infoCache.get(id);
    const snap = statsCache.get(id)?.value;
    const snapshot = snap
      ? {
          cpuPercent: snap.cpuPercent,
          memUsageMb: snap.memUsageMb,
          memLimitMb: snap.memLimitMb,
          memPercent: snap.memPercent,
          netRxMb: snap.netRxMb,
          netTxMb: snap.netTxMb,
          blockReadMb: snap.blockReadMb,
          blockWriteMb: snap.blockWriteMb,
          pids: snap.pids,
        }
      : undefined;
    try {
      const inspect = (await withTimeout(docker.getContainer(id).inspect(), 4000)) as unknown as Loose;
      const info = normalizeContainer(item, inspect, snapshot);
      infoCache.set(id, { at: Date.now(), value: info });
      return info;
    } catch {
      if (cached) return cached.value;
      return normalizeContainer(item, undefined, snapshot);
    }
  });
  return { mode: "live", containers };
}

export async function getContainer(id: string): Promise<ContainerInfo | null> {
  const conn = await connectEngine();
  if (conn.mode === "demo" || !conn.docker) {
    demoTick();
    const found = demoState().containers.find((c) => c.id.startsWith(id) || c.name === id);
    return found ? { ...found } : null;
  }
  try {
    const inspect = (await withTimeout(conn.docker.getContainer(id).inspect(), 4000)) as unknown as Loose;
    const snap = statsCache.get(id)?.value;
    return normalizeContainer(
      {
        Id: inspect.Id,
        Names: [inspect.Name],
        Image: inspect.Config?.Image,
        ImageID: inspect.Image,
        Command: inspect.Config?.Cmd?.join(" "),
        Created: Math.floor(new Date(inspect.Created).getTime() / 1000),
        State: inspect.State?.Status,
        Status: inspect.State?.Status,
        Ports: Object.entries(inspect.NetworkSettings?.Ports ?? {}).flatMap(([port, bindings]) =>
          (bindings as Loose[] | null ?? []).map((b) => ({
            PrivatePort: Number(port.split("/")[0]),
            PublicPort: Number(b.HostPort),
            Type: port.split("/")[1],
            IP: b.HostIp,
          })),
        ),
        Mounts: inspect.Mounts,
        Labels: inspect.Config?.Labels,
        NetworkSettings: inspect.NetworkSettings,
      },
      inspect,
      snap
        ? {
            cpuPercent: snap.cpuPercent,
            memUsageMb: snap.memUsageMb,
            memLimitMb: snap.memLimitMb,
            memPercent: snap.memPercent,
            netRxMb: snap.netRxMb,
            netTxMb: snap.netTxMb,
            blockReadMb: snap.blockReadMb,
            blockWriteMb: snap.blockWriteMb,
            pids: snap.pids,
          }
        : undefined,
    );
  } catch {
    return null;
  }
}

export async function getContainerStats(id: string): Promise<ContainerStats> {
  const conn = await connectEngine();
  if (conn.mode === "demo" || !conn.docker) return demoStats(id);
  const cached = statsCache.get(id);
  if (cached && Date.now() - cached.at < STATS_TTL_MS) return cached.value;
  try {
    const raw = (await withTimeout(conn.docker.getContainer(id).stats({ stream: false }), 4000)) as unknown as Loose;
    const snapshot = statsToSnapshot(raw);
    const history = cached?.value.history.slice(-39) ?? [];
    history.push({ ts: new Date().toISOString(), cpu: snapshot.cpuPercent, mem: snapshot.memUsageMb, net: snapshot.netRxMb });
    const value: ContainerStats = { id, ...snapshot, history };
    statsCache.set(id, { at: Date.now(), value });
    return value;
  } catch (error) {
    if (cached) return cached.value;
    return {
      id,
      cpuPercent: 0,
      memUsageMb: 0,
      memLimitMb: 0,
      memPercent: 0,
      netRxMb: 0,
      netTxMb: 0,
      blockReadMb: 0,
      blockWriteMb: 0,
      pids: 0,
      history: [],
      ...(error ? {} : {}),
    };
  }
}

export async function getContainerLogs(id: string, tail = 300): Promise<{ mode: DockerMode; logs: string }> {
  const conn = await connectEngine();
  if (conn.mode === "demo" || !conn.docker) return { mode: "demo", logs: demoLogs(id, tail) };
  try {
    const buffer = (await withTimeout(
      conn.docker.getContainer(id).logs({ stdout: true, stderr: true, timestamps: true, tail, follow: false }) as Promise<Buffer>,
      6000,
    )) as unknown as Buffer;
    const text = demuxDockerStream(buffer);
    return { mode: "live", logs: text };
  } catch (error) {
    return { mode: "live", logs: `failed to read logs: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Docker multiplexes stdout/stderr with 8 byte frame headers when TTY is disabled. */
function demuxDockerStream(buffer: Buffer): string {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return "";
  const chunks: string[] = [];
  let offset = 0;
  let framed = false;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const streamType = buffer[offset];
    if ((streamType === 0 || streamType === 1 || streamType === 2) && size > 0 && offset + 8 + size <= buffer.length) {
      framed = true;
      chunks.push(buffer.subarray(offset + 8, offset + 8 + size).toString("utf8"));
      offset += 8 + size;
    } else {
      break;
    }
  }
  return framed && offset >= buffer.length - 1 ? chunks.join("") : buffer.toString("utf8");
}

export async function listImages(): Promise<{ mode: DockerMode; images: ImageInfo[] }> {
  const conn = await connectEngine();
  if (conn.mode === "demo" || !conn.docker) {
    return { mode: "demo", images: demoState().images };
  }
  const raw = (await conn.docker.listImages({ all: false })) as unknown as Loose[];
  const containers = await listContainers();
  return {
    mode: "live",
    images: raw.map((img) => {
      const tags = ((img.RepoTags ?? ["<none>:<none>"]) as string[]).filter((t) => t !== "<none>:<none>");
      const id = String(img.Id);
      return {
        id,
        shortId: id.replace("sha256:", "").slice(0, 12),
        tags: tags.length ? tags : ["<none>"],
        sizeMb: +(Number(img.Size ?? 0) / 1048576).toFixed(1),
        createdAt: new Date(Number(img.Created ?? 0) * 1000).toISOString(),
        containers: containers.containers.filter((c) => c.imageId === id || tags.includes(c.image)).length,
        labels: (img.Labels ?? {}) as Record<string, string>,
      };
    }),
  };
}

export async function listVolumes(): Promise<{ mode: DockerMode; volumes: VolumeInfo[] }> {
  const conn = await connectEngine();
  if (conn.mode === "demo" || !conn.docker) return { mode: "demo", volumes: demoState().volumes };
  const res = (await conn.docker.listVolumes()) as unknown as { Volumes?: Loose[] };
  const containers = await listContainers();
  return {
    mode: "live",
    volumes: (res.Volumes ?? []).map((v) => ({
      name: String(v.Name),
      driver: String(v.Driver ?? "local"),
      mountpoint: String(v.Mountpoint ?? ""),
      createdAt: v.CreatedAt ? new Date(String(v.CreatedAt)).toISOString() : new Date().toISOString(),
      containers: containers.containers
        .filter((c) => c.mounts.some((m) => m.source === v.Name || m.source.endsWith(`/${v.Name}`)))
        .map((c) => ({ id: c.id, name: c.name })),
      sizeMb: 0,
    })),
  };
}

export async function listNetworks(): Promise<{ mode: DockerMode; networks: NetworkInfo[] }> {
  const conn = await connectEngine();
  if (conn.mode === "demo" || !conn.docker) return { mode: "demo", networks: demoState().networks };
  const raw = (await conn.docker.listNetworks()) as unknown as Loose[];
  const containers = await listContainers();
  return {
    mode: "live",
    networks: raw.map((n) => ({
      id: String(n.Id),
      name: String(n.Name),
      driver: String(n.Driver ?? "bridge"),
      scope: String(n.Scope ?? "local"),
      internal: Boolean(n.Internal),
      attachable: Boolean(n.Attachable),
      subnet: (n.IPAM?.Config?.[0]?.Subnet as string | undefined) ?? null,
      containers: containers.containers
        .filter((c) => c.networks.some((x) => x.name === n.Name))
        .map((c) => ({
          id: c.id,
          name: c.name,
          ip: c.networks.find((x) => x.name === n.Name)?.ip,
        })),
      labels: (n.Labels ?? {}) as Record<string, string>,
    })),
  };
}

export async function getOverview(): Promise<DockerOverview> {
  const conn = await connectEngine();
  const [containers, images, volumes, networks] = await Promise.all([
    listContainers(),
    listImages(),
    listVolumes(),
    listNetworks(),
  ]);
  const list = containers.containers;
  const totalCpu = list.reduce((sum, c) => sum + c.cpuPercent, 0);
  const totalMem = list.reduce((sum, c) => sum + c.memUsageMb, 0);
  const memLimit = conn.engine.totalMemoryMb || 1;
  return {
    mode: conn.mode,
    endpoint: conn.endpoint,
    error: conn.error,
    engine: conn.engine,
    counts: {
      containers: list.length,
      running: list.filter((c) => c.state === "running").length,
      paused: list.filter((c) => c.state === "paused").length,
      stopped: list.filter((c) => ["exited", "created", "dead"].includes(c.state)).length,
      unhealthy: list.filter((c) => c.health === "unhealthy" || c.state === "restarting").length,
      images: images.images.length,
      volumes: volumes.volumes.length,
      networks: networks.networks.length,
      totalCpuPercent: +totalCpu.toFixed(1),
      totalMemMb: +totalMem.toFixed(0),
      memLimitMb: memLimit,
      diskImagesMb: +images.images.reduce((sum, i) => sum + i.sizeMb, 0).toFixed(0),
    },
    updatedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* mutations                                                           */
/* ------------------------------------------------------------------ */

export type ContainerAction =
  | "start"
  | "stop"
  | "restart"
  | "pause"
  | "unpause"
  | "kill"
  | "remove";

export async function containerAction(id: string, action: ContainerAction): Promise<{ mode: DockerMode; message: string }> {
  const conn = await connectEngine();
  if (conn.mode === "demo" || !conn.docker) {
    return { mode: "demo", message: demoContainerAction(id, action) };
  }
  const container = conn.docker.getContainer(id);
  switch (action) {
    case "start":
      await container.start();
      break;
    case "stop":
      await container.stop({ t: 5 });
      break;
    case "restart":
      await container.restart({ t: 5 });
      break;
    case "pause":
      await container.pause();
      break;
    case "unpause":
      await container.unpause();
      break;
    case "kill":
      await container.kill();
      break;
    case "remove":
      await container.remove({ force: true, v: true });
      break;
    default:
      throw new Error(`unsupported action ${action}`);
  }
  infoCache.delete(id);
  statsCache.delete(id);
  return { mode: "live", message: `${action} ${id.slice(0, 12)}: ok` };
}

export async function execInContainer(id: string, cmd: string[]): Promise<{ mode: DockerMode; output: string; exitCode: number | null }> {
  const conn = await connectEngine();
  if (conn.mode === "demo" || !conn.docker) {
    return { mode: "demo", output: demoExec(id, cmd), exitCode: 0 };
  }
  const docker = conn.docker;
  const container = docker.getContainer(id);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });
  const stream = (await exec.start({ hijack: false, stdin: false })) as unknown as NodeJS.ReadableStream;
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let combined = "";
  await new Promise<void>((resolve, reject) => {
    const stdout = new Writable({
      write(chunk: Buffer, _enc: string, cb: () => void) {
        out.push(Buffer.from(chunk));
        cb();
      },
    });
    const stderr = new Writable({
      write(chunk: Buffer, _enc: string, cb: () => void) {
        err.push(Buffer.from(chunk));
        cb();
      },
    });
    docker.modem.demuxStream(stream, stdout, stderr);
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  combined = Buffer.concat(out).toString("utf8") + Buffer.concat(err).toString("utf8");
  const inspected = await exec.inspect();
  return { mode: "live", output: combined, exitCode: inspected.ExitCode ?? null };
}

export async function runNewContainer(input: {
  image: string;
  name?: string;
  ports?: { host: number; container: number; protocol?: string }[];
  env?: string[];
  command?: string;
  detach?: boolean;
}): Promise<{ mode: DockerMode; id: string; message: string }> {
  const conn = await connectEngine();
  if (conn.mode === "demo" || !conn.docker) {
    const state = demoState();
    const id = Math.random().toString(16).slice(2).padEnd(64, "0");
    const now = new Date().toISOString();
    state.containers.push({
      id,
      shortId: id.slice(0, 12),
      name: input.name || `demo-${id.slice(0, 6)}`,
      image: input.image,
      imageId: `sha256:${id.slice(0, 12)}`,
      command: input.command || "demo run",
      platform: "linux/amd64",
      state: "running",
      status: "Up 1 second",
      health: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      restartCount: 0,
      exitCode: null,
      labels: input.env?.length ? { "demo.env": input.env.join(",") } : {},
      composeProject: null,
      composeService: null,
      ports: (input.ports ?? []).map((p) => ({ host: p.host, container: p.container, protocol: p.protocol ?? "tcp" })),
      networks: [{ name: "bridge", ip: "172.17.0.9" }],
      mounts: [],
      cpuPercent: 1.5,
      memUsageMb: 32,
      memLimitMb: 512,
      memPercent: 6.3,
      netRxMb: 0.4,
      netTxMb: 0.2,
      blockReadMb: 0,
      blockWriteMb: 0,
      pids: 4,
      history: [],
      logCursor: 0,
      networkId: id.slice(0, 32),
    });
    state.logs[id] = [`${now} [engine] created from ${input.image}`];
    return { mode: "demo", id, message: `demo container ${input.name ?? id.slice(0, 12)} started` };
  }
  const portBindings: Record<string, { HostPort: string }[]> = {};
  const exposedPorts: Record<string, object> = {};
  for (const p of input.ports ?? []) {
    const key = `${p.container}/${p.protocol ?? "tcp"}`;
    exposedPorts[key] = {};
    portBindings[key] = [{ HostPort: String(p.host) }];
  }
  const created = await conn.docker.createContainer({
    Image: input.image,
    name: input.name || undefined,
    Cmd: input.command ? input.command.split(/\s+/) : undefined,
    Env: input.env,
    ExposedPorts: exposedPorts,
    HostConfig: { PortBindings: portBindings, RestartPolicy: { Name: "unless-stopped" } },
  });
  await created.start();
  return { mode: "live", id: created.id, message: `container ${input.name ?? created.id.slice(0, 12)} started` };
}

export async function prune(kind: "images" | "volumes" | "networks" | "containers"): Promise<{ mode: DockerMode; message: string }> {
  const conn = await connectEngine();
  if (conn.mode === "demo" || !conn.docker) {
    const state = demoState();
    if (kind === "containers") {
      const before = state.containers.length;
      state.containers = state.containers.filter((c) => c.state !== "exited");
      return { mode: "demo", message: `removed ${before - state.containers.length} stopped containers` };
    }
    return { mode: "demo", message: `pruned ${kind} (simulated)` };
  }
  const docker = conn.docker;
  if (kind === "images") {
    const res = (await docker.pruneImages()) as unknown as { SpaceReclaimed?: number };
    return { mode: "live", message: `reclaimed ${((res.SpaceReclaimed ?? 0) / 1048576).toFixed(1)} MB of image data` };
  }
  if (kind === "volumes") {
    const res = (await docker.pruneVolumes()) as unknown as { SpaceReclaimed?: number };
    return { mode: "live", message: `reclaimed ${((res.SpaceReclaimed ?? 0) / 1048576).toFixed(1)} MB of volume data` };
  }
  if (kind === "networks") {
    const res = (await docker.pruneNetworks()) as unknown as Loose;
    return { mode: "live", message: `pruned ${Array.isArray(res?.NetworksDeleted) ? res.NetworksDeleted.length : 0} networks` };
  }
  const res = (await docker.pruneContainers()) as unknown as Loose;
  return { mode: "live", message: `removed ${Array.isArray(res?.ContainersDeleted) ? res.ContainersDeleted.length : 0} containers` };
}

export async function removeResource(kind: "image" | "volume" | "network", id: string): Promise<{ mode: DockerMode; message: string }> {
  const conn = await connectEngine();
  if (conn.mode === "demo" || !conn.docker) {
    const state = demoState();
    if (kind === "image") state.images = state.images.filter((i) => i.id !== id && i.shortId !== id);
    if (kind === "volume") state.volumes = state.volumes.filter((v) => v.name !== id);
    if (kind === "network") state.networks = state.networks.filter((n) => n.id !== id && n.name !== id);
    return { mode: "demo", message: `${kind} ${id} removed (simulated)` };
  }
  const docker = conn.docker;
  if (kind === "image") await docker.getImage(id).remove({ force: true });
  if (kind === "volume") await docker.getVolume(id).remove({ force: true });
  if (kind === "network") await docker.getNetwork(id).remove();
  return { mode: "live", message: `${kind} ${id} removed` };
}

export async function projectAction(project: string, action: "start" | "stop" | "restart"): Promise<{ mode: DockerMode; message: string }> {
  const conn = await connectEngine();
  const { containers } = await listContainers();
  const target = containers.filter((c) => (c.composeProject ?? "standalone") === project);
  let count = 0;
  for (const c of target) {
    if (conn.mode === "demo") {
      demoContainerAction(c.id, action === "stop" ? "stop" : action === "restart" ? "restart" : "start");
      count += 1;
      continue;
    }
    try {
      await containerAction(c.id, action);
      count += 1;
    } catch {
      /* keep going */
    }
  }
  return { mode: conn.mode, message: `${action} applied to ${count} containers in ${project}` };
}

/* ------------------------------------------------------------------ */
/* hierarchy for the xyflow map                                        */
/* ------------------------------------------------------------------ */

export async function buildHierarchy(): Promise<HierarchyPayload> {
  const conn = await connectEngine();
  const [containersRes, imagesRes, volumesRes, networksRes] = await Promise.all([
    listContainers(),
    listImages(),
    listVolumes(),
    listNetworks(),
  ]);
  const nodes: HierarchyNode[] = [];
  const edges: { id: string; source: string; target: string }[] = [];
  const hostId = "host:local";

  const add = (node: HierarchyNode) => {
    nodes.push(node);
    if (node.parentId) edges.push({ id: `e:${node.parentId}->${node.id}`, source: node.parentId, target: node.id });
  };

  const running = containersRes.containers.filter((c) => c.state === "running").length;
  add({
    id: hostId,
    kind: "host",
    label: conn.mode === "live" ? conn.engine.name : "localhost (demo engine)",
    subtitle: conn.endpoint.address,
    status: conn.mode === "live" ? "up" : "demo",
    parentId: null,
    badge: `${running}/${containersRes.containers.length} running`,
    detail: {
      endpoint: conn.endpoint.address,
      mode: conn.mode,
      serverVersion: conn.engine.serverVersion,
      apiVersion: conn.engine.apiVersion,
      os: `${conn.engine.os} · ${conn.engine.arch}`,
      cpus: conn.engine.cpus,
      totalMemoryMb: conn.engine.totalMemoryMb,
      storageDriver: conn.engine.driver,
      runtime: conn.engine.runtime,
      error: conn.error,
    },
  });

  const byProject = new Map<string, typeof containersRes.containers>();
  for (const c of containersRes.containers) {
    const project = c.composeProject ?? "standalone";
    byProject.set(project, [...(byProject.get(project) ?? []), c]);
  }

  for (const [project, list] of [...byProject.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const projectId = `project:${project}`;
    const projectRunning = list.filter((c) => c.state === "running").length;
    const projectUnhealthy = list.filter((c) => c.health === "unhealthy").length;
    add({
      id: projectId,
      kind: "project",
      label: project,
      subtitle: `${list.length} containers`,
      status: projectUnhealthy > 0 ? "degraded" : "up",
      parentId: hostId,
      badge: `${projectRunning}/${list.length} up`,
      detail: { project, containers: list.length, running: projectRunning, unhealthy: projectUnhealthy },
    });

    const byService = new Map<string, typeof list>();
    for (const c of list) {
      const service = c.composeService ?? c.name.replace(/^.*-(\d+)$/, (_, n) => `replica-${n}`);
      byService.set(service, [...(byService.get(service) ?? []), c]);
    }

    for (const [service, serviceContainers] of [...byService.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const serviceId = `service:${project}:${service}`;
      const serviceRunning = serviceContainers.filter((c) => c.state === "running").length;
      const unhealthy = serviceContainers.some((c) => c.health === "unhealthy" || c.state === "restarting");
      if (serviceRunning === 0) {
        add({
          id: serviceId,
          kind: "service",
          label: service,
          subtitle: serviceContainers[0].image,
          status: unhealthy ? "degraded" : serviceRunning === 0 ? "down" : "up",
          parentId: projectId,
          badge: `${serviceContainers.length} replica${serviceContainers.length > 1 ? "s" : ""}`,
          metrics: {
            cpu: +serviceContainers.reduce((s, c) => s + c.cpuPercent, 0).toFixed(1),
            mem: +serviceContainers.reduce((s, c) => s + c.memUsageMb, 0).toFixed(0),
            net: +serviceContainers.reduce((s, c) => s + c.netRxMb + c.netTxMb, 0).toFixed(1),
          },
          detail: {
            project,
            service,
            replicas: serviceContainers.length,
            image: serviceContainers[0].image,
            ports: serviceContainers.flatMap((c) => c.ports.map((p) => `${p.host ?? "-"}:${p.container}/${p.protocol}`)),
            health: serviceContainers[0].health,
          },
        });
      } else {
        add({
        id: serviceId,
        kind: "service_active",
        label: service,
        subtitle: serviceContainers[0].image,
        status: unhealthy ? "degraded" : serviceRunning === 0 ? "down" : "up",
        parentId: projectId,
        badge: `${serviceContainers.length} replica${serviceContainers.length > 1 ? "s" : ""}`,
        metrics: {
          cpu: +serviceContainers.reduce((s, c) => s + c.cpuPercent, 0).toFixed(1),
          mem: +serviceContainers.reduce((s, c) => s + c.memUsageMb, 0).toFixed(0),
          net: +serviceContainers.reduce((s, c) => s + c.netRxMb + c.netTxMb, 0).toFixed(1),
        },
        detail: {
          project,
          service,
          replicas: serviceContainers.length,
          image: serviceContainers[0].image,
          ports: serviceContainers.flatMap((c) => c.ports.map((p) => `${p.host ?? "-"}:${p.container}/${p.protocol}`)),
          health: serviceContainers[0].health,
        },
      });
      }

      for (const c of serviceContainers) {
        const containerId = `container:${c.id}`;
        if (c.state === "running" || c.state === "restarting") {
          add({
            id: containerId,
            kind: "container_active",
            label: c.name,
            subtitle: `${c.image} · ${c.status}`,
            status: c.state === "running" ? "up" : c.state === "restarting" ? "degraded" : "down",
            parentId: serviceId,
            badge: c.health ? c.health : c.state,
            metrics: { cpu: c.cpuPercent, mem: c.memUsageMb, net: +(c.netRxMb + c.netTxMb).toFixed(1) },
            detail: {
              containerId: c.id,
              image: c.image,
              state: c.state,
              status: c.status,
              health: c.health,
              command: c.command,
              ports: c.ports.map((p) => `${p.host ?? "-"}:${p.container}/${p.protocol}`),
              networks: c.networks.map((n) => `${n.name} (${n.ip ?? "?"})`),
              mounts: c.mounts.map((m) => `${m.source} → ${m.target}`),
              restartCount: c.restartCount,
              exitCode: c.exitCode,
              composeProject: c.composeProject,
              composeService: c.composeService,
            },
          });
        } else {
          add({
            id: containerId,
            kind: "container",
            label: c.name,
            subtitle: `${c.image} · ${c.status}`,
            status: c.state === "running" ? "up" : c.state === "restarting" ? "degraded" : "down",
            parentId: serviceId,
            badge: c.health ? c.health : c.state,
            metrics: { cpu: c.cpuPercent, mem: c.memUsageMb, net: +(c.netRxMb + c.netTxMb).toFixed(1) },
            detail: {
              containerId: c.id,
              image: c.image,
              state: c.state,
              status: c.status,
              health: c.health,
              command: c.command,
              ports: c.ports.map((p) => `${p.host ?? "-"}:${p.container}/${p.protocol}`),
              networks: c.networks.map((n) => `${n.name} (${n.ip ?? "?"})`),
              mounts: c.mounts.map((m) => `${m.source} → ${m.target}`),
              restartCount: c.restartCount,
              exitCode: c.exitCode,
              composeProject: c.composeProject,
              composeService: c.composeService,
            },
          });
        }

        for (const net of c.networks) {
          add({
            id: `attach:${c.id}:${net.name}`,
            kind: "network",
            label: net.name,
            subtitle: net.ip ? `ip ${net.ip}` : "network attachment",
            status: "up",
            parentId: containerId,
            detail: { network: net.name, ip: net.ip, container: c.name, composeProject: c.composeProject },
          });
        }
        for (const m of c.mounts) {
          add({
            id: `mount:${c.id}:${m.target}`,
            kind: "volume",
            label: m.type === "bind" ? m.source : m.source || m.target,
            subtitle: `${m.mode ?? "rw"} → ${m.target}`,
            status: "up",
            parentId: containerId,
            detail: { type: m.type, source: m.source, target: m.target, mode: m.mode, container: c.name },
          });
        }
      }
    }
  }

  const systemId = "group:system";
  add({
    id: systemId,
    kind: "project",
    label: "engine resources",
    subtitle: "images · volumes · networks",
    status: "up",
    parentId: hostId,
    badge: `${imagesRes.images.length}i ${volumesRes.volumes.length}v ${networksRes.networks.length}n`,
    detail: { note: "Aggregated engine resources discovered on this endpoint" },
  });

  const imagesGroup = `${systemId}:images`;
  add({
    id: imagesGroup,
    kind: "service",
    label: "images",
    subtitle: `${imagesRes.images.length} local images`,
    status: "up",
    parentId: systemId,
    badge: `${imagesRes.images.reduce((s, i) => s + i.sizeMb, 0).toFixed(0)} MB`,
    detail: { kind: "images", count: imagesRes.images.length },
  });
  for (const img of imagesRes.images) {
    add({
      id: `image:${img.shortId}`,
      kind: "image",
      label: img.tags[0] ?? img.shortId,
      subtitle: `${img.sizeMb} MB · ${img.containers} containers`,
      status: "up",
      parentId: imagesGroup,
      detail: { imageId: img.id, tags: img.tags, sizeMb: img.sizeMb, containers: img.containers, createdAt: img.createdAt },
    });
  }

  const volumesGroup = `${systemId}:volumes`;
  add({
    id: volumesGroup,
    kind: "service",
    label: "volumes",
    subtitle: `${volumesRes.volumes.length} volumes`,
    status: "up",
    parentId: systemId,
    badge: `${volumesRes.volumes.length}`,
    detail: { kind: "volumes", count: volumesRes.volumes.length },
  });
  for (const vol of volumesRes.volumes) {
    add({
      id: `volume:${vol.name}`,
      kind: "volume",
      label: vol.name,
      subtitle: `${vol.driver} · ${vol.containers.length} attached`,
      status: "up",
      parentId: volumesGroup,
      detail: {
        name: vol.name,
        driver: vol.driver,
        mountpoint: vol.mountpoint,
        sizeMb: vol.sizeMb,
        containers: vol.containers.map((c) => c.name),
      },
    });
  }

  const networksGroup = `${systemId}:networks`;
  add({
    id: networksGroup,
    kind: "service",
    label: "networks",
    subtitle: `${networksRes.networks.length} networks`,
    status: "up",
    parentId: systemId,
    badge: `${networksRes.networks.length}`,
    detail: { kind: "networks", count: networksRes.networks.length },
  });
  for (const net of networksRes.networks) {
    add({
      id: `network:${net.name}`,
      kind: "network",
      label: net.name,
      subtitle: `${net.driver} · ${net.subnet ?? "no subnet"}`,
      status: "up",
      parentId: networksGroup,
      detail: {
        id: net.id,
        name: net.name,
        driver: net.driver,
        scope: net.scope,
        subnet: net.subnet,
        internal: net.internal,
        containers: net.containers.map((c) => `${c.name} (${c.ip ?? "?"})`),
        composeProject: net.labels["com.docker.compose.project"] ?? null,
      },
    });
  }

  return {
    mode: conn.mode,
    endpoint: conn.endpoint,
    rootId: hostId,
    nodes,
    edges,
    generatedAt: new Date().toISOString(),
  };
}
