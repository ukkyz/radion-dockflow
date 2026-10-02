"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { layoutLayered, layoutTree } from "@/lib/layout";
import { cls, fmtMb, stateTone, TONE_CLASSES } from "@/lib/client";

export interface CanvasAgg {
  label: string;
  value: string;
  /** tone key looked up in TONE_CLASSES (unknown keys fall back to "info") */
  tone?: string;
}

export interface CanvasNode {
  id: string;
  title: string;
  subtitle?: string;
  kind: string;
  parentId?: string | null;
  status?: string;
  health?: string | null;
  badge?: string;
  meta?: string[];
  metrics?: { cpu: number; mem: number; net: number };
  agg?: CanvasAgg[];
  hasChildren?: boolean;
  childCount?: number;
  tone?: "alert" | "normal" | "muted";
  accent?: string;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  tone?: "good" | "warn" | "bad" | "idle" | "info";
  animated?: boolean;
  width?: number;
}

export interface MapCanvasProps {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  layout?: "tree" | "layered";
  defaultExpandDepth?: number;
  onSelect?: (node: CanvasNode | null) => void;
  selectedId?: string | null;
  onToggle?: (node: CanvasNode, expanded: boolean) => void;
  height?: string;
  legend?: { label: string; tone: string }[];
  toolbarExtra?: React.ReactNode;
}

const GLYPHS: Record<string, string> = {
  host: "🖥",
  project: "📦",
  service: "⚙",
  container: "🐳",
  volume: "🗄",
  network: "🕸",
  image: "🧱",
  gateway: "🚪",
  db: "🛢",
  cache: "⚡",
  queue: "📬",
  external: "🔌",
  agent: "📈",
};

