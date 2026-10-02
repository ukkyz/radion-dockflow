import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

/** Shared shape for every config visualizer (compose, terraform, github). */
export interface ConfigNode {
  id: string;
  title: string;
  subtitle?: string;
  kind: string;
  parentId: string | null;
  status: string;
  badge?: string;
  accent?: string;
  agg?: { label: string; value: string; tone?: string }[];
  meta?: string[];
  detail?: Record<string, unknown>;
}

export interface ConfigEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  tone?: string;
  animated?: boolean;
}

export interface ConfigFinding {
  level: "error" | "warn" | "info";
  message: string;
  path?: string;
}

export interface ComposeModel {
  kind: "compose";
  file: string;
  projectName: string;
  nodes: ConfigNode[];
  edges: ConfigEdge[];
  findings: ConfigFinding[];
  stats: {
    services: number;
    buildableServices: number;
    publishedPorts: number;
    namedVolumes: number;
    bindMounts: number;
    networks: number;
    deployReplicas: number;
    healthchecked: number;
    profiles: string[];
    images: number;
  };
  services: ComposeService[];
  networks: { name: string; driver: string; internal: boolean; usedBy: string[] }[];
  volumes: { name: string; usedBy: string[]; external: boolean }[];
}

export interface ComposeService {
  name: string;
  image: string | null;
  build: { context: string; dockerfile?: string; target?: string; args: number } | null;
  containerName: string | null;
  command: string[];
  entrypoint: string[];
  ports: { published: string; target: string; protocol: string; mode?: string }[];
  environment: { key: string; value: string; interpolated: boolean }[];
  envFiles: string[];
  volumes: { source: string; target: string; mode?: string; type: "volume" | "bind" | "tmpfs" }[];
  networks: { name: string; aliases: string[]; ipv4?: string }[];
  dependsOn: { name: string; condition?: string; restart?: boolean }[];
  healthcheck: { test: string[]; interval?: string; timeout?: string; retries?: number; startPeriod?: string } | null;
  restart: string | null;
  deploy: { replicas?: number; cpus?: string; memory?: string; reservationsCpus?: string; reservationsMemory?: string } | null;
  profiles: string[];
  secrets: string[];
  configs: string[];
  user: string | null;
  logging: string | null;
  extraHosts: string[];
  sysctls: string[];
  capabilities: { add: string[]; drop: string[] };
}

const ROOT_ID = "compose:project";

function asArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  return [String(value)];
}

function humanSize(value: unknown): string | undefined {
  if (typeof value === "number") return `${value} bytes`;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value.replace(/[a-zA-Z]+$/, ""));
    if (Number.isFinite(numeric) && /^\d+(\.\d+)?[bkmgBKMG]?$/.test(value.trim())) {
      const unit = value.trim().replace(/[\d.]/g, "").toLowerCase();
      const mb = unit === "g" ? numeric * 1024 : unit === "k" ? numeric / 1024 : unit === "b" ? numeric / 1_048_576 : numeric;
      return `${mb >= 1024 ? `${(mb / 1024).toFixed(1)} GiB` : `${mb.toFixed(0)} MiB`}`;
    }
    return value;
  }
  return undefined;
}

