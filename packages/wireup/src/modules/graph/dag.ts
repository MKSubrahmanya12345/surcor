/**
 * Graph kernel — DAG data structures and algorithms.
 *
 * Adjacency views, cycle detection (iterative DFS with colours), Kahn's
 * topological sort with a stable tie-break, longest-path layering from the
 * roots, and barycenter crossing minimization. All pure: same input, same
 * output — no Date, no Math.random, no I/O.
 *
 * Conventions:
 *   - node identity is the string id; `index` is the upstream insertion
 *     order and is the ONLY tie-break (then the id itself), which is what
 *     keeps the layout stable between polls when nodes are appended.
 *   - self-loops are ignored for ordering/layering (they are reported by
 *     the validator instead of crashing the layout).
 */

import type { CycleInfo, GraphEdgeRef, GraphNodeRef, LayerAssignment, TopoSortResult } from './types';

export interface Adjacency {
  /** Outgoing neighbours per node (deduped, in edge order). */
  out: Map<string, string[]>;
  /** Incoming neighbours per node (deduped, in edge order). */
  incoming: Map<string, string[]>;
  /** Out-degree / in-degree ignoring self-loops. */
  outDegree: Map<string, number>;
  inDegree: Map<string, number>;
  /** Edge ids per ordered pair (parallel edges preserved). */
  edgeIds: Map<string, string[]>;
}

function pairKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

export function buildAdjacency(nodes: GraphNodeRef[], edges: GraphEdgeRef[]): Adjacency {
  const out = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const edgeIds = new Map<string, string[]>();
  for (const node of nodes) {
    out.set(node.id, []);
    incoming.set(node.id, []);
  }
  for (const edge of edges) {
    if (!out.has(edge.from) || !incoming.has(edge.to)) continue; // dangling endpoints: validator's job
    if (edge.from === edge.to) continue; // self-loop: validator's job
    const outs = out.get(edge.from)!;
    if (!outs.includes(edge.to)) outs.push(edge.to);
    const ins = incoming.get(edge.to)!;
    if (!ins.includes(edge.from)) ins.push(edge.from);
    const key = pairKey(edge.from, edge.to);
    const list = edgeIds.get(key) ?? [];
    list.push(edge.id);
    edgeIds.set(key, list);
  }
  const outDegree = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const node of nodes) {
    outDegree.set(node.id, out.get(node.id)!.length);
    inDegree.set(node.id, incoming.get(node.id)!.length);
  }
  return { out, incoming, edgeIds, outDegree, inDegree };
}

/**
 * Kahn's topological sort. The ready set is a *sorted* queue (by `index`,
 * then id), so the order is deterministic AND stable: appending a node never
 * reorders the nodes that were already there.
 */
export function topoSort(nodes: GraphNodeRef[], adjacency: Adjacency): TopoSortResult {
  const indexOf = new Map(nodes.map((node) => [node.id, node.index]));
  const inDegree = new Map<string, number>(adjacency.inDegree);
  const ready = nodes
    .filter((node) => (inDegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id)
    .sort(compareBy(indexOf));
  const order: string[] = [];

  while (ready.length > 0) {
    // shift() on a sorted array keeps the tie-break exact; graphs here are small.
    const id = ready.shift()!;
    order.push(id);
    for (const next of adjacency.out.get(id) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
        ready.sort(compareBy(indexOf));
      }
    }
  }

  const ordered = new Set(order);
  const cyclic = nodes.map((node) => node.id).filter((id) => !ordered.has(id));
  return { order, acyclic: cyclic.length === 0, cyclic };
}

function compareBy(indexOf: Map<string, number>): (a: string, b: string) => number {
  return (a, b) => {
    const ia = indexOf.get(a) ?? Number.MAX_SAFE_INTEGER;
    const ib = indexOf.get(b) ?? Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return a < b ? -1 : a > b ? 1 : 0;
  };
}

/**
 * Cycle detection via iterative DFS (white/gray/black). Returns one concrete
 * cycle path when the graph is cyclic, so the validator can name it instead
 * of just saying "a cycle exists".
 */
