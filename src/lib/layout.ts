export interface LayoutItem {
  id: string;
  parentId: string | null;
}

export interface Point {
  x: number;
  y: number;
}

export interface TreeLayoutOptions {
  xGap?: number;
  yGap?: number;
  width?: number;
  height?: number;
  rootX?: number;
}

/**
 * Deterministic tidy layout for a parent/child tree (used by the container
 * hierarchy map). Children are stacked vertically, parents are centred over
 * their children. Only nodes that are currently visible are laid out.
 */
export function layoutTree(items: LayoutItem[], options: TreeLayoutOptions = {}): Map<string, Point> {
  const xGap = options.xGap ?? 340;
  const yGap = options.yGap ?? 132;
  const rootX = options.rootX ?? 60;
  const rootY = (options.height ?? 700) / 2 - 40;

  const positions = new Map<string, Point>();
  const visible = new Map(items.map((i) => [i.id, i]));
  const childrenOf = new Map<string | null, string[]>();
  for (const item of items) {
    const parentKey = item.parentId && visible.has(item.parentId) ? item.parentId : null;
    childrenOf.set(parentKey, [...(childrenOf.get(parentKey) ?? []), item.id]);
  }

  const roots = childrenOf.get(null) ?? [];
  let cursor = 0;

  const place = (id: string, depth: number): number => {
    const kids = childrenOf.get(id) ?? [];
    if (!kids.length) {
      const y = rootY + cursor * yGap;
      cursor += 1;
      positions.set(id, { x: rootX + depth * xGap, y });
      return y;
    }
    const childYs = kids.map((kid) => place(kid, depth + 1));
    const y = (Math.min(...childYs) + Math.max(...childYs)) / 2;
    positions.set(id, { x: rootX + depth * xGap, y });
    return y;
  };

  for (const root of roots) {
    place(root, 0);
    cursor += 0.6;
  }
  return positions;
}

export interface LayeredOptions {
  columnGap?: number;
  rowGap?: number;
  startX?: number;
  startY?: number;
}

/**
 * Layered (Sugiyama style) layout with rank assignment + barycenter ordering.
 * Used for the APM service map and for auto-arranging workflows.
 */
export function layoutLayered(
  nodeIds: string[],
  edges: { source: string; target: string }[],
  options: LayeredOptions = {},
): Map<string, Point> {
  const columnGap = options.columnGap ?? 300;
  const rowGap = options.rowGap ?? 130;
  const startX = options.startX ?? 60;
  const startY = options.startY ?? 60;

  const ids = new Set(nodeIds);
  const valid = edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const id of nodeIds) {
    outgoing.set(id, []);
    incoming.set(id, []);
    indegree.set(id, 0);
  }
  for (const edge of valid) {
    outgoing.get(edge.source)!.push(edge.target);
    incoming.get(edge.target)!.push(edge.source);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  // rank = longest path from a source
  const rank = new Map<string, number>();
  for (const id of nodeIds) rank.set(id, 0);
  const queue = nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0);
  const remaining = new Map(indegree);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(id) ?? 0) + 1));
      remaining.set(next, (remaining.get(next) ?? 1) - 1);
      if ((remaining.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  for (const id of nodeIds) if (!order.includes(id)) order.push(id);

  const layers = new Map<number, string[]>();
  for (const id of nodeIds) {
    const r = rank.get(id) ?? 0;
    layers.set(r, [...(layers.get(r) ?? []), id]);
  }

  // barycenter ordering to reduce edge crossings
  const indexInLayer = new Map<string, number>();
  const reindex = () => {
    for (const layer of layers.values()) layer.forEach((id, i) => indexInLayer.set(id, i));
  };
  reindex();
  for (let pass = 0; pass < 3; pass += 1) {
    for (const r of [...layers.keys()].sort((a, b) => a - b)) {
      const layer = layers.get(r)!;
      layer.sort((a, b) => barycenter(a) - barycenter(b));
      reindex();
    }
  }
  function barycenter(id: string): number {
    const neighbours = [...(incoming.get(id) ?? []), ...(outgoing.get(id) ?? [])];
    if (!neighbours.length) return indexInLayer.get(id) ?? 0;
    const sum = neighbours.reduce((acc, n) => acc + (indexInLayer.get(n) ?? 0), 0);
    return sum / neighbours.length;
  }

  const positions = new Map<string, Point>();
  const maxRows = Math.max(...[...layers.values()].map((l) => l.length), 1);
  for (const [r, layer] of layers) {
    const offset = ((maxRows - layer.length) * rowGap) / 2;
    layer.forEach((id, i) => {
      positions.set(id, { x: startX + r * columnGap, y: startY + offset + i * rowGap });
    });
  }
  return positions;
}
