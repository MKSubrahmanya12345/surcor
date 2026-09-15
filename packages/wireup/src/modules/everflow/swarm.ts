/**
 * Idea graph — execution swarm over the frozen graph.
 *
 * After the reviewer passes, subtrees are assigned to role agents:
 *
 *   hardware-swarm  → POWER / DRIVE / SENSING (+ steering, outputs)
 *   firmware-swarm  → BRAIN / SAFETY
 *   web-swarm       → CONTROL LINK (the dashboard half)
 *   mechanics-swarm → STRUCTURE (notes + instructions for MVP; CAD is gated)
 *
 * The roles are PLANNING LABELS + per-role model overrides, not a new
 * runtime: with one model configured every role runs sequentially under the
 * same pass loop — the value is subtree ownership and per-node tests, not
 * parallelism. Parallelism is allowed only where the store tolerates
 * concurrent stage writes; until that is proven, `execution` is always
 * 'sequential' (and the record says so).
 *
 * HARD RULE: agents communicate ONLY through the graph — satisfied goals,
 * test_result nodes, decisions. There is no agent-to-agent channel in this
 * module: the move takes no messaging input and writes no messages, and any
 * cross-subtree conflict (two roles wanting pin 9) is decided by the
 * deterministic pin/wiring planners, never by model negotiation.
 */

import type { IdeaGraphState, StakeLevel, SubsystemClass, SwarmAssignment, SwarmRole } from '@/types/everflow';
import type { ProjectState } from '@/types/project';

import { env } from '@/lib/validation/env';
import { nowIso } from '@/lib/validation/time';

import { leavesOf, subtreeOf, subtreeTestedVerdict } from './decompose';

/* ------------------------------------------------------------------------- */
/* Assignment                                                                 */
/* ------------------------------------------------------------------------- */

/** The 1:1 map from subsystem class to owning swarm (the spec's partition). */
export const SWARM_BY_CLASS: Record<SubsystemClass, SwarmRole> = {
  POWER: 'hardware-swarm',
  DRIVE: 'hardware-swarm',
  SENSING: 'hardware-swarm',
  STEERING: 'hardware-swarm',
  OUTPUT: 'hardware-swarm',
  BRAIN: 'firmware-swarm',
  SAFETY: 'firmware-swarm',
  CONTROL_LINK: 'web-swarm',
  STRUCTURE: 'mechanics-swarm',
  OTHER: 'hardware-swarm',
};

export const SWARM_ROLE_ORDER: SwarmRole[] = ['hardware-swarm', 'firmware-swarm', 'web-swarm', 'mechanics-swarm'];

export function roleForClass(cls: SubsystemClass | undefined): SwarmRole {
  return SWARM_BY_CLASS[cls ?? 'OTHER'];
}

/** Which model a role would call (override → validation → main); null = none. */
export function modelForRole(role: SwarmRole): string | null {
  const config = env();
  const override =
    role === 'hardware-swarm'
      ? config.agent.swarmRoleModels.hardware
      : role === 'firmware-swarm'
        ? config.agent.swarmRoleModels.firmware
        : role === 'web-swarm'
          ? config.agent.swarmRoleModels.web
          : config.agent.swarmRoleModels.mechanics;
  return override ?? config.bedrock.validationModelId ?? config.bedrock.modelId ?? null;
}

/**
 * Assign every L1 subsystem subtree to its role. Pure: graph in, assignments
 * out — the assignment is a fact about the graph, not a negotiation.
 */
export function assignSwarms(ideaGraph: IdeaGraphState, state: ProjectState): SwarmAssignment[] {
  const roots = ideaGraph.nodes.filter((node) => node.kind === 'subsystem' && (node.level ?? 1) === 1);
  const assignments: SwarmAssignment[] = [];
  for (const role of SWARM_ROLE_ORDER) {
    const owned = roots.filter((node) => roleForClass(node.subsystemClass) === role);
    if (owned.length === 0) continue;
    const nodeIds = owned.flatMap((root) => [root.id, ...subtreeOf(ideaGraph, root.id).map((node) => node.id)]);
    assignments.push({
      role,
      subtreeRootId: owned[0].id,
      nodeIds,
      execution: 'sequential',
      modelId: modelForRole(role),
      completed: false,
      completedAt: null,
    });
    // A role may own several roots; keep them in one assignment's node list
    // but point the record at each root via the node list itself.
    if (owned.length > 1) assignments[assignments.length - 1].subtreeRootId = owned[0].id;
  }
  // Stamp the owning role onto every node (the UI colours by it).
  for (const assignment of assignments) {
    for (const id of assignment.nodeIds) {
      const node = ideaGraph.nodes.find((candidate) => candidate.id === id);
      if (node) node.swarmRole = assignment.role;
    }
  }
  void state; // the assignment is graph-only by construction (see header)
  return assignments;
}

/* ------------------------------------------------------------------------- */
/* The swarm move                                                             */
/* ------------------------------------------------------------------------- */

