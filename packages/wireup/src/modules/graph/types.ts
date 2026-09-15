/**
 * Graph kernel — shared view types.
 *
 * The kernel works over small structural views (`GraphNodeRef` /
 * `GraphEdgeRef`) so the DAG utilities, validator and layout stay generic:
 * the Everflow adapters in `layout.ts` / `validate.ts` project the real
 * `EverflowGraph` onto these views and map the results back. Nothing here
 * imports project state — the kernel is pure and offline-safe.
 */

export interface GraphNodeRef {
  id: string;
  /** Stable sort key inside a layer (insertion order upstream). */
  index: number;
}

export interface GraphEdgeRef {
  id: string;
  from: string;
  to: string;
  kind: string;
}

export interface TopoSortResult {
  /** Node ids in topological order (stable: ties broken by `index`, then id). */
  order: string[];
  /** True when every node could be ordered (i.e. the graph is acyclic). */
  acyclic: boolean;
  /** Node ids left unordered because they sit on (or downstream of) a cycle. */
  cyclic: string[];
}

export interface CycleInfo {
  /** One concrete cycle, as node ids in traversal order (first == last). */
  path: string[];
}

export interface LayerAssignment {
  /** Node id → layer number (0-based, left to right). */
  layerOf: Map<string, number>;
  /** Layers in order; each layer holds node ids in display order. */
  layers: string[][];
  /** Deepest layer index. */
  maxLayer: number;
}

export type GraphIssueCode =
  | 'duplicate_node_id'
  | 'duplicate_edge_id'
  | 'edge_endpoint_missing'
  | 'self_loop'
  | 'cycle_detected'
  | 'orphan_node';

export interface GraphIssue {
  code: GraphIssueCode;
  /** Human sentence, shown verbatim in the verifier / health output. */
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface GraphValidationReport {
  ok: boolean;
  nodes: number;
  edges: number;
  issues: GraphIssue[];
  /** Errors fail the gate; warnings are reported but pass. */
  errors: GraphIssue[];
  warnings: GraphIssue[];
}
