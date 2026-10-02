import path from "node:path";
import type { ConfigEdge, ConfigFinding, ConfigNode } from "./compose-parser";

/**
 * Dependency-free Terraform/HCL analyzer.
 *
 * A full HCL evaluator is out of scope (and needs the terraform binary), so this
 * is a structural parser: it tokenises blocks with string/comment/heredoc
 * awareness, extracts block headers + top-level attribute expressions, then
 * resolves references (`aws_vpc.main.id`, `var.x`, `local.y`, `module.m.out`,
 * `data.aws_ami.x.id`, `count.index`, `each.key`) into a dependency graph.
 */

export interface TfBlock {
  id: string;
  type: "resource" | "data" | "module" | "variable" | "output" | "provider" | "locals" | "terraform" | "moved" | "import" | "check";
  labels: string[];
  attributes: { name: string; expression: string; line: number }[];
  nestedBlocks: string[];
  line: number;
  file: string;
  resources: { type: string; name: string }[];
}

export interface TfModel {
  kind: "terraform";
  files: string[];
  nodes: ConfigNode[];
  edges: ConfigEdge[];
  findings: ConfigFinding[];
  modules: { source: string; version?: string; name: string }[];
  variables: { name: string; type: string; default: string | null; description: string | null; sensitive: boolean; usedBy: string[]; used: number }[];
  outputs: { name: string; value: string; description: string | null; sensitive: boolean; resolved: boolean }[];
  resources: { address: string; type: string; name: string; provider: string; attributes: number; dependsOn: string[]; dependents: string[]; countExpression: string | null; forEach: string | null }[];
  providers: { name: string; alias: string | null; region: string | null; version: string | null; resources: number }[];
  stats: {
    files: number;
    blocks: number;
    resources: number;
    dataSources: number;
    modules: number;
    variables: number;
    outputs: number;
    references: number;
    lines: number;
  };
  charts: { key: string; label: string; value: number; tone: string }[];
}

const ROOT_ID = "tf:root";