export function findCycle(nodes: GraphNodeRef[], adjacency: Adjacency): CycleInfo | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(nodes.map((node) => [node.id, WHITE]));
  const parent = new Map<string, string>();

  const ordered = [...nodes].sort((a, b) => (a.index === b.index ? (a.id < b.id ? -1 : 1) : a.index - b.index));

  for (const root of ordered) {
    if (color.get(root.id) !== WHITE) continue;
    // Explicit stack of [node, nextNeighbourIndex].
    const stack: { id: string; next: number }[] = [{ id: root.id, next: 0 }];
    color.set(root.id, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbours = adjacency.out.get(frame.id) ?? [];
      if (frame.next < neighbours.length) {
        const neighbour = neighbours[frame.next];
        frame.next += 1;
        const shade = color.get(neighbour) ?? BLACK;
        if (shade === WHITE) {
          parent.set(neighbour, frame.id);
          color.set(neighbour, GRAY);
          stack.push({ id: neighbour, next: 0 });
        } else if (shade === GRAY) {
          // Back edge frame.id → neighbour: walk parents back to neighbour.
          const path = [neighbour];
          let cursor: string | undefined = frame.id;
          while (cursor !== undefined && cursor !== neighbour) {
            path.push(cursor);
            cursor = parent.get(cursor);
          }
          path.push(neighbour);
          path.reverse();
          return { path };
        }
      } else {
        color.set(frame.id, BLACK);
        stack.pop();
      }
    }
  }
  return null;
}

/**
 * Longest-path layering from the roots (Sugiyama step 1), computed over the
 * topological order: `layer(v) = max(layer(u) + 1)` over incoming `u`, roots
 * at 0. Cyclic leftovers (if any) are pinned to layer 0 so a cycle can never
 * crash the layout — the validator reports it separately.
 *
 * `pinLayer` forces a node onto a fixed layer (used for the idea-graph kinds
 * and for kind-based columns). Forced layers still respect stability: order
 * within a layer is by `index`, then id.
 */
export function assignLayers(
  nodes: GraphNodeRef[],
  adjacency: Adjacency,
  topo: TopoSortResult,
  pinLayer?: (id: string) => number | null,
): LayerAssignment {
  const layerOf = new Map<string, number>();
  for (const id of topo.order) {
    const pinned = pinLayer?.(id) ?? null;
    if (pinned !== null && Number.isFinite(pinned) && pinned >= 0) {
      layerOf.set(id, Math.floor(pinned));
      continue;
    }
    let layer = 0;
    for (const prev of adjacency.incoming.get(id) ?? []) {
      const prevLayer = layerOf.get(prev);
      if (prevLayer !== undefined) layer = Math.max(layer, prevLayer + 1);
    }
    layerOf.set(id, layer);
  }
  // Cyclic leftovers + anything unvisited: pin to 0 (validator reports them).
  for (const node of nodes) {
    if (!layerOf.has(node.id)) {
      const pinned = pinLayer?.(node.id) ?? null;
      layerOf.set(node.id, pinned !== null && pinned >= 0 ? Math.floor(pinned) : 0);
    }
  }

  const maxLayer = Math.max(0, ...[...layerOf.values()]);
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const node of nodes) layers[layerOf.get(node.id)!].push(node.id);
  const indexOf = new Map(nodes.map((node) => [node.id, node.index]));
  for (const layer of layers) layer.sort(compareBy(indexOf));
  return { layerOf, layers, maxLayer };
}

/**
 * Barycenter crossing minimization (Sugiyama step 2): sweep right-to-left
 * then left-to-right, ordering each layer by the mean position of its
 * neighbours in the adjacent layer. A bounded number of sweeps (default 4)
 * with a strict-improvement rule keeps it deterministic and fast; ties keep
 * the previous order, which preserves poll-to-poll stability.
 */