function parseDurationSeconds(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(String(value).trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const factor = unit === "ms" ? 0.001 : unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return +(amount * factor).toFixed(3);
}

function parseComposeService(name: string, raw: Record<string, unknown>): ComposeService {
  const build = raw.build
    ? typeof raw.build === "string"
      ? { context: raw.build, dockerfile: undefined as string | undefined, target: undefined as string | undefined, args: 0 }
      : {
          context: String((raw.build as Record<string, unknown>).context ?? "."),
          dockerfile: (raw.build as Record<string, unknown>).dockerfile ? String((raw.build as Record<string, unknown>).dockerfile) : undefined,
          target: (raw.build as Record<string, unknown>).target ? String((raw.build as Record<string, unknown>).target) : undefined,
          args: Object.keys(((raw.build as Record<string, unknown>).args ?? {}) as Record<string, unknown>).length,
        }
    : null;

  const ports = asArray(raw.ports).map((entry) => {
    // "127.0.0.1:8080:80/tcp", "8080:80", "80", "8080-8090:80-90"
    const [spec, protocol = "tcp"] = String(entry).split("/");
    const parts = spec.split(":");
    if (parts.length === 1) return { published: "", target: parts[0], protocol, mode: undefined as string | undefined };
    if (parts.length === 2) return { published: parts[0], target: parts[1], protocol, mode: undefined };
    return { published: parts[1], target: parts[2], protocol, mode: parts[0] };
  });

  const environment: ComposeService["environment"] = [];
  if (Array.isArray(raw.environment)) {
    for (const entry of raw.environment) {
      const text = String(entry);
      const index = text.indexOf("=");
      if (index === -1) environment.push({ key: text, value: "", interpolated: false });
      else environment.push({ key: text.slice(0, index), value: text.slice(index + 1), interpolated: /\$\{/.test(text) });
    }
  } else if (raw.environment && typeof raw.environment === "object") {
    for (const [key, value] of Object.entries(raw.environment as Record<string, unknown>)) {
      const text = value === null || value === undefined ? "" : String(value);
      environment.push({ key, value: text, interpolated: /\$\{/.test(text) });
    }
  }

  const volumes: ComposeService["volumes"] = [];
  for (const entry of (Array.isArray(raw.volumes) ? raw.volumes : []) as unknown[]) {
    if (typeof entry === "string") {
      const [source, target, mode] = entry.split(":");
      const isBind = source.startsWith(".") || source.startsWith("/") || source.startsWith("~");
      volumes.push({ source, target: target ?? "", mode, type: isBind ? "bind" : "volume" });
    } else if (entry && typeof entry === "object") {
      const value = entry as Record<string, unknown>;
      const type = String(value.type ?? (value.source ? (String(value.source).startsWith("/") || String(value.source).startsWith(".") ? "bind" : "volume") : "volume"));
      volumes.push({
        source: String(value.source ?? ""),
        target: String(value.target ?? ""),
        mode: value.read_only ? "ro" : undefined,
        type: type === "bind" ? "bind" : type === "tmpfs" ? "tmpfs" : "volume",
      });
    }
  }

  const networks: ComposeService["networks"] = [];
  if (Array.isArray(raw.networks)) {
    for (const entry of raw.networks) networks.push({ name: String(entry), aliases: [] });
  } else if (raw.networks && typeof raw.networks === "object") {
    for (const [key, value] of Object.entries(raw.networks as Record<string, unknown>)) {
      const config = (value ?? {}) as Record<string, unknown>;
      networks.push({
        name: String(config.name ?? key),
        aliases: asArray(config.aliases),
        ipv4: config.ipv4_address ? String(config.ipv4_address) : undefined,
      });
    }
  }

  const dependsOn: ComposeService["dependsOn"] = [];
  if (Array.isArray(raw.depends_on)) {
    for (const entry of raw.depends_on) dependsOn.push({ name: String(entry) });
  } else if (raw.depends_on && typeof raw.depends_on === "object") {
    for (const [key, value] of Object.entries(raw.depends_on as Record<string, unknown>)) {
      const config = (value ?? {}) as Record<string, unknown>;
      dependsOn.push({
        name: key,
        condition: config.condition ? String(config.condition) : undefined,
        restart: typeof config.restart === "boolean" ? config.restart : undefined,
      });
    }
  }

  const healthcheckRaw = (raw.healthcheck ?? null) as Record<string, unknown> | null;
  const healthcheck = healthcheckRaw
    ? {
        test: Array.isArray(healthcheckRaw.test) ? (healthcheckRaw.test as unknown[]).map(String) : [String(healthcheckRaw.test ?? "")].filter(Boolean),
        interval: healthcheckRaw.interval ? String(healthcheckRaw.interval) : undefined,
        timeout: healthcheckRaw.timeout ? String(healthcheckRaw.timeout) : undefined,
        retries: healthcheckRaw.retries !== undefined ? Number(healthcheckRaw.retries) : undefined,
        startPeriod: healthcheckRaw.start_period ? String(healthcheckRaw.start_period) : undefined,
      }
    : null;

  const deployRaw = (raw.deploy ?? null) as Record<string, unknown> | null;
  const limits = ((deployRaw?.resources ?? {}) as Record<string, unknown>).limits as Record<string, unknown> | undefined;
  const reservations = ((deployRaw?.resources ?? {}) as Record<string, unknown>).reservations as Record<string, unknown> | undefined;
  const deploy = deployRaw
    ? {
        replicas: deployRaw.replicas !== undefined ? Number(deployRaw.replicas) : undefined,
        cpus: limits?.cpus !== undefined ? String(limits.cpus) : undefined,
        memory: limits?.memory !== undefined ? String(limits.memory) : undefined,
        reservationsCpus: reservations?.cpus !== undefined ? String(reservations.cpus) : undefined,
        reservationsMemory: reservations?.memory !== undefined ? String(reservations.memory) : undefined,
      }
    : null;

  const loggingRaw = raw.logging;
  const capabilities = (raw.cap_add || raw.cap_drop ? { add: asArray(raw.cap_add), drop: asArray(raw.cap_drop) } : { add: [], drop: [] });

  return {
    name,
    image: raw.image ? String(raw.image) : null,
    build,
    containerName: raw.container_name ? String(raw.container_name) : null,
    command: Array.isArray(raw.command) ? (raw.command as unknown[]).map(String) : raw.command ? [String(raw.command)] : [],
    entrypoint: Array.isArray(raw.entrypoint) ? (raw.entrypoint as unknown[]).map(String) : raw.entrypoint ? [String(raw.entrypoint)] : [],
    ports,
    environment,
    envFiles: asArray(raw.env_file),
    volumes,
    networks,
    dependsOn,
    healthcheck,
    restart: raw.restart ? String(raw.restart) : null,
    deploy,
    profiles: asArray(raw.profiles),
    secrets: asArray(raw.secrets).map((entry) => (entry.includes("=") ? entry.split("=")[0] : entry)),
    configs: asArray(raw.configs).map((entry) => (entry.includes("=") ? entry.split("=")[0] : entry)),
    user: raw.user ? String(raw.user) : null,
    logging: loggingRaw && typeof loggingRaw === "object" ? String((loggingRaw as Record<string, unknown>).driver ?? "default") : null,
    extraHosts: asArray(raw.extra_hosts),
    sysctls: Object.keys(((raw.sysctls ?? {}) as Record<string, unknown>) ?? {}).map((key) => `${key}=${String((raw.sysctls as Record<string, unknown>)[key])}`),
    capabilities,
  };
}

export function parseCompose(content: string, file = "docker-compose.yml"): ComposeModel {
  const findings: ConfigFinding[] = [];
  let doc: Record<string, unknown>;
  try {
    doc = (YAML.parse(content) ?? {}) as Record<string, unknown>;
  } catch (error) {
    return {
      kind: "compose",
      file,
      projectName: "invalid",
      nodes: [],
      edges: [],
      findings: [{ level: "error", message: `YAML parse error: ${error instanceof Error ? error.message : String(error)}` }],
      stats: { services: 0, buildableServices: 0, publishedPorts: 0, namedVolumes: 0, bindMounts: 0, networks: 0, deployReplicas: 0, healthchecked: 0, profiles: [], images: 0 },
      services: [],
      networks: [],
      volumes: [],
    };
  }

  if (doc.version && String(doc.version) !== "3" && String(doc.version) !== "2") {
    findings.push({ level: "info", message: `compose file format ${String(doc.version)} — modern docker compose ignores the top-level version key` });
  }
  if (doc.version === undefined) findings.push({ level: "info", message: "no top-level version key (correct for modern docker compose)" });

  const rawServices = (doc.services ?? {}) as Record<string, Record<string, unknown>>;
  const services = Object.entries(rawServices).map(([name, raw]) => parseComposeService(name, raw ?? {}));
  const byName = new Map(services.map((service) => [service.name, service]));
  const projectName = String(doc.name ?? (path.basename(path.dirname(file)) || "compose"));

  const rawNetworks = (doc.networks ?? {}) as Record<string, unknown>;
  const networkNames = new Set<string>([...Object.keys(rawNetworks), ...services.flatMap((service) => service.networks.map((net) => net.name))]);
  const networks = [...networkNames].map((name) => {
    const config = (rawNetworks[name] ?? {}) as Record<string, unknown>;
    return {
      name,
      driver: String(config.driver ?? "bridge"),
      internal: Boolean(config.internal),
      usedBy: services.filter((service) => service.networks.some((net) => net.name === name)).map((service) => service.name),
    };
  });

  const rawVolumes = (doc.volumes ?? {}) as Record<string, unknown>;
  const volumeNames = new Set<string>([
    ...Object.keys(rawVolumes),
    ...services.flatMap((service) => service.volumes.filter((volume) => volume.type === "volume").map((volume) => volume.source)),
  ]);
  const volumes = [...volumeNames].map((name) => {
    const config = (rawVolumes[name] ?? {}) as Record<string, unknown>;
    return {
      name,
      external: Boolean(config.external),
      usedBy: services.filter((service) => service.volumes.some((volume) => volume.source === name)).map((service) => service.name),
    };
  });

  /* ---------------- graph ---------------- */
  const nodes: ConfigNode[] = [];
  const edges: ConfigEdge[] = [];

  const totalReplicas = services.reduce((sum, service) => sum + (service.deploy?.replicas ?? 1), 0);
  nodes.push({
    id: ROOT_ID,
    title: projectName,
    subtitle: file,
    kind: "project",
    parentId: null,
    status: "ready",
    accent: "#38bdf8",
    badge: `${services.length} services · ${totalReplicas} replicas`,
    agg: [
      { label: "ports", value: String(services.reduce((sum, service) => sum + service.ports.length, 0)), tone: "info" },
      { label: "volumes", value: String(services.reduce((sum, service) => sum + service.volumes.length, 0)), tone: "idle" },
      { label: "networks", value: String(networks.length), tone: "idle" },
      { label: "findings", value: String(findings.length), tone: findings.some((f) => f.level === "error") ? "bad" : "warn" },
    ],
  });

  for (const service of services) {
    const serviceId = `compose:service:${service.name}`;
    const worst = service.build ? "build" : "image";
    nodes.push({
      id: serviceId,
      title: service.name,
      subtitle: service.image ?? `${service.build?.context}/` + (service.build?.dockerfile ?? "Dockerfile"),
      kind: "service",
      parentId: ROOT_ID,
      status: service.healthcheck ? "healthy-check" : "up",
      accent: service.build ? "#a855f7" : "#0ea5e9",
      badge: worst,
      agg: [
        { label: "ports", value: service.ports.length ? service.ports.map((port) => `${port.published || "?"}→${port.target}`).join(" ") : "—", tone: "info" },
        { label: "vols", value: String(service.volumes.length), tone: "idle" },
        { label: "deps", value: String(service.dependsOn.length), tone: service.dependsOn.length ? "warn" : "idle" },
        ...(service.deploy?.replicas ? [{ label: "replicas", value: String(service.deploy.replicas), tone: "info" }] : []),
      ],
      meta: [
        service.containerName ? `container_name: ${service.containerName}` : "",
        service.restart ? `restart: ${service.restart}` : "",
        service.profiles.length ? `profiles: ${service.profiles.join(",")}` : "",
      ].filter(Boolean),
      detail: {
        image: service.image ?? "(built)",
        build: service.build ? `${service.build.context} (${service.build.dockerfile ?? "Dockerfile"}${service.build.target ? ` → ${service.build.target}` : ""})` : null,
        command: service.command.join(" "),
        entrypoint: service.entrypoint.join(" "),
        ports: service.ports.map((port) => `${port.published || "random"}:${port.target}/${port.protocol}`),
        environment: service.environment.map((entry) => `${entry.key}=${entry.value}${entry.interpolated ? "  (interpolated)" : ""}`),
        envFiles: service.envFiles,
        volumes: service.volumes.map((volume) => `${volume.source}:${volume.target}${volume.mode ? `:${volume.mode}` : ""} (${volume.type})`),
        networks: service.networks.map((net) => `${net.name}${net.ipv4 ? ` @ ${net.ipv4}` : ""}${net.aliases.length ? ` aliases=${net.aliases.join(",")}` : ""}`),
        dependsOn: service.dependsOn.map((dep) => `${dep.name}${dep.condition ? ` (${dep.condition})` : ""}${dep.restart ? " restart=true" : ""}`),
        healthcheck: service.healthcheck ? service.healthcheck.test.join(" ") : null,
        healthcheckInterval: service.healthcheck?.interval ?? null,
        restart: service.restart,
        deployReplicas: service.deploy?.replicas ?? null,
        limits: service.deploy ? [service.deploy.cpus && `cpus=${service.deploy.cpus}`, service.deploy.memory && `memory=${service.deploy.memory}`].filter(Boolean).join(" ") || null : null,
        reservations: service.deploy ? [service.deploy.reservationsCpus && `cpus=${service.deploy.reservationsCpus}`, service.deploy.reservationsMemory && `memory=${service.deploy.reservationsMemory}`].filter(Boolean).join(" ") || null : null,
        secrets: service.secrets,
        configs: service.configs,
        user: service.user,
        logging: service.logging,
        extraHosts: service.extraHosts,
        sysctls: service.sysctls,
        capabilities: [...service.capabilities.add.map((cap) => `+${cap}`), ...service.capabilities.drop.map((cap) => `-${cap}`)],
        profiles: service.profiles,
      },
    });

    for (const dep of service.dependsOn) {
      if (!byName.has(dep.name)) {
        findings.push({ level: "error", message: `service "${service.name}" depends_on "${dep.name}" which does not exist in this file`, path: `services.${service.name}.depends_on` });
        continue;
      }
      edges.push({
        id: `compose:dep:${service.name}->${dep.name}`,
        source: `compose:service:${service.name}`,
        target: `compose:service:${dep.name}`,
        label: dep.condition ? dep.condition.replace("service_", "") : "depends_on",
        tone: dep.condition === "service_healthy" ? "warn" : "idle",
      });
    }

    for (const [index, port] of service.ports.entries()) {
      nodes.push({
        id: `compose:port:${service.name}:${index}`,
        title: `${port.published || "random"} → ${port.target}/${port.protocol}`,
        subtitle: port.mode ? `bind ${port.mode}` : "published port",
        kind: "network",
        parentId: serviceId,
        status: "up",
        accent: "#14b8a6",
        badge: port.protocol,
        detail: { published: port.published || "(random)", target: port.target, protocol: port.protocol, hostIp: port.mode ?? "0.0.0.0" },
      });
    }
    for (const [index, volume] of service.volumes.entries()) {
      nodes.push({
        id: `compose:volume:${service.name}:${index}`,
        title: volume.source || "(anonymous)",
        subtitle: `${volume.mode ?? "rw"} → ${volume.target}`,
        kind: volume.type === "bind" ? "volume" : "volume",
        parentId: serviceId,
        status: "up",
        accent: volume.type === "bind" ? "#f59e0b" : "#6366f1",
        badge: volume.type,
        detail: { type: volume.type, source: volume.source || "(anonymous)", target: volume.target, mode: volume.mode ?? "rw" },
      });
    }
    for (const [index, entry] of service.environment.entries()) {
      nodes.push({
        id: `compose:env:${service.name}:${index}`,
        title: entry.key,
        subtitle: entry.value || "(empty)",
        kind: "image",
        parentId: serviceId,
        status: entry.interpolated ? "degraded" : "up",
        accent: entry.interpolated ? "#f472b6" : "#64748b",
        badge: entry.interpolated ? "interpolated" : "env",
        detail: { key: entry.key, value: entry.value, interpolated: entry.interpolated },
      });
    }
    if (service.healthcheck) {
      nodes.push({
        id: `compose:health:${service.name}`,
        title: "healthcheck",
        subtitle: service.healthcheck.test.join(" ").slice(0, 90),
        kind: "agent",
        parentId: serviceId,
        status: "up",
        accent: "#22c55e",
        badge: `every ${service.healthcheck.interval ?? "30s"} · ${service.healthcheck.retries ?? 3} retries`,
        detail: {
          test: service.healthcheck.test.join(" "),
          interval: service.healthcheck.interval ?? "30s",
          timeout: service.healthcheck.timeout ?? "10s",
          retries: service.healthcheck.retries ?? 3,
          startPeriod: service.healthcheck.startPeriod ?? null,
        },
      });
    }
    for (const network of service.networks) {
      nodes.push({
        id: `compose:net:${service.name}:${network.name}`,
        title: network.name,
        subtitle: network.ipv4 ?? "attached network",
        kind: "network",
        parentId: serviceId,
        status: "up",
        accent: "#22d3ee",
        badge: network.aliases.length ? network.aliases.join(",") : "net",
        detail: {
          network: network.name,
          ipv4: network.ipv4 ?? "(auto)",
          aliases: network.aliases.join(", "),
          internal: networks.find((entry) => entry.name === network.name)?.internal ?? false,
        },
      });
    }
  }

  const resourceGroup = "compose:resources";
  nodes.push({
    id: resourceGroup,
    title: "declared resources",
    subtitle: "networks, volumes, secrets, configs",
    kind: "project",
    parentId: ROOT_ID,
    status: "ready",
    accent: "#a855f7",
    badge: `${networks.length}n ${volumes.length}v`,
  });
  const networkGroup = `${resourceGroup}:networks`;
  if (networks.length) {
    nodes.push({ id: networkGroup, title: "networks", subtitle: `${networks.length} declared`, kind: "service", parentId: resourceGroup, status: "up", accent: "#22d3ee", badge: String(networks.length) });
    for (const network of networks) {
      nodes.push({
        id: `compose:network:${network.name}`,
        title: network.name,
        subtitle: `${network.driver}${network.internal ? " · internal" : ""}`,
        kind: "network",
        parentId: networkGroup,
        status: "up",
        accent: network.internal ? "#f43f5e" : "#22d3ee",
        badge: `${network.usedBy.length} services`,
        detail: { name: network.name, driver: network.driver, internal: network.internal, usedBy: network.usedBy },
      });
    }
  }
  const volumeGroup = `${resourceGroup}:volumes`;
  if (volumes.length) {
    nodes.push({ id: volumeGroup, title: "named volumes", subtitle: `${volumes.length} declared`, kind: "service", parentId: resourceGroup, status: "up", accent: "#6366f1", badge: String(volumes.length) });
    for (const volume of volumes) {
      nodes.push({
        id: `compose:namedvolume:${volume.name}`,
        title: volume.name,
        subtitle: volume.external ? "external" : "managed by compose",
        kind: "volume",
        parentId: volumeGroup,
        status: "up",
        accent: "#6366f1",
        badge: `${volume.usedBy.length} services`,
        detail: { name: volume.name, external: volume.external, usedBy: volume.usedBy },
      });
    }
  }
  const secretNames = [...new Set(services.flatMap((service) => service.secrets))];
  if (secretNames.length) {
    nodes.push({ id: `${resourceGroup}:secrets`, title: "secrets & configs", subtitle: `${secretNames.length} referenced`, kind: "service", parentId: resourceGroup, status: "up", accent: "#f43f5e", badge: String(secretNames.length) });
    for (const secret of secretNames) {
      nodes.push({ id: `compose:secret:${secret}`, title: secret, subtitle: "secret", kind: "image", parentId: `${resourceGroup}:secrets`, status: "up", accent: "#f43f5e", badge: "secret" });
    }
  }

  /* ---------------- validation ---------------- */
  const publishedPorts = new Map<string, string[]>();
  for (const service of services) {
    for (const port of service.ports) {
      if (!port.published) continue;
      publishedPorts.set(port.published, [...(publishedPorts.get(port.published) ?? []), service.name]);
    }
  }
  for (const [port, owners] of publishedPorts) {
    if (owners.length > 1) findings.push({ level: "error", message: `host port ${port} is published by ${owners.length} services (${owners.join(", ")}) — docker compose will fail to start`, path: "services.*.ports" });
  }

  for (const service of services) {
    if (!service.image && !service.build) findings.push({ level: "error", message: `service "${service.name}" has neither image nor build`, path: `services.${service.name}` });
    if (service.image && !/[@:]/.test(service.image)) findings.push({ level: "warn", message: `service "${service.name}" uses the floating tag "${service.image}" — pin a version or digest`, path: `services.${service.name}.image` });
    if (service.image?.includes(":latest")) findings.push({ level: "warn", message: `service "${service.name}" uses :latest`, path: `services.${service.name}.image` });
    if (!service.healthcheck && service.dependsOn.some((dep) => byName.get(dep.name)?.dependsOn.some((inner) => inner.condition === "service_healthy"))) {
      findings.push({ level: "info", message: `service "${service.name}" has no healthcheck but other services wait for health conditions`, path: `services.${service.name}` });
    }
    for (const dep of service.dependsOn) {
      if (dep.condition === "service_healthy" && !byName.get(dep.name)?.healthcheck) {
        findings.push({ level: "error", message: `service "${service.name}" waits for "${dep.name}" to be healthy but that service has no healthcheck`, path: `services.${service.name}.depends_on` });
      }
    }
    for (const volume of service.volumes) {
      if (volume.type === "volume" && volume.source && !Object.prototype.hasOwnProperty.call(rawVolumes, volume.source)) {
        findings.push({ level: "info", message: `service "${service.name}" mounts volume "${volume.source}" which is not declared in the top-level volumes section`, path: `services.${service.name}.volumes` });
      }
    }
    for (const network of service.networks) {
      if (!Object.prototype.hasOwnProperty.call(rawNetworks, network.name) && network.name !== "default") {
        findings.push({ level: "info", message: `service "${service.name}" attaches to network "${network.name}" which is not declared at the top level`, path: `services.${service.name}.networks` });
      }
    }
    if (service.environment.some((entry) => /password|secret|token|key/i.test(entry.key) && entry.value && !entry.interpolated && !/^\$\{/.test(entry.value))) {
      findings.push({ level: "warn", message: `service "${service.name}" appears to inline a credential in environment — prefer secrets or ${"${VAR}"} interpolation`, path: `services.${service.name}.environment` });
    }
    if (service.deploy?.cpus && Number(service.deploy.cpus) > 8) {
      findings.push({ level: "info", message: `service "${service.name}" requests ${service.deploy.cpus} cpus`, path: `services.${service.name}.deploy` });
    }
    if (service.restart === "always" && service.profiles.length) {
      findings.push({ level: "info", message: `service "${service.name}" is in profile ${service.profiles.join(",")} but restart=always`, path: `services.${service.name}` });
    }
    if (service.build && !service.image) findings.push({ level: "info", message: `service "${service.name}" is built locally without an image name — it cannot be pushed or reused`, path: `services.${service.name}` });
  }

  // dependency cycles
  const adjacency = new Map(services.map((service) => [service.name, service.dependsOn.map((dep) => dep.name).filter((name) => byName.has(name))]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const walkCycle = (name: string, trail: string[]): void => {
    if (done.has(name)) return;
    if (visiting.has(name)) {
      const cycle = [...trail.slice(trail.indexOf(name)), name];
      findings.push({ level: "error", message: `depends_on cycle: ${cycle.join(" → ")}`, path: "services.*.depends_on" });
      return;
    }
    visiting.add(name);
    for (const next of adjacency.get(name) ?? []) walkCycle(next, [...trail, name]);
    visiting.delete(name);
    done.add(name);
  };
  for (const service of services) walkCycle(service.name, []);

  const profiles = [...new Set(services.flatMap((service) => service.profiles))];
  if (profiles.length) findings.push({ level: "info", message: `${profiles.length} compose profiles in use: ${profiles.join(", ")} — start them with --profile` });

  return {
    kind: "compose",
    file,
    projectName,
    nodes,
    edges,
    findings,
    services,
    networks,
    volumes,
    stats: {
      services: services.length,
      buildableServices: services.filter((service) => service.build).length,
      publishedPorts: services.reduce((sum, service) => sum + service.ports.filter((port) => port.published).length, 0),
      namedVolumes: volumes.length,
      bindMounts: services.reduce((sum, service) => sum + service.volumes.filter((volume) => volume.type === "bind").length, 0),
      networks: networks.length,
      deployReplicas: totalReplicas,
      healthchecked: services.filter((service) => service.healthcheck).length,
      profiles,
      images: new Set(services.map((service) => service.image).filter(Boolean)).size,
    },
  };
}

export { parseDurationSeconds, humanSize };
