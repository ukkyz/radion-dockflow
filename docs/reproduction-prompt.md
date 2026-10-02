# DockFlow Console — reproduction prompt

Copy everything inside the fenced block into any capable coding agent (Claude Code, GPT-5.x/Codex, Gemini CLI, Cursor, Devin, another DeepSeek run, …).
It is written to be **self-contained, environment-aware and revalidatable**, so outputs from different models can be compared against the same acceptance tests.

---

```text
ROLE
You are a senior fullstack engineer shipping a production-quality internal tool in a single session.
Do not ask clarifying questions. Make best-judgment decisions, keep going until every acceptance test passes,
and reply only with: (a) a short summary of what you built, (b) the exact commands you ran, (c) their results.

MISSION
Build "DockFlow Console": one web app that merges Docker Desktop, a workflow automation builder, and a
Pinpoint/Jaeger-style APM service map — where every graph is a @xyflow/react canvas whose nodes form a
parent/child hierarchy with expand/collapse, and where the app can also drive any locally installed CLI
application. Assume a fresh Next.js (App Router) + TypeScript project with Tailwind already wired.

HARD ENVIRONMENT CONSTRAINTS (assume all of these are true)
1. There is NO Docker daemon reachable from the sandbox. Your app must still be 100% functional there.
2. Several env vars may be PRESENT BUT EMPTY (e.g. DOCKER_SOCKET="", DOCKER_HOST="", DATABASE_URL=="").
   Treat blank as unset everywhere (write an envOr(key, fallback) helper). `??` is NOT enough.
3. No authentication. This is a single-operator localhost console. Do not add login, users, or RBAC.
4. You may not run `next start` in the background as your final validation step; use the platform's
   build/start tool. Kill any server you started for smoke tests before finishing.

STORAGE — SQLite (file based, no external service)
- Use better-sqlite3 + drizzle-orm/better-sqlite3. Add better-sqlite3 to serverExternalPackages in
  next.config.ts (native addon: Turbopack will otherwise fail the build).
- Tables (TEXT uuid4 PKs via randomUUID(), INTEGER unix-seconds for timestamps with { mode: "timestamp" },
  TEXT with { mode: "json" } for JSON, INTEGER { mode: "boolean" } for booleans, AUTOINCREMENT INTEGER for
  span/edge rows): docker_hosts, cli_tools, workflows, workflow_runs, apm_services, apm_agents, apm_spans,
  apm_edges. Add unique indexes: docker_hosts.address, apm_services.key, apm_agents(name, service_key),
  apm_edges(source_key, target_key, protocol). Index apm_spans by (trace_id) and (service_key, start_time).
- Zero-step bootstrap: on first DB access, run idempotent `CREATE TABLE/INDEX IF NOT EXISTS` DDL and set
  journal_mode=WAL. A deleted DB file must recreate itself on the next request. Keep drizzle.config.json
  (dialect sqlite) in sync so `npx drizzle-kit push` produces the identical shape.
- Store the file at data/dockflow.db (auto-create the directory), overridable via SQLITE_PATH.
- Dialect care: no `now() - interval`, no `greatest()` (use SQLite's scalar `max()`), health probe uses
  raw `sqlite.prepare("select 1")`, and inserts/updates that need values use `.returning()`.
- If a platform truly injects only a managed Postgres URL and forbids file writes, mirror the same schema
  there and note each dialect substitution — but SQLite is the required default.

ENGINE CONNECTIVITY (Docker Desktop parity)
- Talk to the Docker Engine API directly with dockerode. Support unix://, tcp://host:port and npipe
  endpoints. Keep an endpoint registry in docker_hosts; the UI can add/switch/remove endpoints and
  "reconnect" (force re-probe).
- Probe order: default endpoint first, then the rest. For each: skip missing unix sockets, docker.ping()
  with a 2.5s timeout, then version()+info() in parallel. Cache the result 15s. Invalidate the endpoint +
  probe caches whenever endpoints are written or seeded (otherwise a stale in-memory list hides new hosts).
- Normalise engine data into ONE internal shape (ContainerInfo, ImageInfo, VolumeInfo, NetworkInfo,
  EngineInfo) so the UI never sees raw engine JSON. Compute CPU% from cpu_stats deltas × online_cpus,
  subtract inactive_file/cache from memory usage, sum per-interface network bytes, sum blkio read/write,
  and map Docker's string states/health into {state, health, tone}.
- Logs: the engine multiplexes stdout/stderr with 8-byte frame headers when TTY is off — demux properly
  (fall back to raw UTF-8 when the buffer is not framed). Timestamps on, tail configurable.
- Exec: create exec with AttachStdout/AttachStderr/Tty:false, start it, demux the hijacked stream with
  docker.modem.demuxStream, then read ExitCode from exec.inspect().
- Caches/TTLs: probe 15s, container inspect 4s, stats 5s. Cap concurrent inspects at ~8 (mapLimit helper).
- Actions to support: start, stop, restart, pause, unpause, kill, remove, `run` (create+start from image
  with ports/env/command), prune (images|volumes|networks|containers), and bulk per-compose-project
  start|stop|restart. Also expose image/volume/network list + remove.

DEMO ENGINE FALLBACK (first-class, not a stub)
- If no endpoint answers, serve every single feature from an in-memory simulator and label it loudly in the
  UI ("demo engine active") without hiding the real error string. The demo engine must behave like a real
  engine from the UI's perspective: actions mutate state, logs keep growing, stats keep jittering.
- Seed it realistically: 2-3 compose projects (e.g. vega-shop, observability) + 2 standalone containers;
  gateway/api/auth/catalog/orders/jobs + postgres/redis/rabbitmq + prometheus/grafana/otel-collector;
  ~14 containers, ~13 images, several volumes and networks with subnets/IPs; published host ports; compose
  labels; one container "restarting" with health unhealthy + restartCount + exit code 137 and an OOM log
  line; one exited(0) and one exited(1) container. Stats history arrays (~30 points) per container.
- Keep simulator state on globalThis so Next's dev/prod re-evaluation does not re-seed it.

FEATURE 1 — xyflow hierarchy map (page /graph)
- Nodes are NOT subflows: each node is a normal xyflow node with data.parentId, and the canvas computes
  visibility from an expanded map. Every node with children renders a "+N / −" pill button that toggles its
  children; also provide expand-all, collapse-all, fit-view, and a "X/Y nodes visible" counter.
- Hierarchy: Host → compose project → service → container → network attachments + volume mounts, plus an
  "engine resources" branch grouping images/volumes/networks. Node cards show kind glyph, title, subtitle,
  status pill, cpu/mem bars, and up to ~4 aggregation chips (mode/api/cpus/ram, replicas/cpu/mem,
  size/used-by, driver/subnet, …). Selected node opens a side drawer with all raw detail fields and
  contextual actions (project start/stop/restart, container restart/stop, open logs+stats+exec).
- Write two reusable layouts in a shared module and use synthetic (never measured) node dimensions:
  (1) layoutTree — deterministic tidy tree, children stacked vertically (xGap ≈340, yGap ≈132), parents
  centred over children; (2) layoutLayered — Sugiyama-ish: longest-path rank + 3 barycenter passes to cut
  crossings (columnGap ≈300, rowGap ≈130).
- One reusable MapCanvas component drives both /graph and /apm: props = nodes, edges, layout kind,
  defaultExpandDepth, onSelect, legend, toolbar; needs no React state churn (memoise positions/nodes).

FEATURE 2 — Docker Desktop surface (page /containers)
- Tabs: containers | images | volumes | networks. Metric strip (total/running/stopped/needs-attention/cpu
  sum/memory sum). Filters: compose project, state (running/stopped/attention), free text. Row actions
  (start/stop/restart/logs) and a "docker run" form (image, name, ports host:container, env, command).
- Right-hand detail drawer with four tabs: overview (state, restarts, cpu, memory, net, block IO, pids,
  platform, ports, networks, mounts, labels), logs (auto-refreshing tail 250), stats (sparklines), exec
  (command box + output buffer). Sparklines must be hand-rolled inline SVG (no chart library).
- / (Overview) page: engine card (endpoint, mode, version, api, host, kernel, cpus, ram, storage driver,
  runtime, warnings), busiest-containers bar list, prune buttons, per-project restart, APM snapshot,
  recent workflow runs, and a PATH scan showing which CLI binaries exist locally.

FEATURE 3 — APM service map, traces, ingestion (page /apm)
- Derive services from live containers (composeService/name → serviceKey, classify kind=runtime by image
  heuristics: gateway/db/cache/queue/external/service + runtime label), merge with the apm_services registry
  (name, team, SLA latency, SLA error %) and with telemetry-only services that arrived via ingestion.
- Span model: {traceId, spanId, parentSpanId, serviceKey, operation, kind: server|client|internal,
  startTime, durationMs, status, errorMessage, tags}. Call edges are derived by pairing a client span with
  its child server span on a different service — this is what makes the map a real call graph. Roll those
  pairs into the apm_edges rollup with an ON CONFLICT DO UPDATE upsert.
- Ingest API (documented contract, third-party agents push here):
  POST /api/apm/ingest {agent?, service?, kind?, runtime?, host?, spans:[…]} → upserts services, registers
  the agent heartbeat, inserts spans (cap a batch at 2000), rolls up edges, then prunes spans older than
  20 minutes. GET returns registered agents + the payload contract. DELETE resets telemetry.
- Synthetic traffic generator (demo-proof, writes REAL rows): start from the entry service, walk the
  derived call graph up to depth 3 with ~15% error roll and ~28% slow roll, emit client+server (+db/cache
  child) spans, call ingestSpans. Expose POST /api/apm/simulate {batch} and let the APM page drive it on a
  6s interval behind a clearly labelled toggle.
- Map views in one canvas: "call flow" (layered layout, edges labelled `calls · avgMs · n err`, coloured and
  animated when failing, width scaled by volume) and "hierarchy" (edge tier → application tier → data tier
  → service → container, expandable). Metrics per node: requests, errors, error rate, avg/p95/max, Apdex
  vs its SLA, callers/callees, agent heartbeat.
- Traces tab: filters (service, ok/error, min duration), grouped trace rows, expandable **waterfall** where
  every span is drawn as an offset/width bar against the trace's total duration, error messages surfaced
  underneath. Plus a 30-bucket requests/min chart with an error overlay and a service detail drawer with
  operations table (calls/avg/p95/errors), error signatures, and slowest spans.
- Windows: 10-minute query window for aggregates/traces, 20-minute span retention, 60-minute edge rollup.

FEATURE 4 — workflow builder + server-side runner (page /workflows)
- xyflow editor: left palette (drag onto canvas or click to append), canvas with grid background, minimap,
  controls, connect-able handles; right panel = per-step settings form generated from a node definition
  registry + a live run timeline. Save/update the graph (nodes+edges as JSON) to SQLite; support new,
  clone, delete; list run history and per-workflow runs.
- Node types (each with typed fields + declared outputs): trigger, dockerAction, dockerRun, dockerExec,
  dockerLogs, healthcheck, cli, http, delay, condition, notify. Give every type an accent colour and glyph.
- Runner semantics: trigger first, then BFS over outgoing edges; template `{{nodeId.field}}` against prior
  step outputs (support both dotted paths and a bare `{{container}}` shorthand that resolves the trigger
  payload value); skip any node whose upstream failed or whose condition branch was not taken (branch
  chosen by the edge label "true"/"false"); respect a cancel flag set by another request; persist the step
  array (status/output/duration/exitCode) after every transition so the UI can poll and paint per-step
  status onto the canvas and timeline.
- Step behaviour: docker exec runs `/bin/sh -lc <command>` and can fail on non-zero exit; healthcheck polls
  URL with retries/interval and compares status; cli spawns argv-only with cwd/env/timeout; http calls any
  API with method/body/expected status; dockerLogs can require/forbid a pattern.

FEATURE 5 — JVM monitor, jvisualvm-style (page /jvm)
- Targets: (a) Jolokia JMX-over-HTTP bridge, (b) Spring Boot Actuator base url, (c) simulated JVM.
  Auto-discover jvm-ish containers on the engine (image/command hints: java|jvm|jar|spring|tomcat|…) and list
  them as simulated targets so the page is useful with no Java installed. Probe each target and surface the
  raw connection error when it is offline.
- Snapshot API returns: jvm identity (vm name/version/vendor/uptime/pid/host/args/classpath/system properties),
  heap + non-heap usage, every memory pool (Eden/Survivor/Old/Metaspace/CodeCache with used/committed/max),
  GC collectors (count, total time, avg pause, mapped pools), thread counts (live/daemon/peak/started/
  blocked/waiting/deadlocked), class loading, CPU (process/system/load average/cpu time), NIO buffer pools,
  a rolling history ring (~90 points) and a GC event timeline.
- Jolokia integration: POST an array of {type:"read", mbean} / {type:"exec", mbean, operation, arguments}
  requests to {url}/jolokia for Memory, MemoryPool,name=*, Threading, ClassLoading, OperatingSystem, Runtime,
  GarbageCollector,name=*, java.nio:type=BufferPool,name=*. Actuator integration: GET {url}/actuator/metrics/*
  (jvm.memory.*, jvm.threads.*, jvm.classes.*, jvm.gc.pause, process.cpu.usage, process.uptime), plus
  /threaddump and /heapdump.
- Tabs: Monitor (heap/non-heap, generations, threads, cpu+classes, gc activity charts + runtime panel),
  Visual GC (region bars per pool, GC event timeline with cause/pause/reclaimed, collector summary + overhead %),
  Threads (state filter counts, name/frame search, per-thread stack pane, BLOCKED/Waiting/lock owner columns,
  bank-banner deadlock report), Sampler, MBeans, Dumps, Anatomy.
- Sampler = statistical CPU profiling by repeatedly pulling thread stacks on a server-side session
  (start/stop/save/status, configurable window + interval, interval work guarded against overlap). Percentages
  are relative to observed thread stacks (not ticks). Output: hot methods (self%), allocation profile per class,
  and a call tree rendered as an expandable @xyflow/react tree (expand/collapse per frame).
- Deadlock detection: build a wait-for graph from lockName/waitsOn/lockOwnerId and report cycles.
- MBeans browser: domain → mbean list → attribute table (refreshable), plus a curated operation list
  (run GC, reset peak thread count, clear app cache, reset rate limiter, dump all threads).
- Dumps: capture thread dumps (rendered in the classic `"thread-name" daemon prio=… Id=… STATE` text format,
  including lock lines and the deadlock banner), heap dumps (HotSpotDiagnostic.dumpHeap for Jolokia, streaming
  /actuator/heapdump to disk for Actuator, simulated hprof + retained-size histogram otherwise) and saved
  profiler snapshots. Persist them (kind, size, path, summary json, content) and provide a viewer + delete.
- Anatomy tab: the JVM internals as an expandable xyflow hierarchy — JVM → memory (heap → each pool /
  non-heap → each pool), GC → collectors, threads → thread pools → up to 14 threads each, classes, CPU — with
  utilisation bars and aggregation chips.

FEATURE 6 — CLI console (page /cli)
- Saved command library in cli_tools (name, binary, baseArgs, cwd, env, category, favourite) grouped by
  category, star/unstar, delete, run, "edit args". Ad-hoc runner with binary/args/cwd/env/timeout, quick
  presets (docker ps, compose ls, system df, images, context ls, node -v, git status, curl health), exit
  code badge, duration, truncation flag, output terminal and session history. Left/right columns list
  detected binaries with their `--version` line.
- Execution hygiene: spawn with shell:false and an argv array (never string-concatenate user input), a
  quote-aware argv tokenizer for the args text field, cwd/env passthrough, default 30s timeout (max 120s)
  killed with SIGKILL, output byte budget with a `truncated` flag, and a deny-list for destructive patterns
  (mkfs, format, shutdown/reboot, dd to a block device, fork bombs, rm -rf /). Binary detection must first
  try `--version` and treat ENOENT/"not found on PATH" as NOT INSTALLED (a failed spawn still prints
  something — do not mistake that for availability).

API SURFACE (exact paths)
/api/health
/api/docker/connection (GET probe+endpoints, POST add endpoint, DELETE ?id)
/api/docker/overview | /graph | /containers (GET, POST run) | /containers/[id] (GET, POST action, DELETE)
/api/docker/containers/[id]/{logs,stats,exec} | /images | /volumes | /networks | /prune | /projects
/api/workflows | /workflows/[id] (GET, PUT, DELETE) | /workflows/[id]/run (POST)
/api/runs | /runs/[id] (GET, POST cancel)
/api/cli-tools (GET, POST, PATCH, DELETE) | /cli/run (GET ?detect=1, POST)
/api/apm/topology | /traces | /traces/[traceId] | /services/[key] | /simulate | /ingest
/api/jvm/targets (GET/POST/DELETE) | /jvm/[id]/snapshot | /[id]/threads | /[id]/profile (GET/POST
start|stop|status|save) | /[id]/mbeans (?mbean=) | /[id]/operation | /[id]/dumps (GET/POST) | /jvm/dumps/[id]
Every JSON response uses one envelope {ok, data, at} or {ok:false, error} with sane status codes; add a
`guard()` helper so any thrown error becomes a clean 4xx/5xx instead of an unhandled rejection.

UI / UX SYSTEM
- Tailwind v4 utilities only (globals.css holds the theme + xyflow variable overrides). Dark "cockpit"
  theme: slate-950 canvas, panel cards with 1px slate-800 borders, uppercase 10px micro-labels, monospace
  for ids/values. Central tone map (good/warn/bad/idle/info → dot+text+bg+border classes) reused everywhere.
- Persistent header with nav, a connection pill (live green vs demo amber, showing engine version +
  endpoint), reconnect, and an expandable endpoint manager. Footer shows health + storage status.
- Client data layer: SWR via one `useApi<T>(url, refreshMs)` hook + apiPost/apiPut/apiDelete helpers that
  unwrap the envelope; per-page refresh intervals (graph 8s, containers 6s, apm 6-7s, runs 4s).

GOTCHAS YOU MUST HANDLE (each one bites otherwise)
- Turbopack build error "non-ecmascript placeable asset" from ssh2/cpu-features via dockerode → put them
  in serverExternalPackages, and never use bare `require()` inside ESM (import node:stream properly).
- Docker log frames must be demuxed or the UI shows binary garbage.
- Endpoint/probe caches must be invalidated on writes and after seeding.
- Blank env vars: treat "" as missing, and make seeding idempotent + per-block fault isolated so one
  UNIQUE violation cannot silently skip seeding everything (log the reason and retry later).
- drizzle JSON/timestamp columns: rely on { mode: "json" } / { mode: "timestamp" } so objects and Dates
  round-trip; never stringify manually.
- Cap work: inspect concurrency 8, span insert batch 2000, map span queries to a 6000-row limit, prune on
  write, keep the client polling intervals modest.

ACCEPTANCE TESTS (run them, then paste the real output)
1. `npx next typegen` → success; `npx tsc --noEmit --pretty false` → zero errors; `npm run build` → success.
2. Delete the SQLite file, start the app, then GET /api/health → status healthy, databaseEngine sqlite,
   `sqlite.tables` = 8+ tables created with no manual migration step, and engine.mode = demo with the
   raw connection error preserved.
3. curl /api/docker/overview, /api/docker/graph, /api/docker/containers → containers > 0, hierarchy nodes
   > 50 with parent/child ids, no 500s.
4. POST /api/docker/containers/<id> {action: "restart"} → ok, and the detail reflects it; GET logs returns
   text; POST exec returns output + exitCode; GET stats returns a history array.
5. POST a workflow, POST /api/workflows/<id>/run, then GET /api/runs/<id> until it finishes → steps resolve
   with per-step output, showing `{{...}}` templating and any skipped branch.
6. POST /api/apm/ingest with two linked spans (client + child server) → inserted/services/traces counts,
   GET /api/apm/traces?service=<key> shows the trace, GET /api/apm/topology shows a link between the two
   services and non-zero p95/error metrics. POST /api/apm/simulate {batch:2} → more spans.
7. JVM: GET /api/jvm/targets → targets (engine-discovered java containers included); GET
   /api/jvm/<id>/snapshot → history points > 0 and gcEvents > 0; GET /api/jvm/<id>/threads → deadlocks array
   with a 2-thread cycle and a BLOCKED/waits-for chain; POST /api/jvm/<id>/profile {action:"start"} then poll →
   samples grow, hot methods sorted by self% summing < 100, call tree present; POST {action:"save"} → dump row;
   POST /api/jvm/<id>/dumps {kind:"thread"} → classic thread-dump text; POST /api/jvm/<id>/operation {operation:"gc"}.
8. POST /api/cli/run {binary:"node", args:["-v"]} → exitCode 0 and stdout captured; GET /api/cli/run?detect=1
   marks missing binaries as null (not as "spawn … ENOENT" strings).
9. GET /, /graph, /containers, /apm, /jvm, /workflows, /cli → HTTP 200, no "Internal Server Error" text, and the
   server log is free of warnings/exceptions.
10. Finish with the platform build/start + healthcheck tool; confirm both the built app and /api/health
   respond. Do not leave a manually started server running.

DEFINITION OF DONE
Production build passes, the file-based DB bootstraps itself from nothing, every page works with no Docker
daemon (clearly labelled demo mode) and switches to live mode when an endpoint answers, all three graph
canvases expand/collapse per node, workflows actually execute real engine/CLI/HTTP steps with persisted
runs, and telemetry can be pushed by an external agent or generated synthetically. Ship it without asking
further questions.
```

