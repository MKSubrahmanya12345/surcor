/**
 * Graph kernel — Sugiyama layered layout for the Everflow project graph.
 *
 * Pipeline: layer assignment (kind-pinned where the domain demands columns,
 * longest-path from the roots everywhere else) → barycenter crossing
 * minimization → coordinate assignment (top-anchored rows, so appending a
 * node never shifts the nodes above it).
 *
 * This replaces the old fixed-column stacking, which (a) piled every
 * subsystem/test/review node into one column, (b) drew back-edges with a
 * forward-only curve, and (c) re-centered every column on each poll so the
 * canvas jittered whenever a node was added. Same graph in, same pixels
 * out — and *appending* a node only extends its layer downward.
 */

import type { EverflowEdge, EverflowGraph, EverflowNode, EverflowNodeKind } from '@/types/everflow';

import { assignLayers, buildAdjacency, minimizeCrossings, topoSort } from './dag';
import type { LayerAssignment } from './types';

export interface PlacedNode {
  node: EverflowNode;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  /** Position inside the layer (0-based display order). */
  order: number;
}

export interface PlacedEdge {
  edge: EverflowEdge;
  path: string;
  kind: EverflowEdge['kind'];
  /** True when the edge runs right-to-left (drawn as a return curve). */
  reversed: boolean;
}

export interface GraphLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
  layers: number;
  assignment: LayerAssignment;
}

export const NODE_WIDTH = 172;
export const NODE_HEIGHT = 58;
const COLUMN_WIDTH = 190;
const COLUMN_GAP = 70;
const VERTICAL_GAP = 18;
const PADDING = 24;

/**
 * Domain columns — EVERY kind pins to a reading-order layer (`null` is kept
 * for future kinds, which fall back to longest-path layering). The old
 * layout pinned only some kinds, so every subsystem/test/review node fell
 * through into one giant stack; here the idea subtree fans out by level
 * (L1 → L2 → L3+) between the goals and the evidence.
 *
 * Proof edges (artifact → goal, evidence → goal, test → subsystem) run
 * right-to-left by construction and render as return curves under the
 * nodes — the arrow always shows the TRUE stored direction.
 */
function pinLayerFor(kind: EverflowNodeKind, level?: number): number | null {
  switch (kind) {
    case 'intent':
      return 0;
    case 'claim':
    case 'assumption':
    case 'doubt':
      return 1;
    case 'goal':
      return 2;
    case 'subsystem':
      return 3 + Math.min(Math.max((level ?? 1) - 1, 0), 2); // L1→3, L2→4, L3+→5
    case 'artifact':
      return 4;
    case 'decision':
      return 5;
    case 'evidence':
    case 'test_result':
    case 'review':
      return 6;
    case 'task':
      return 7;
    default:
      return null;
  }
}

export function layoutGraph(graph: EverflowGraph): GraphLayout {
  const nodes = graph.nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const refs = nodes.map((node, index) => ({ id: node.id, index }));
  const edgeRefs = graph.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, kind: edge.kind }));

  const adjacency = buildAdjacency(refs, edgeRefs);
  const topo = topoSort(refs, adjacency);
  const pinned = assignLayers(refs, adjacency, topo, (id) => {
    const node = byId.get(id);
    return node ? pinLayerFor(node.kind, node.level) : null;
  });
  const ordered = minimizeCrossings(pinned.layers, adjacency);
  const assignment: LayerAssignment = { ...pinned, layers: ordered };

  // Compact layer indices: pinned layers (0,1,8) must not leave empty gaps,
  // but the *relative* order of layers is preserved.
  const used = ordered.map((layer, index) => ({ layer, index })).filter((entry) => entry.layer.length > 0);
  const columnOf = new Map<number, number>();
  used.forEach((entry, column) => columnOf.set(entry.index, column));

  const columnX = (column: number): number => PADDING + column * (COLUMN_WIDTH + COLUMN_GAP);

  // Top-anchored rows: a layer's nodes start at PADDING and grow downward,
  // so appending a node extends the layer without moving its siblings.
  const placed = new Map<string, PlacedNode>();
  used.forEach((entry) => {
    const column = columnOf.get(entry.index)!;
    entry.layer.forEach((id, order) => {
      const node = byId.get(id)!;
      placed.set(id, {
        node,
        x: columnX(column),
        y: PADDING + order * (NODE_HEIGHT + VERTICAL_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        layer: entry.index,
        order,
      });
    });
  });

  const columns = Math.max(1, used.length);
  const rows = Math.max(1, ...used.map((entry) => entry.layer.length));
  const width = PADDING * 2 + columns * COLUMN_WIDTH + (columns - 1) * COLUMN_GAP;
  const height = PADDING * 2 + rows * NODE_HEIGHT + (rows - 1) * VERTICAL_GAP;

  const edges: PlacedEdge[] = [];
  for (const edge of graph.edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) continue; // dangling endpoint: the validator reports it
    edges.push({ edge, kind: edge.kind, reversed: from.x >= to.x, path: edgePath(from, to) });
  }

  // Stable node order: by layer, then display order (insertion order inside
  // a layer is preserved by the barycenter ties, so polls don't reshuffle).
  const placedNodes = [...placed.values()].sort((a, b) => (a.layer === b.layer ? a.order - b.order : a.layer - b.layer));

  return { nodes: placedNodes, edges, width, height, layers: columns, assignment };
}

function edgePath(from: PlacedNode, to: PlacedNode): string {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + to.height / 2;

  if (x1 <= x2) {
    // Forward edge: horizontal bezier between the facing sides.
    const bend = Math.max(36, Math.abs(x2 - x1) * 0.4);
    return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
  }
  // Back edge (artifact → goal, evidence → goal, review → root): route UNDER
  // the nodes as a return curve instead of doubling back over them.
  const drop = 26 + Math.min(60, Math.abs(y2 - y1) * 0.25);
  const lowY = Math.max(from.y + from.height, to.y + to.height) + drop;
  const startX = from.x + from.width / 2;
  const endX = to.x + to.width / 2;
  return `M ${startX} ${from.y + from.height} C ${startX} ${lowY}, ${endX} ${lowY}, ${endX} ${to.y + to.height}`;
}