export interface SwarmMoveResult {
  ideaGraph: IdeaGraphState;
  events: {
    type: 'idea_graph_swarm';
    status: 'completed' | 'info';
    message: string;
    metadata: Record<string, unknown>;
  }[];
  description: string[];
  moved: boolean;
}

/**
 * One swarm move per pass, in SWARM_ROLE_ORDER:
 *   1. no assignments yet → assign (frozen graph becomes the contract);
 *   2. else verify the next incomplete role's subtree THROUGH THE GRAPH —
 *      every leaf has a run verdict and no subsystem goal is failing — and
 *      mark it complete with a summary.
 * When all roles are complete, the graph is done.
 */
export function swarmMove(state: ProjectState): SwarmMoveResult {
  const at = nowIso();
  const ideaGraph: IdeaGraphState = state.ideaGraph ?? { rootId: 'ev-intent', nodes: [], edges: [], phase: 'swarming', expansions: 0, deadExpansions: 0, expansionPaused: false, pausedReason: null, reviewer: null, swarms: null };
  const result: SwarmMoveResult = { ideaGraph, events: [], description: [], moved: false };

  const openAskNodeIds = new Set(state.humanTasks.filter((task) => task.status === 'open').flatMap((task) => task.linkedNodeIds));

  if (!ideaGraph.swarms) {
    ideaGraph.swarms = assignSwarms(ideaGraph, state);
    result.events.push({
      type: 'idea_graph_swarm',
      status: 'completed',
      message: `Swarm assigned over the frozen graph: ${ideaGraph.swarms.map((assignment) => `${assignment.role} (${assignment.nodeIds.length} node(s)${assignment.modelId ? `, model ${assignment.modelId}` : ', no model — deterministic'})`).join('; ')}. Sequential by default — the value is subtree ownership, not parallelism.`,
      metadata: {
        kind: 'idea_graph.swarm',
        assignment: ideaGraph.swarms.map((assignment) => ({ role: assignment.role, nodes: assignment.nodeIds.length, execution: assignment.execution, modelId: assignment.modelId })),
      },
    });
    result.description.push(`Assigned ${ideaGraph.swarms.length} swarm role(s).`);
    result.moved = true;
    return result;
  }

  const next = ideaGraph.swarms.find((assignment) => !assignment.completed);
  if (!next) {
    if (ideaGraph.phase === 'swarming') {
      ideaGraph.phase = 'done';
      result.description.push('Every swarm subtree complete.');
      result.moved = true;
    }
    return result;
  }

  /* Verify the role's subtree THROUGH THE GRAPH ONLY. */
  const roots = ideaGraph.nodes.filter((node) => node.kind === 'subsystem' && (node.level ?? 1) === 1 && roleForClass(node.subsystemClass) === next.role);
  const problems: string[] = [];
  for (const root of roots) {
    const verdict = subtreeTestedVerdict(ideaGraph, root.id, openAskNodeIds);
    if (verdict.state !== 'satisfied') problems.push(`${root.label}: ${verdict.evidence}`);
  }
  const untestedTests = next.nodeIds
    .map((id) => ideaGraph.nodes.find((node) => node.id === id))
    .filter((node): node is NonNullable<typeof node> => Boolean(node))
    .filter((node) => node.kind === 'subsystem' && (!node.testSpec || node.testSpec.status === 'untested'));

  if (problems.length === 0 && untestedTests.length === 0) {
    next.completed = true;
    next.completedAt = at;
    next.summary = `Subtree verified through the graph: ${roots.length} root(s), ${next.nodeIds.length} node(s), every leaf tested.`;
    result.events.push({
      type: 'idea_graph_swarm',
      status: 'completed',
      message: `${next.role}: subtree complete — ${next.summary}`,
      metadata: { kind: 'idea_graph.swarm', role: next.role, completed: true, nodes: next.nodeIds.length, modelId: next.modelId },
    });
    result.description.push(`${next.role} complete.`);
  } else {
    next.summary = `Subtree NOT complete — the graph says: ${[...problems, ...untestedTests.map((node) => `${node.label} untested`)].join(' | ')}`;
    result.events.push({
      type: 'idea_graph_swarm',
      status: 'info',
      message: `${next.role}: subtree incomplete — ${next.summary}`,
      metadata: { kind: 'idea_graph.swarm', role: next.role, completed: false, problems: problems.length + untestedTests.length },
    });
    result.description.push(`${next.role} blocked on its own subtree facts.`);
  }
  result.moved = true;
  return result;
}

/** Stake report for the dashboard: which risk-gated subtrees are still unproven. */
export function riskGatedReport(ideaGraph: IdeaGraphState): { node: string; label: string; stakes: StakeLevel; tested: boolean }[] {
  return ideaGraph.nodes
    .filter((node) => node.kind === 'subsystem' && node.stakes === 'risk_gated')
    .map((node) => ({ node: node.id, label: node.label, stakes: node.stakes ?? 'normal', tested: leavesOf(ideaGraph, node.id).every((leaf) => leaf.testSpec && leaf.testSpec.status === 'passed') }));
}