---

## How to use this for cross-model comparison

Run the same prompt, then score each output:

| # | Check | Pass signal |
|---|-------|-------------|
| 1 | Build + typecheck + start | `tsc` clean, `next build` clean, healthcheck OK |
| 2 | Zero-step DB bootstrap | deletes DB file → auto-recreates 8 tables, seeds data |
| 3 | Demo engine, not a stub | actions/logs/stats mutate with no daemon; demo mode labelled |
| 4 | xyflow parent/child expand/collapse | per-node `+N/−` toggle on ≥3 levels of hierarchy |
| 5 | Real call graph from spans | client-span + child-span pairing produces map edges |
| 6 | Ingestion contract | `POST /api/apm/ingest` with the documented payload adds spans/traces |
| 7 | Waterfall traces | offsets/widths proportional to a trace's total duration |
| 8 | Workflow execution | templating + condition branch + skip propagation observed in run steps |
| 9 | CLI hygiene | argv-only spawn, argv tokenizer, deny-list, ENOENT → "not installed" |
| 11 | JVM monitor | real Jolokia/Actuator paths + deadlock detection + sampling call tree |
| 10 | Gotcha handling | blank env vars, cache invalidation, log demux, `serverExternalPackages` |

Prompts that produce a *demo-looking* app usually fail #3, #5 and #10 — those three rows are the highest-signal checks.