function NodeCard({ data }: NodeProps) {
  const node = data as unknown as CanvasNode & {
    expanded: boolean;
    childCount: number;
    onToggleNode: (id: string) => void;
    onOpen: (id: string) => void;
  };
  const tone = node.tone === "alert" ? "bad" : node.tone === "muted" ? "idle" : stateTone(node.status, node.health);
  const palette = TONE_CLASSES[tone] ?? TONE_CLASSES.idle;
  const accent = node.accent ?? "#38bdf8";

  return (
    <div
      className={cls(
        "group relative w-[286px] rounded-xl border bg-[#0d1424]/95 px-3 py-2.5 text-left shadow-lg transition",
        tone === "bad" ? "border-rose-500/50" : node.tone === "alert" ? "border-amber-500/50" : "border-slate-700/80",
        "hover:border-sky-500/60",
      )}
      onClick={() => node.onOpen(node.id)}
    >
      <span className="absolute left-0 top-0 h-full w-1 rounded-l-xl" style={{ background: accent }} />
      <Handle type="target" position={Position.Left} />
      <div className="flex items-start gap-2 pl-1.5">
        <span className="mt-0.5 text-[15px] leading-none">{GLYPHS[node.kind] ?? "•"}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-slate-100">{node.title}</span>
            <span className={cls("ml-auto flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]", palette.border, palette.bg, palette.text)}>
              <span className={cls("h-1.5 w-1.5 rounded-full", palette.dot)} />
              {node.badge ?? node.status ?? node.kind}
            </span>
          </div>
          {node.subtitle ? <div className="mt-0.5 truncate text-[11px] text-slate-400">{node.subtitle}</div> : null}

          {node.agg?.length ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {node.agg.slice(0, 4).map((item) => {
                const toneClass = TONE_CLASSES[item.tone ?? "info"] ?? TONE_CLASSES.info;
                return (
                  <span key={item.label} className={cls("rounded border px-1.5 py-0.5 text-[10px]", toneClass.border, toneClass.bg, toneClass.text)}>
                    <span className="text-slate-400">{item.label}</span> {item.value}
                  </span>
                );
              })}
            </div>
          ) : null}

          {node.metrics ? (
            <div className="mt-2 space-y-1">
              <MetricBar label="cpu" value={node.metrics.cpu} max={100} color="#38bdf8" suffix={`${node.metrics.cpu.toFixed(1)}%`} />
              <MetricBar label="mem" value={node.metrics.mem} max={1024} color="#a855f7" suffix={fmtMb(node.metrics.mem)} />
            </div>
          ) : null}

          {node.meta?.length ? (
            <div className="mt-2 space-y-0.5 text-[10px] text-slate-500">
              {node.meta.slice(0, 3).map((line) => (
                <div key={line} className="truncate">
                  {line}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
      {node.hasChildren ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            node.onToggleNode(node.id);
          }}
          title={node.expanded ? "collapse children" : `expand ${node.childCount} children`}
          className={cls(
            "absolute -right-3 top-1/2 z-10 flex h-7 min-w-7 -translate-y-1/2 items-center justify-center rounded-full border px-1 text-[11px] font-semibold shadow-md transition",
            node.expanded ? "border-sky-500 bg-sky-500 text-slate-950" : "border-slate-600 bg-slate-900 text-slate-200 hover:border-sky-400 hover:text-sky-300",
          )}
        >
          {node.expanded ? "−" : `+${node.childCount}`}
        </button>
      ) : null}
    </div>
  );
}

function MetricBar({ label, value, max, color, suffix }: { label: string; value: number; max: number; color: string; suffix: string }) {
  const pct = Math.max(2, Math.min(100, (value / max) * 100));
  return (
    <div className="flex items-center gap-2">
      <span className="w-7 shrink-0 text-[9px] uppercase tracking-wide text-slate-500">{label}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-800">
        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </span>
      <span className="w-14 shrink-0 text-right text-[9px] text-slate-400">{suffix}</span>
    </div>
  );
}

const nodeTypes = { mapNode: NodeCard };

function CanvasInner({
  nodes,
  edges,
  layout = "tree",
  defaultExpandDepth = 1,
  onSelect,
  selectedId,
  onToggle,
  height = "560px",
  legend,
  toolbarExtra,
}: MapCanvasProps) {
  const { fitView } = useReactFlow();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [internalSelected, setInternalSelected] = useState<string | null>(null);
  const [structureVersion, setStructureVersion] = useState(0);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const depthOf = useCallback(
    (id: string): number => {
      let depth = 0;
      let current = byId.get(id);
      while (current?.parentId && byId.has(current.parentId) && depth < 12) {
        depth += 1;
        current = byId.get(current.parentId);
      }
      return depth;
    },
    [byId],
  );

  const isExpanded = useCallback(
    (id: string) => {
      if (expanded[id] !== undefined) return expanded[id];
      return depthOf(id) < defaultExpandDepth;
    },
    [expanded, depthOf, defaultExpandDepth],
  );

  const visible = useMemo(() => {
    const out: CanvasNode[] = [];
    for (const node of nodes) {
      let cursor = node;
      let show = true;
      let guard = 0;
      while (cursor.parentId && byId.has(cursor.parentId) && guard < 12) {
        const parent = byId.get(cursor.parentId)!;
        if (!isExpanded(parent.id)) {
          show = false;
          break;
        }
        cursor = parent;
        guard += 1;
      }
      if (show) out.push(node);
    }
    return out;
  }, [nodes, byId, isExpanded]);

  const childCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of nodes) {
      if (node.parentId) counts.set(node.parentId, (counts.get(node.parentId) ?? 0) + 1);
    }
    return counts;
  }, [nodes]);

  const positions = useMemo(() => {
    if (layout === "layered") {
      const ids = visible.map((n) => n.id);
      const visibleIds = new Set(ids);
      return layoutLayered(
        ids,
        edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target)).map((e) => ({ source: e.source, target: e.target })),
      );
    }
    return layoutTree(visible.map((n) => ({ id: n.id, parentId: n.parentId ?? null })));
  }, [layout, visible, edges]);

  const toggle = useCallback(
    (id: string) => {
      const next = !isExpanded(id);
      setExpanded((prev) => ({ ...prev, [id]: next }));
      setStructureVersion((v) => v + 1);
      const node = byId.get(id);
      if (node) onToggle?.(node, next);
    },
    [isExpanded, byId, onToggle],
  );

  const open = useCallback(
    (id: string) => {
      setInternalSelected(id);
      const node = byId.get(id);
      onSelect?.(node ?? null);
    },
    [byId, onSelect],
  );

  const flowNodes: Node[] = useMemo(
    () =>
      visible.map((node) => ({
        id: node.id,
        type: "mapNode",
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        style: { background: "transparent", border: "none", padding: 0, width: 286 },
        data: {
          ...node,
          expanded: isExpanded(node.id),
          childCount: childCounts.get(node.id) ?? 0,
          hasChildren: (childCounts.get(node.id) ?? 0) > 0,
          onToggleNode: toggle,
          onOpen: open,
        },
      })),
    [visible, positions, isExpanded, childCounts, toggle, open],
  );

  const flowEdges: Edge[] = useMemo(() => {
    const visibleIds = new Set(visible.map((n) => n.id));
    return edges
      .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        type: layout === "layered" ? "smoothstep" : "bezier",
        animated: edge.animated,
        labelBgStyle: { fill: "#0b1220" },
        labelStyle: { fill: "#94a3b8", fontSize: 10 },
        style: {
          stroke: (TONE_CLASSES[edge.tone ?? "idle"] ?? TONE_CLASSES.idle).dot.replace("bg-", "").includes("emerald")
            ? "#34d399"
            : edge.tone === "bad"
              ? "#f43f5e"
              : edge.tone === "warn"
                ? "#fbbf24"
                : edge.tone === "info"
                  ? "#38bdf8"
                  : "#334155",
          strokeWidth: edge.width ?? 1.6,
          strokeDasharray: edge.tone === "idle" ? "4 4" : undefined,
        },
        markerEnd: { type: "arrowclosed" as const, color: "#475569", width: 14, height: 14 },
      }));
  }, [edges, visible, layout]);

  const activeId = selectedId ?? internalSelected;

  return (
    <div className="relative">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button type="button" className="chip bg-slate-900 text-slate-300 hover:border-sky-500 hover:text-sky-300" onClick={() => { setExpanded(Object.fromEntries(nodes.filter((n) => (childCounts.get(n.id) ?? 0) > 0).map((n) => [n.id, true]))); setStructureVersion((v) => v + 1); }}>
          expand all
        </button>
        <button type="button" className="chip bg-slate-900 text-slate-300 hover:border-sky-500 hover:text-sky-300" onClick={() => { setExpanded(Object.fromEntries(nodes.filter((n) => (childCounts.get(n.id) ?? 0) > 0).map((n) => [n.id, false]))); setStructureVersion((v) => v + 1); }}>
          collapse all
        </button>
        <button type="button" className="chip bg-slate-900 text-slate-300 hover:border-sky-500 hover:text-sky-300" onClick={() => void fitView({ padding: 0.15, duration: 400 })}>
          fit view
        </button>
        <span className="chip bg-slate-900/60 text-slate-500">
          {visible.length}/{nodes.length} nodes visible
        </span>
        {legend?.map((item) => (
          <span key={item.label} className="chip flex items-center gap-1.5 bg-slate-900/60 text-slate-400">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: item.tone }} />
            {item.label}
          </span>
        ))}
        <div className="ml-auto flex items-center gap-2">{toolbarExtra}</div>
      </div>
      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-[#070b14]" style={{ height }}>
        <ReactFlow
          key={`${layout}-${structureVersion}-${nodes.length}`}
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.15}
          maxZoom={1.8}
          proOptions={{ hideAttribution: true }}
          nodesDraggable
          onNodeClick={(_, node) => open(node.id)}
          className={cls("[&_.react-flow__node.selected]:outline-none", activeId ? "" : "")}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1e293b" />
          <MiniMap
            pannable
            zoomable
            style={{ background: "#0b1220", border: "1px solid #1e293b" }}
            nodeColor={(node) => {
              const data = node.data as unknown as CanvasNode;
              const tone = data.tone === "alert" ? "bad" : (data.tone ?? "normal") === "muted" ? "idle" : stateTone(data.status, data.health);
              return (TONE_CLASSES[tone] ?? TONE_CLASSES.idle).dot.replace("bg-", "");
            }}
          />
          <Controls showInteractive={false} style={{ background: "#0b1220", border: "1px solid #1e293b" }} />
        </ReactFlow>
      </div>
    </div>
  );
}

export default function MapCanvas(props: MapCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

export { GLYPHS };
