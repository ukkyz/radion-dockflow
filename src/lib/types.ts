export type DockerMode = "live" | "demo";

export interface DockerEndpoint {
  id: string;
  name: string;
  kind: "unix" | "tcp" | "npipe";
  address: string;
  isDefault: boolean;
  status: "online" | "offline" | "unknown";
}

export interface PortMapping {
  host: number | null;
  container: number;
  protocol: string;
  hostIp?: string;
}

export interface MountInfo {
  type: string;
  source: string;
  target: string;
  mode?: string;
  sizeMb?: number;
}

export interface NetAttachment {
  name: string;
  id?: string;
  ip?: string;
  aliases?: string[];
}

export interface ContainerInfo {
  id: string;
  shortId: string;
  name: string;
  image: string;
  imageId: string;
  command: string;
  platform: string;
  state: "running" | "exited" | "created" | "paused" | "restarting" | "dead" | string;
  status: string;
  health: "healthy" | "unhealthy" | "starting" | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  restartCount: number;
  exitCode: number | null;
  labels: Record<string, string>;
  composeProject: string | null;
  composeService: string | null;
  ports: PortMapping[];
  networks: NetAttachment[];
  mounts: MountInfo[];
  cpuPercent: number;
  memUsageMb: number;
  memLimitMb: number;
  memPercent: number;
  netRxMb: number;
  netTxMb: number;
  blockReadMb: number;
  blockWriteMb: number;
  pids: number;
}

export interface ImageInfo {
  id: string;
  shortId: string;
  tags: string[];
  sizeMb: number;
  createdAt: string;
  containers: number;
  labels: Record<string, string>;
}

export interface VolumeInfo {
  name: string;
  driver: string;
  mountpoint: string;
  createdAt: string;
  containers: { id: string; name: string }[];
  sizeMb: number;
}

export interface NetworkInfo {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  attachable: boolean;
  subnet: string | null;
  containers: { id: string; name: string; ip?: string }[];
  labels: Record<string, string>;
}

export interface EngineInfo {
  serverVersion: string;
  apiVersion: string;
  os: string;
  arch: string;
  kernelVersion: string;
  cpus: number;
  totalMemoryMb: number;
  driver: string;
  runtime: string;
  name: string;
  warnings: string[];
}

export interface DockerOverview {
  mode: DockerMode;
  endpoint: DockerEndpoint;
  error: string | null;
  engine: EngineInfo;
  counts: {
    containers: number;
    running: number;
    paused: number;
    stopped: number;
    unhealthy: number;
    images: number;
    volumes: number;
    networks: number;
    totalCpuPercent: number;
    totalMemMb: number;
    memLimitMb: number;
    diskImagesMb: number;
  };
  updatedAt: string;
}

export type GraphNodeKind =
  | "host"
  | "project"
  | "service"
  | "service_active"
  | "container"
  | "container_active"
  | "volume"
  | "network"
  | "image";

export interface HierarchyNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  subtitle?: string;
  status?: string;
  parentId: string | null;
  detail?: Record<string, unknown>;
  metrics?: { cpu: number; mem: number; net: number };
  badge?: string;
}

export interface HierarchyPayload {
  mode: DockerMode;
  endpoint: DockerEndpoint;
  rootId: string;
  nodes: HierarchyNode[];
  edges: { id: string; source: string; target: string }[];
  generatedAt: string;
}

export interface ContainerStats {
  id: string;
  cpuPercent: number;
  memUsageMb: number;
  memLimitMb: number;
  memPercent: number;
  netRxMb: number;
  netTxMb: number;
  blockReadMb: number;
  blockWriteMb: number;
  pids: number;
  history: { ts: string; cpu: number; mem: number; net: number }[];
}

export type ApmServiceKind = "service" | "db" | "cache" | "queue" | "external" | "gateway";

export interface ApmNode {
  key: string;
  name: string;
  kind: ApmServiceKind;
  runtime: string;
  team: string;
  status: "up" | "warn" | "down" | "unknown";
  mode: DockerMode;
  containerId: string | null;
  containerName: string | null;
  project: string | null;
  replicas: number;
  cpu: number;
  mem: number;
  requests: number;
  errors: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  errorRate: number;
  apdex: number;
  slaLatencyMs: number;
  slaErrorPct: number;
  incoming: number;
  outgoing: number;
  agent: { name: string; version: string; lastHeartbeatAt: string } | null;
  tags: string[];
}

export interface ApmLink {
  id: string;
  source: string;
  target: string;
  protocol: string;
  calls: number;
  errors: number;
  avgMs: number;
  maxMs: number;
  errorRate: number;
  async: boolean;
}

export interface ApmTimeseriesPoint {
  ts: string;
  requests: number;
  errors: number;
  avgMs: number;
}

export interface ApmTopology {
  mode: DockerMode;
  generatedAt: string;
  nodes: ApmNode[];
  links: ApmLink[];
  timeseries: ApmTimeseriesPoint[];
  totals: {
    services: number;
    unhealthy: number;
    callsPerMin: number;
    errorRate: number;
    avgMs: number;
    p95Ms: number;
    apdex: number;
    agents: number;
    tracesPerMin: number;
  };
}

export interface ApmSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  serviceKey: string;
  serviceName: string;
  operation: string;
  kind: string;
  startTime: string;
  durationMs: number;
  status: "ok" | "error" | string;
  errorMessage: string | null;
  tags: Record<string, unknown>;
}

export interface ApmTrace {
  traceId: string;
  rootService: string;
  rootServiceName: string;
  operation: string;
  startTime: string;
  durationMs: number;
  status: "ok" | "error" | string;
  spanCount: number;
  errorCount: number;
  spans: ApmSpan[];
}

