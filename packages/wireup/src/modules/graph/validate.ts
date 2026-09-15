/**
 * Graph kernel — structural validation for the Everflow project graph.
 *
 * Everything the old pipeline dropped *silently* is reported here with a
 * stable code: duplicate node/edge ids, edges whose endpoints do not exist,
 * self-loops, cycles (with one concrete path named), and orphan nodes no
 * edge touches. Cycles and missing endpoints are ERRORS (the graph
 * disagrees with the state it projects); orphans and self-loops are
 * WARNINGS (suspicious but renderable).
 *
 * Pure and offline-safe. `pnpm verify:graph` asserts the fixture and
 * synthetic-project graphs are clean; the pass event carries node/edge
 * counts so a silently-shrinking graph would show up in the log.
 */

import type { EverflowGraph } from '@/types/everflow';

import { buildAdjacency, findCycle } from './dag';
import type { GraphIssue, GraphValidationReport } from './types';

export function validateEverflowGraph(graph: EverflowGraph): GraphValidationReport {
  const issues: GraphIssue[] = [];

  const nodeIds = new Set<string>();
  const duplicateNodes = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) duplicateNodes.add(node.id);
    nodeIds.add(node.id);
  }
  for (const id of [...duplicateNodes].sort()) {
    issues.push({ code: 'duplicate_node_id', message: `Duplicate node id "${id}" — the second node overwrites the first.`, nodeId: id });
  }

  const edgeIds = new Set<string>();
  const duplicateEdges = new Set<string>();
  const touched = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) duplicateEdges.add(edge.id);
    edgeIds.add(edge.id);
    const fromOk = nodeIds.has(edge.from);
    const toOk = nodeIds.has(edge.to);
    if (!fromOk || !toOk) {
      const missing = [!fromOk ? `"${edge.from}"` : null, !toOk ? `"${edge.to}"` : null].filter(Boolean).join(' and ');
      issues.push({
        code: 'edge_endpoint_missing',
        message: `Edge "${edge.id}" points at ${missing}, which is not a node — the edge can never render.`,
        edgeId: edge.id,
      });
      continue;
    }
    touched.add(edge.from);
    touched.add(edge.to);
    if (edge.from === edge.to) {
      issues.push({ code: 'self_loop', message: `Edge "${edge.id}" loops "${edge.from}" back onto itself.`, nodeId: edge.from, edgeId: edge.id });
    }
  }
  for (const id of [...duplicateEdges].sort()) {
    issues.push({ code: 'duplicate_edge_id', message: `Duplicate edge id "${id}" — one of the two edges is lost.`, edgeId: id });
  }

  // Cycles (over deduped nodes/edges so one bad id can't mask a real loop).
  const refs = [...nodeIds].map((id, index) => ({ id, index }));
  const edgeRefs = graph.edges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, kind: edge.kind }));
  const cycle = findCycle(refs, buildAdjacency(refs, edgeRefs));
  if (cycle) {
    issues.push({
      code: 'cycle_detected',
      message: `The project graph is not a DAG: ${cycle.path.join(' → ')} loops back on itself.`,
      nodeId: cycle.path[0],
    });
  }

  // Orphans (the intent root is allowed to stand alone pre-expansion).
  for (const id of [...nodeIds].sort()) {
    if (id !== 'ev-intent' && !touched.has(id) && graph.nodes.length > 1) {
      issues.push({ code: 'orphan_node', message: `Node "${id}" is touched by no edge — it floats outside the graph.`, nodeId: id });
    }
  }

  const errors = issues.filter(
    (issue) => issue.code === 'duplicate_node_id' || issue.code === 'duplicate_edge_id' || issue.code === 'edge_endpoint_missing' || issue.code === 'cycle_detected',
  );
  const warnings = issues.filter((issue) => !errors.includes(issue));
  return { ok: errors.length === 0, nodes: graph.nodes.length, edges: graph.edges.length, issues, errors, warnings };
}