export function minimizeCrossings(
  layers: string[][],
  adjacency: Adjacency,
  sweeps = 4,
): string[][] {
  let current = layers.map((layer) => [...layer]);
  let best = current.map((layer) => [...layer]);
  let bestScore = crossingScore(best, adjacency);

  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    // Right-to-left: order by successors.
    for (let layer = current.length - 2; layer >= 0; layer -= 1) {
      current[layer] = barycenterOrder(current[layer], current[layer + 1], (id) => adjacency.out.get(id) ?? []);
    }
    // Left-to-right: order by predecessors.
    for (let layer = 1; layer < current.length; layer += 1) {
      current[layer] = barycenterOrder(current[layer], current[layer - 1], (id) => adjacency.incoming.get(id) ?? []);
    }
    const score = crossingScore(current, adjacency);
    if (score < bestScore) {
      bestScore = score;
      best = current.map((layer) => [...layer]);
    }
  }
  return best;
}

function barycenterOrder(layer: string[], adjacent: string[], neighboursOf: (id: string) => string[]): string[] {
  const position = new Map(adjacent.map((id, index) => [id, index]));
  const scored = layer.map((id, previous) => {
    const neighbours = neighboursOf(id).filter((neighbour) => position.has(neighbour));
    if (neighbours.length === 0) return { id, score: Number.NaN, previous };
    const mean = neighbours.reduce((sum, neighbour) => sum + position.get(neighbour)!, 0) / neighbours.length;
    return { id, score: mean, previous };
  });
  scored.sort((a, b) => {
    const aNaN = Number.isNaN(a.score);
    const bNaN = Number.isNaN(b.score);
    if (aNaN && bNaN) return a.previous - b.previous;
    if (aNaN) return 1; // neighbourless nodes sink, in their previous order
    if (bNaN) return -1;
    if (a.score !== b.score) return a.score - b.score;
    return a.previous - b.previous;
  });
  return scored.map((entry) => entry.id);
}

/** Count pairwise edge crossings between adjacent layers (for improvement checks). */
export function crossingScore(layers: string[][], adjacency: Adjacency): number {
  let crossings = 0;
  for (let layer = 0; layer + 1 < layers.length; layer += 1) {
    const upper = new Map(layers[layer].map((id, index) => [id, index]));
    const lower = new Map(layers[layer + 1].map((id, index) => [id, index]));
    const pairs: { a: number; b: number }[] = [];
    for (const from of layers[layer]) {
      for (const to of adjacency.out.get(from) ?? []) {
        if (upper.has(from) && lower.has(to)) pairs.push({ a: upper.get(from)!, b: lower.get(to)! });
      }
    }
    for (let i = 0; i < pairs.length; i += 1) {
      for (let j = i + 1; j < pairs.length; j += 1) {
        if ((pairs[i].a - pairs[j].a) * (pairs[i].b - pairs[j].b) < 0) crossings += 1;
      }
    }
  }
  return crossings;
}

/* ------------------------------------------------------------------------- */
/* Collision-safe id helpers (the materialize slug bugs, fixed in one place)  */
/* ------------------------------------------------------------------------- */

/**
 * The ONE slug function for graph ids. Lowercase, dash-separated, trimmed,
 * max length — used by materialize AND evaluate so a human answer always
 * matches the node it was filed against, however long or odd the source id.
 */
export function slug(value: string, max = 48): string {
  const out =
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max) || 'node';
  return out;
}

/** Short stable hash (FNV-1a, hex) for disambiguating slug collisions. */
export function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

/**
 * Unique node id within `taken`: `base`, or `base-<hash>` on collision.
 * Deterministic for a given insertion order — and collisions are *reported*
 * by returning a different id rather than silently dropping the node.
 */
export function uniqueNodeId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let candidate = `${base}-${shortHash(base)}`;
  let round = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${shortHash(`${base}#${round}`)}`;
    round += 1;
  }
  return candidate;
}

/** Edge id that cannot collide for distinct (from, kind, to) triples. */
export function edgeId(from: string, kind: string, to: string): string {
  return `edge-${slug(from, 40)}-${kind}-${slug(to, 40)}-${shortHash(`${from}\u0000${kind}\u0000${to}`)}`;
}