export interface CliToolRecord {
  id: string;
  name: string;
  description: string;
  binary: string;
  baseArgs: string;
  cwd: string;
  envVars: Record<string, string>;
  category: string;
  favorite: boolean;
  createdAt: string;
}

export interface CliRunResult {
  command: string;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/* ------------------------------------------------------------------ */
/* Java / JVM monitoring (jvisualvm-style)                             */
/* ------------------------------------------------------------------ */

export type JvmTargetKind = "jolokia" | "actuator" | "simulated";

export interface JvmTarget {
  id: string;
  name: string;
  kind: JvmTargetKind;
  url: string;
  host: string;
  app: string;
  containerId: string | null;
  project: string | null;
  autoDiscovered: boolean;
  status: "online" | "offline" | "simulated" | "unknown";
  jvmVersion: string | null;
  javaVendor: string | null;
  lastError: string | null;
  lastSeenAt: string | null;
  source: "manual" | "engine";
  createdAt: string;
}

export interface JvmMemoryPool {
  name: string;
  type: "heap" | "nonheap";
  usedMb: number;
  committedMb: number;
  maxMb: number;
  usagePct: number;
}

export interface JvmGcCollector {
  name: string;
  count: number;
  timeMs: number;
  avgPauseMs: number;
  poolNames: string[];
}

export interface JvmGcEvent {
  at: string;
  kind: "young" | "mixed" | "old" | "meta";
  cause: string;
  pauseMs: number;
  reclaimedMb: number;
}

export interface JvmHistoryPoint {
  ts: string;
  heapUsedMb: number;
  heapCommittedMb: number;
  nonHeapMb: number;
  metaspaceMb: number;
  edenMb: number;
  survivorMb: number;
  oldMb: number;
  threadsLive: number;
  cpuProcess: number;
  classesLoaded: number;
  gcCount: number;
  gcTimeMs: number;
}

export interface JvmFrame {
  className: string;
  methodName: string;
  fileName?: string;
  line?: number;
}

export interface JvmThread {
  id: number;
  name: string;
  state: string;
  daemon: boolean;
  priority: number;
  cpuMs: number;
  blockedCount: number;
  waitedCount: number;
  lockName?: string;
  lockOwnerName?: string;
  lockOwnerId?: number;
  waitsOn?: string;
  pool: string;
  frames: JvmFrame[];
}

export interface JvmDeadlock {
  description: string;
  threads: { id: number; name: string; state: string; holds?: string; waitsFor?: string }[];
}

export interface JvmSnapshot {
  target: JvmTarget;
  jvm: {
    version: string;
    vendor: string;
    name: string;
    specVersion: string;
    uptimeMs: number;
    startTime: string;
    pid: number;
    hostname: string;
    osName: string;
    osArch: string;
    cpus: number;
    gcCollector: string;
    args: string[];
    classPath: string;
    systemProperties: Record<string, string>;
  };
  memory: {
    heap: { usedMb: number; committedMb: number; maxMb: number; usagePct: number };
    nonHeap: { usedMb: number; committedMb: number; maxMb: number; usagePct: number };
    pools: JvmMemoryPool[];
  };
  gc: {
    collectors: JvmGcCollector[];
    totalCount: number;
    totalTimeMs: number;
    youngCount: number;
    oldCount: number;
    avgPauseMs: number;
    lastEvent: JvmGcEvent | null;
  };
  threads: { live: number; daemon: number; peak: number; started: number; blocked: number; waiting: number; deadlocked: number };
  classes: { loaded: number; unloaded: number; total: number };
  cpu: { processLoad: number; systemLoad: number; loadAverage: number; processCpuTimeMs: number; availableProcessors: number };
  buffers: { name: string; usedMb: number; capacityMb: number; count: number }[];
  history: JvmHistoryPoint[];
  gcEvents: JvmGcEvent[];
  sampledAt: string;
}

export interface JvmThreadResponse {
  target: JvmTarget;
  threads: JvmThread[];
  deadlocks: JvmDeadlock[];
  summary: { total: number; runnable: number; waiting: number; blocked: number; timedWaiting: number; daemon: number; deadlocked: number };
  capturedAt: string;
}

export interface JvmMethodNode {
  id: string;
  className: string;
  methodName: string;
  selfMs: number;
  totalMs: number;
  selfPct: number;
  totalPct: number;
  samples: number;
  depth: number;
  children: JvmMethodNode[];
}

export interface JvmHotMethod {
  className: string;
  methodName: string;
  selfMs: number;
  totalMs: number;
  selfPct: number;
  totalPct: number;
  samples: number;
}

export interface JvmAllocation {
  className: string;
  instances: number;
  bytesMb: number;
  pct: number;
}

export interface JvmProfile {
  targetId: string;
  status: "idle" | "running" | "stopped" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  /** elapsed sampling time */
  durationMs: number;
  /** configured sampling window */
  windowMs: number;
  intervalMs: number;
  samples: number;
  hotMethods: JvmHotMethod[];
  allocations: JvmAllocation[];
  callTree: JvmMethodNode | null;
  error: string | null;
  note: string | null;
}

export interface JvmMBean {
  mbean: string;
  domain: string;
  attributes: { name: string; type: string; value: string; numeric?: number }[];
  operations: { name: string; description: string }[];
}

export interface JvmDumpSummary {
  id: string;
  targetId: string;
  targetName: string;
  kind: "thread" | "heap" | "profile";
  sizeKb: number;
  path: string | null;
  summary: Record<string, unknown>;
  createdAt: string;
}