/** Strip comments while keeping string literals and heredocs intact. */
function stripNoise(content: string): string {
  const out: string[] = [];
  let index = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;
  let heredocTag: string | null = null;

  while (index < content.length) {
    const char = content[index];
    const rest = content.slice(index);

    if (heredocTag) {
      const terminator = new RegExp(`(^|\\n)[ \\t]*${heredocTag}[ \\t]*\\r?\\n`);
      const match = terminator.exec(rest);
      if (match) {
        const end = index + match.index + match[0].length;
        out.push(content.slice(index, end).replace(/[^\n]/g, " "));
        index = end;
        heredocTag = null;
        continue;
      }
      out.push(content.slice(index).replace(/[^\n]/g, " "));
      break;
    }
    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        out.push("\n");
      } else out.push(" ");
      index += 1;
      continue;
    }
    if (inBlockComment) {
      if (rest.startsWith("*/")) {
        inBlockComment = false;
        out.push("  ");
        index += 2;
        continue;
      }
      out.push(char === "\n" ? "\n" : " ");
      index += 1;
      continue;
    }
    if (inString) {
      out.push(char);
      if (char === "\\") {
        out.push(content[index + 1] ?? "");
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (rest.startsWith("//") || char === "#") {
      inLineComment = true;
      index += rest.startsWith("//") ? 2 : 1;
      continue;
    }
    if (rest.startsWith("/*")) {
      inBlockComment = true;
      index += 2;
      continue;
    }
    if (char === '"') {
      inString = true;
      out.push(char);
      index += 1;
      continue;
    }
    const heredoc = /^<<[-~]?([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
    if (heredoc) {
      heredocTag = heredoc[1];
      out.push(" ".repeat(heredoc[0].length));
      index += heredoc[0].length;
      continue;
    }
    out.push(char);
    index += 1;
  }
  return out.join("");
}

const BLOCK_TYPES = new Set(["resource", "data", "module", "variable", "output", "provider", "locals", "terraform", "moved", "import", "check", "removed"]);

function lineAt(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

function parseAssignment(expression: string): string {
  return expression.trim().replace(/\s+/g, " ");
}

export function parseHclBlocks(content: string, file: string): { blocks: TfBlock[]; findings: ConfigFinding[] } {
  const findings: ConfigFinding[] = [];
  const clean = stripNoise(content);
  const blocks: TfBlock[] = [];
  let index = 0;

  while (index < clean.length) {
    const slice = clean.slice(index);
    const header = /^\s*([A-Za-z_][\w-]*)\s*((?:"[^"]*"\s*)+)(\{)?/.exec(slice);
    const localsHeader = /^\s*(locals)\s*(\{)/.exec(slice);
    if (!header && !localsHeader) {
      index += 1;
      continue;
    }
    const match = header ?? localsHeader!;
    const type = match[1];
    if (!BLOCK_TYPES.has(type)) {
      index += 1;
      continue;
    }
    const headerText = match[0];
    const labels = (headerText.match(/"([^"]*)"/g) ?? []).map((entry) => entry.replace(/"/g, ""));
    const braceIndex = index + headerText.length - (headerText.endsWith("{") ? 1 : 0);
    if (clean[braceIndex] !== "{") {
      index += headerText.length;
      continue;
    }

    // walk to the matching brace
    let depth = 0;
    let cursor = braceIndex;
    let inString = false;
    while (cursor < clean.length) {
      const char = clean[cursor];
      if (inString) {
        if (char === "\\") cursor += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      cursor += 1;
    }

    const body = clean.slice(braceIndex + 1, cursor);
    const bodyStartOffset = braceIndex + 1;
    const attributes: TfBlock["attributes"] = [];
    const nestedBlocks: string[] = [];
    const line = lineAt(clean, index);

    // attributes: name = expression (expression runs to the end of the logical line,
    // multi-line values are captured until brackets balance)
    const attributeRegex = /(^|\n)[ \t]*([A-Za-z_][\w-]*)[ \t]*=[ \t]*/g;
    let attributeMatch: RegExpExecArray | null;
    while ((attributeMatch = attributeRegex.exec(body))) {
      const start = attributeMatch.index + attributeMatch[0].length;
      let end = start;
      let brackets = 0;
      let braces = 0;
      let inStr = false;
      while (end < body.length) {
        const char = body[end];
        if (inStr) {
          if (char === "\\") end += 1;
          else if (char === '"') inStr = false;
        } else if (char === '"') inStr = true;
        else if (char === "[" ) brackets += 1;
        else if (char === "]") brackets -= 1;
        else if (char === "{") braces += 1;
        else if (char === "}") braces -= 1;
        else if (char === "\n" && brackets <= 0 && braces <= 0) break;
        end += 1;
      }
      attributes.push({
        name: attributeMatch[2],
        expression: parseAssignment(body.slice(start, end)),
        line: lineAt(clean, bodyStartOffset + start),
      });
    }
    const nestedRegex = /(^|\n)[ \t]*([A-Za-z_][\w-]*)[ \t]+["{]?/g;
    let nestedMatch: RegExpExecArray | null;
    while ((nestedMatch = nestedRegex.exec(body))) {
      const name = nestedMatch[2];
      if (attributes.some((attribute) => attribute.name === name)) continue;
      if (BLOCK_TYPES.has(name) || /^(ingress|egress|metadata|spec|selector|template|container|resources|limits|node_group|backend|default_tags|versioning_configuration|validation|lifecycle|dynamic|provisioner)$/.test(name)) {
        nestedBlocks.push(name);
      }
    }

    const resources: { type: string; name: string }[] = [];
    for (const nested of nestedBlocks) {
      const inner = new RegExp(`(^|\\n)[ \\t]*(${nested})[ \\t]+"([^"]+)"`, "g");
      let innerMatch: RegExpExecArray | null;
      while ((innerMatch = inner.exec(body))) resources.push({ type: nested, name: innerMatch[3] });
    }

    blocks.push({ id: `${file}:${type}:${labels.join(".")}:${line}`, type: type as TfBlock["type"], labels, attributes, nestedBlocks, line, file, resources });
    index = cursor + 1;
  }

  if (blocks.length === 0 && content.trim()) {
    findings.push({ level: "error", message: `${file}: no terraform blocks recognised — is this an HCL file?`, path: file });
  }
  return { blocks, findings };
}

const REFERENCE_REGEXES: { pattern: RegExp; kind: "resource" | "data" | "module" | "var" | "local" | "output" | "builtin" }[] = [
  { pattern: /\bdata\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/g, kind: "data" },
  { pattern: /\bmodule\.([A-Za-z0-9_-]+)/g, kind: "module" },
  { pattern: /\bvar\.([A-Za-z0-9_-]+)/g, kind: "var" },
  { pattern: /\blocal\.([A-Za-z0-9_-]+)/g, kind: "local" },
  { pattern: /\boutput\.([A-Za-z0-9_-]+)/g, kind: "output" },
  { pattern: /\b([a-z][A-Za-z0-9_]*)\.([A-Za-z0-9_-]+)\./g, kind: "resource" },
];

const BUILTIN_NAMESPACES = new Set(["var", "local", "module", "data", "each", "count", "path", "terraform", "self", "output", "true", "false", "null"]);

export function parseTerraform(files: { name: string; content: string }[]): TfModel {
  const findings: ConfigFinding[] = [];
  const blocks: TfBlock[] = [];
  for (const file of files) {
    if (!file.content.trim()) {
      findings.push({ level: "error", message: `${file.name} is empty`, path: file.name });
      continue;
    }
    const parsed = parseHclBlocks(file.content, path.basename(file.name));
    blocks.push(...parsed.blocks);
    findings.push(...parsed.findings);
  }

  const resources = blocks.filter((block) => block.type === "resource" && block.labels.length >= 2);
  const dataSources = blocks.filter((block) => block.type === "data" && block.labels.length >= 2);
  const moduleBlocks = blocks.filter((block) => block.type === "module");
  const variableBlocks = blocks.filter((block) => block.type === "variable");
  const outputBlocks = blocks.filter((block) => block.type === "output");
  const providerBlocks = blocks.filter((block) => block.type === "provider");
  const localsBlocks = blocks.filter((block) => block.type === "locals");
  const terraformBlocks = blocks.filter((block) => block.type === "terraform");
  const lines = files.reduce((sum, file) => sum + file.content.split("\n").length, 0);

  const addressOf = (block: TfBlock) => block.type === "data" ? `data.${block.labels[0]}.${block.labels[1]}` : `${block.labels[0]}.${block.labels[1]}`;
  const known = new Set<string>([
    ...resources.map(addressOf),
    ...dataSources.map(addressOf),
    ...moduleBlocks.map((block) => `module.${block.labels[0]}`),
    ...variableBlocks.map((block) => `var.${block.labels[0]}`),
    ...outputBlocks.map((block) => `output.${block.labels[0]}`),
    ...localsBlocks.flatMap((block) => block.attributes.map((attribute) => `local.${attribute.name}`)),
  ]);

  const localNames = new Set(localsBlocks.flatMap((block) => block.attributes.map((attribute) => attribute.name)));
  const variableNames = new Set(variableBlocks.map((block) => block.labels[0]));

  /* ------------- reference extraction ------------- */
  const edges: ConfigEdge[] = [];
  const dependencies = new Map<string, Set<string>>();
  let references = 0;

  const record = (from: string, to: string, label: string) => {
    if (from === to) return;
    references += 1;
    const set0 = dependencies.get(from) ?? new Set<string>();
    set0.add(to);
    dependencies.set(from, set0);
    edges.push({
      id: `tf:${from}->${to}:${label}`.replace(/\s/g, ""),
      source: from,
      target: to,
      label,
      tone: to.startsWith("module.") ? "info" : to.startsWith("data.") ? "idle" : "info",
    });
    const set = dependencies.get(from) ?? new Set<string>();
    set.add(to);
    dependencies.set(from, set);
  };

  for (const block of blocks) {
    // the "from" id must match the canvas node id for this block
    const from =
      block.type === "locals"
        ? `local:${block.file}:${block.line}`
        : block.type === "variable"
          ? `var.${block.labels[0]}`
          : block.type === "output"
            ? `output.${block.labels[0]}`
            : block.type === "module"
              ? `module.${block.labels[0]}`
              : block.type === "provider"
                ? `provider.${block.labels[0]}${block.attributes.find((attribute) => attribute.name === "alias") ? `.${block.attributes.find((attribute) => attribute.name === "alias")!.expression.replace(/"/g, "")}` : ""}`
                : block.type === "resource" || block.type === "data"
                  ? block.labels.length >= 2 ? addressOf(block) : ""
                  : "";
    if (!from) continue;
    for (const attribute of block.attributes) {
      for (const { pattern, kind } of REFERENCE_REGEXES) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(attribute.expression))) {
          if (kind === "resource") {
            const [full, resourceType, resourceName] = match;
            if (BUILTIN_NAMESPACES.has(resourceType)) continue;
            if (full.startsWith("data.") || full.startsWith("module.")) continue;
            const address = `${resourceType}.${resourceName}`;
            if (known.has(address)) record(from, address, attribute.name);
            continue;
          }
          if (kind === "data") {
            const address = `data.${match[1]}.${match[2]}`;
            if (known.has(address)) record(from, address, attribute.name);
            continue;
          }
          if (kind === "module") {
            const address = `module.${match[1]}`;
            if (known.has(address)) record(from, address, attribute.name);
            continue;
          }
          if (kind === "var") {
            const address = `var.${match[1]}`;
            if (!variableNames.has(match[1])) {
              findings.push({ level: "error", message: `${from} references var.${match[1]} but no variable block declares it`, path: from });
              continue;
            }
            record(from, address, attribute.name);
            continue;
          }
          if (kind === "local") {
            const address = `local.${match[1]}`;
            if (!localNames.has(match[1])) {
              findings.push({ level: "error", message: `${from} references local.${match[1]} which is never assigned`, path: from });
              continue;
            }
            record(from, address, attribute.name);
          }
        }
      }
    }
  }

  /* ------------- graph ------------- */
  const nodes: ConfigNode[] = [];
  const providerOf = (type: string) => type.split("_")[0];
  /** Maps a reference address to the canvas node id that represents it. */
  const nodeIdForAddress = (address: string): string => {
    if (address.startsWith("module.")) return address; // module nodes are top-level "module.<name>"
    if (address.startsWith("var.") || address.startsWith("local.") || address.startsWith("output.")) return address;
    return `tf:resource:${address}`;
  };

  const providers = new Map<string, { name: string; alias: string | null; region: string | null; version: string | null; resources: number }>();
  for (const block of providerBlocks) {
    const name = block.labels[0];
    providers.set(name, {
      name,
      alias: block.attributes.find((attribute) => attribute.name === "alias")?.expression.replace(/"/g, "") ?? null,
      region: block.attributes.find((attribute) => attribute.name === "region")?.expression.replace(/"/g, "") ?? null,
      version: null,
      resources: 0,
    });
  }
  const requiredProviders = terraformBlocks.flatMap((block) => block.resources.filter((resource) => resource.type === "required_providers"));
  const providerVersions = new Map<string, string>();
  for (const block of terraformBlocks) {
    const regex = /([a-z0-9-]+)\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/g;
    for (const attribute of block.attributes) {
      let match: RegExpExecArray | null;
      regex.lastIndex = 0;
      while ((match = regex.exec(attribute.expression))) providerVersions.set(match[1], match[2]);
    }
  }
  for (const resource of [...resources, ...dataSources]) {
    const provider = providerOf(resource.labels[0]);
    const entry = providers.get(provider) ?? { name: provider, alias: null, region: null, version: providerVersions.get(provider) ?? null, resources: 0 };
    entry.resources += 1;
    entry.version = entry.version ?? providerVersions.get(provider) ?? null;
    providers.set(provider, entry);
  }
  for (const required of requiredProviders) {
    for (const [, version] of providerVersions) {
      void required;
      void version;
    }
  }

  const totalResources = resources.length + dataSources.length;
  nodes.push({
    id: ROOT_ID,
    title: "terraform root module",
    subtitle: `${files.length} file(s) · ${lines} lines`,
    kind: "host",
    parentId: null,
    status: findings.some((finding) => finding.level === "error") ? "degraded" : "ready",
    accent: "#7c3aed",
    badge: `${totalResources} resources`,
    agg: [
      { label: "providers", value: String(providers.size), tone: "info" },
      { label: "modules", value: String(moduleBlocks.length), tone: "info" },
      { label: "vars", value: String(variableBlocks.length), tone: "idle" },
      { label: "outputs", value: String(outputBlocks.length), tone: "idle" },
      { label: "refs", value: String(references), tone: "idle" },
    ],
  });

  const providerGroup = "tf:providers";
  nodes.push({
    id: providerGroup,
    title: "providers",
    subtitle: `${providers.size} configured`,
    kind: "project",
    parentId: ROOT_ID,
    status: "ready",
    accent: "#0ea5e9",
    badge: String(providers.size),
  });
  for (const provider of [...providers.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    nodes.push({
      id: `tf:provider:${provider.name}`,
      title: provider.name,
      subtitle: [provider.region, provider.alias ? `alias=${provider.alias}` : null, provider.version ? `v${provider.version}` : null].filter(Boolean).join(" · ") || "provider",
      kind: "external",
      parentId: providerGroup,
      status: "up",
      accent: "#0ea5e9",
      badge: `${provider.resources} resources`,
      detail: { name: provider.name, region: provider.region, alias: provider.alias, version: provider.version, resources: provider.resources },
    });
  }

  const resourceTypeGroups = new Map<string, TfBlock[]>();
  for (const block of [...resources, ...dataSources]) {
    const group = `${block.type === "data" ? "data" : "resource"}:${providerOf(block.labels[0])}/${block.labels[0]}`;
    resourceTypeGroups.set(group, [...(resourceTypeGroups.get(group) ?? []), block]);
  }

  const resourcesGroup = "tf:resources";
  nodes.push({
    id: resourcesGroup,
    title: "resources",
    subtitle: `${resourceTypeGroups.size} resource types`,
    kind: "project",
    parentId: ROOT_ID,
    status: "ready",
    accent: "#22c55e",
    badge: `${totalResources}`,
    agg: [
      { label: "managed", value: String(resources.length), tone: "info" },
      { label: "data", value: String(dataSources.length), tone: "idle" },
    ],
  });

  for (const [group, members] of [...resourceTypeGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const groupId = `tf:group:${group}`;
    nodes.push({
      id: groupId,
      title: group.split(":")[1],
      subtitle: `${members.length} block(s)`,
      kind: "service",
      parentId: resourcesGroup,
      status: "ready",
      accent: group.startsWith("data:") ? "#f59e0b" : "#22c55e",
      badge: String(members.length),
    });
    for (const member of members) {
      const address = addressOf(member);
      const deps = [...(dependencies.get(address) ?? [])];
      nodes.push({
        id: `tf:resource:${address}`,
        title: address,
        subtitle: `${member.attributes.length} attributes · ${member.nestedBlocks.length} nested blocks`,
        kind: member.type === "data" ? "image" : "container",
        parentId: groupId,
        status: deps.length ? "up" : "ready",
        accent: member.type === "data" ? "#f59e0b" : "#22c55e",
        badge: member.type === "data" ? "data" : deps.length ? `${deps.length} refs` : "leaf",
        agg: [
          { label: "file", value: member.file, tone: "idle" },
          { label: "line", value: String(member.line), tone: "idle" },
        ],
        detail: {
          address,
          file: `${member.file}:${member.line}`,
          attributes: Object.fromEntries(member.attributes.map((attribute) => [attribute.name, attribute.expression.slice(0, 300)])),
          dependsOn: deps,
          nestedBlocks: member.nestedBlocks,
        },
      });
      for (const dependency of deps) {
        edges.push({
          id: `tf:dep:${address}->${dependency}`,
          source: `tf:resource:${address}`,
          target: nodeIdForAddress(dependency),
          label: dependency.startsWith("var.") ? "var" : dependency.startsWith("local.") ? "local" : "uses",
          tone: dependency.startsWith("var.") ? "idle" : "info",
        });
      }
    }
  }

  const modulesGroup = "tf:modules";
  if (moduleBlocks.length) {
    nodes.push({ id: modulesGroup, title: "child modules", subtitle: `${moduleBlocks.length} modules`, kind: "project", parentId: ROOT_ID, status: "ready", accent: "#a855f7", badge: String(moduleBlocks.length) });
    for (const block of moduleBlocks) {
      const source = block.attributes.find((attribute) => attribute.name === "source")?.expression.replace(/"/g, "");
      const version = block.attributes.find((attribute) => attribute.name === "version")?.expression.replace(/"/g, "");
      nodes.push({
        id: `module.${block.labels[0]}`,
        title: block.labels[0],
        subtitle: source ?? "(no source)",
        kind: "service",
        parentId: modulesGroup,
        status: "ready",
        accent: "#a855f7",
        badge: version ? `v${version}` : "module",
        detail: { source, version, inputs: block.attributes.filter((attribute) => !["source", "version"].includes(attribute.name)).map((attribute) => `${attribute.name} = ${attribute.expression.slice(0, 200)}`) },
      });
    }
  }

  const variablesGroup = "tf:variables";
  const variables = variableBlocks.map((block) => {
    const name = block.labels[0];
    const usedBy = [...dependencies.entries()].filter(([, set]) => set.has(`var.${name}`)).map(([from]) => from);
    return {
      name,
      type: block.attributes.find((attribute) => attribute.name === "type")?.expression ?? "any",
      default: block.attributes.find((attribute) => attribute.name === "default")?.expression ?? null,
      description: block.attributes.find((attribute) => attribute.name === "description")?.expression.replace(/^"|"$/g, "") ?? null,
      sensitive: block.attributes.find((attribute) => attribute.name === "sensitive")?.expression === "true",
      usedBy,
      used: usedBy.length,
    };
  });
  if (variables.length) {
    nodes.push({
      id: variablesGroup,
      title: "input variables",
      subtitle: `${variables.length} declared · ${variables.filter((variable) => variable.used === 0).length} unused`,
      kind: "project",
      parentId: ROOT_ID,
      status: variables.some((variable) => variable.used === 0) ? "degraded" : "ready",
      accent: "#f472b6",
      badge: String(variables.length),
    });
    for (const variable of variables) {
      nodes.push({
        id: `var.${variable.name}`,
        title: variable.name,
        subtitle: `${variable.type} · ${variable.default === null ? "required (no default)" : `default ${variable.default.slice(0, 40)}`}`,
        kind: "volume",
        parentId: variablesGroup,
        status: variable.used === 0 ? "degraded" : variable.sensitive ? "warn" : "up",
        accent: variable.used === 0 ? "#fb7185" : variable.sensitive ? "#f59e0b" : "#f472b6",
        badge: variable.used === 0 ? "unused" : `${variable.used} refs`,
        detail: { name: variable.name, type: variable.type, default: variable.default, description: variable.description, sensitive: variable.sensitive, usedBy: variable.usedBy },
      });
    }
  }

  const outputsGroup = "tf:outputs";
  const outputs = outputBlocks.map((block) => {
    const value = block.attributes.find((attribute) => attribute.name === "value")?.expression ?? "";
    const resolved = [...REFERENCE_REGEXES].every(({ pattern }) => {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(value))) {
        if (pattern.source.startsWith("\\bdata")) return known.has(`data.${match[1]}.${match[2]}`);
        if (pattern.source.includes("module")) return known.has(`module.${match[1]}`);
        if (pattern.source.includes("var")) return true;
        if (pattern.source.includes("local")) return true;
        return true;
      }
      return true;
    });
    return {
      name: block.labels[0],
      value,
      description: block.attributes.find((attribute) => attribute.name === "description")?.expression.replace(/^"|"$/g, "") ?? null,
      sensitive: block.attributes.find((attribute) => attribute.name === "sensitive")?.expression === "true",
      resolved,
    };
  });
  if (outputs.length) {
    nodes.push({
      id: outputsGroup,
      title: "outputs",
      subtitle: `${outputs.length} exported values`,
      kind: "project",
      parentId: ROOT_ID,
      status: "ready",
      accent: "#22d3ee",
      badge: String(outputs.length),
    });
    for (const output of outputs) {
      const value = output.value;
      const match = /^\s*(data\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|module\.[A-Za-z0-9_-]+|[a-z][A-Za-z0-9_]*\.[A-Za-z0-9_-]+)/.exec(value);
      const targetAddress = match ? match[1] : null;
      const targetId = targetAddress ? nodeIdForAddress(targetAddress) : null;
      const knownTarget = Boolean(targetAddress && known.has(targetAddress) && nodes.some((node) => node.id === targetId));
      nodes.push({
        id: `output.${output.name}`,
        title: output.name,
        subtitle: output.value.slice(0, 70),
        kind: "agent",
        parentId: outputsGroup,
        status: targetAddress && !knownTarget ? "degraded" : "up",
        accent: targetAddress && !knownTarget ? "#f43f5e" : "#22d3ee",
        badge: output.sensitive ? "sensitive" : targetAddress && !knownTarget ? "unresolved" : "value",
        detail: { name: output.name, value: output.value.slice(0, 500), description: output.description, sensitive: output.sensitive, references: targetAddress },
      });
      if (targetAddress && knownTarget && targetId) {
        edges.push({ id: `tf:out:${output.name}->${targetAddress}`, source: `output.${output.name}`, target: targetId, label: "export", tone: "info" });
      } else if (targetAddress && !knownTarget) {
        findings.push({ level: "error", message: `output "${output.name}" references ${targetAddress}, which no block in this configuration declares`, path: `output.${output.name}` });
      }
    }
  }

  const localsGroup = "tf:locals";
  if (localsBlocks.length) {
    nodes.push({ id: localsGroup, title: "locals", subtitle: `${localsBlocks.reduce((sum, block) => sum + block.attributes.length, 0)} computed values`, kind: "project", parentId: ROOT_ID, status: "ready", accent: "#818cf8", badge: String(localsBlocks.reduce((sum, block) => sum + block.attributes.length, 0)) });
    for (const block of localsBlocks) {
      for (const attribute of block.attributes) {
        nodes.push({
          id: `local.${attribute.name}`,
          title: attribute.name,
          subtitle: attribute.expression.slice(0, 70),
          kind: "volume",
          parentId: localsGroup,
          status: "up",
          accent: "#818cf8",
          badge: "local",
          detail: { name: attribute.name, value: attribute.expression.slice(0, 400), file: `${block.file}:${block.line}` },
        });
      }
    }
  }

  /* ------------- findings ------------- */
  for (const variable of variables) {
    if (variable.used === 0) findings.push({ level: "warn", message: `variable "${variable.name}" is declared but never referenced`, path: `variable.${variable.name}` });
    if (variable.default === null && !variable.sensitive) findings.push({ level: "info", message: `variable "${variable.name}" has no default — every plan needs -var/-var-file input`, path: `variable.${variable.name}` });
    if (variable.sensitive && variable.default !== null && /"|\[/.test(variable.default) && !/null/.test(variable.default)) {
      findings.push({ level: "warn", message: `sensitive variable "${variable.name}" ships a default value in source control`, path: `variable.${variable.name}` });
    }
  }
  for (const resource of resources) {
    const address = addressOf(resource);
    const dependents = [...(dependencies.entries())].filter(([, set]) => set.has(address)).map(([from]) => from);
    if (dependents.length === 0 && !/cloudwatch|output|log/i.test(address)) {
      findings.push({ level: "info", message: `${address} is not referenced by anything else in this configuration`, path: address });
    }
    for (const attribute of resource.attributes) {
      if (attribute.name === "password" || attribute.name === "secret") {
        if (/"\w/.test(attribute.expression) && !/\$\{/.test(attribute.expression)) {
          findings.push({ level: "error", message: `${address}.${attribute.name} looks like a hard-coded credential`, path: address });
        }
      }
      if (attribute.name === "acl" && /"public-read(-write)?"/.test(attribute.expression)) {
        findings.push({ level: "warn", message: `${address} sets a public ACL`, path: address });
      }
    }
    if (/\b0\.0\.0\.0\/0\b/.test(JSON.stringify(resource.attributes)) && resource.labels[0].includes("security_group")) {
      findings.push({ level: "warn", message: `${address} allows traffic from 0.0.0.0/0`, path: address });
    }
    if ([...dependencies.get(address) ?? []].some((dependency) => resources.some((entry) => addressOf(entry) === dependency && entry.labels[0] === "aws_iam_role"))) {
      findings.push({ level: "info", message: `${address} depends on an IAM role — check least privilege on its policy attachments`, path: address });
    }
  }
  const versioned = terraformBlocks.some((block) => block.attributes.some((attribute) => attribute.name === "required_version"));
  if (!versioned) findings.push({ level: "warn", message: "terraform.required_version is not pinned — a newer CLI may reject the configuration", path: "terraform" });
  const stateBackend = terraformBlocks.some((block) => block.nestedBlocks.includes("backend"));
  if (!stateBackend) findings.push({ level: "warn", message: "no remote state backend configured (terraform { backend ... }) — local state is a single point of failure", path: "terraform" });
  for (const block of resources) {
    for (const attribute of block.attributes) {
      if (/\bvar\.([A-Za-z0-9_-]+)/.test(attribute.expression)) {
        for (const match of attribute.expression.matchAll(/\bvar\.([A-Za-z0-9_-]+)/g)) {
          if (!variableNames.has(match[1])) findings.push({ level: "error", message: `${addressOf(block)} uses undeclared var.${match[1]}`, path: addressOf(block) });
        }
      }
    }
  }
  const unique = new Set<string>();
  const dedupedFindings = findings.filter((finding) => {
    const key = `${finding.level}|${finding.message}`;
    if (unique.has(key)) return false;
    unique.add(key);
    return true;
  });

  return {
    kind: "terraform",
    files: files.map((file) => file.name),
    nodes,
    edges,
    findings: dedupedFindings,
    modules: moduleBlocks.map((block) => ({
      name: block.labels[0],
      source: block.attributes.find((attribute) => attribute.name === "source")?.expression.replace(/"/g, "") ?? "",
      version: block.attributes.find((attribute) => attribute.name === "version")?.expression.replace(/"/g, "") || undefined,
    })),
    variables,
    outputs,
    resources: resources.map((block) => {
      const address = addressOf(block);
      return {
        address,
        type: block.labels[0],
        name: block.labels[1],
        provider: providerOf(block.labels[0]),
        attributes: block.attributes.length,
        dependsOn: [...(dependencies.get(address) ?? [])],
        dependents: [...(dependencies.entries())].filter(([, set]) => set.has(address)).map(([from]) => from),
        countExpression: block.attributes.find((attribute) => attribute.name === "count")?.expression ?? null,
        forEach: block.attributes.find((attribute) => attribute.name === "for_each")?.expression ?? null,
      };
    }),
    providers: [...providers.values()],
    stats: {
      files: files.length,
      blocks: blocks.length,
      resources: resources.length,
      dataSources: dataSources.length,
      modules: moduleBlocks.length,
      variables: variableBlocks.length,
      outputs: outputBlocks.length,
      references,
      lines,
    },
    charts: [
      { key: "managed", label: "managed resources", value: resources.length, tone: "#22c55e" },
      { key: "data", label: "data sources", value: dataSources.length, tone: "#f59e0b" },
      { key: "modules", label: "child modules", value: moduleBlocks.length, tone: "#a855f7" },
      { key: "variables", label: "variables", value: variableBlocks.length, tone: "#f472b6" },
      { key: "outputs", label: "outputs", value: outputBlocks.length, tone: "#22d3ee" },
    ],
  };
}
