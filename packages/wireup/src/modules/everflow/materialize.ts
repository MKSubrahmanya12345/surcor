/**
 * Everflow — graph materialisation.
 *
 * Projects a `ProjectState` onto an `EverflowGraph` deterministically: same
 * state in, same graph out (stable node ids, so the UI can diff passes).
 * This is what makes the graph "the pipeline's state made visible" — nothing
 * here is invented, and a graph that disagrees with the artifacts is a bug.
 *
 * Node provenance:
 *   intent        ← requirements.goal / prompt
 *   claim         ← requirements.requirements / constraints
 *   assumption    ← requirements.assumptions + intake doubts the user skipped
 *   decision      ← controller pick, library picks, frozen revisions
 *   goal          ← behavioural assertions, validation-clean, artifact set
 *   doubt         ← intake doubts still open
 *   evidence      ← passed validation checks, answered human tasks
 *   task          ← open human-channel tasks (both directions)
 *   artifact      ← code files, diagram, libraries, instructions
 */

import type { EverflowEdge, EverflowGraph, EverflowNode } from '@/types/everflow';
import type { ProjectState } from '@/types/project';

import { nowIso } from '@/lib/validation/time';
// The ONE slug/edge-id implementation (shared with the evaluator, so a human
// answer always matches the node it was filed against, however long the id).
import { edgeId, slug, uniqueNodeId } from '@/modules/graph';

interface NodeSpec {
  id: string;
  kind: EverflowNode['kind'];
  label: string;
  content: string;
  owner: EverflowNode['owner'];
  goal: EverflowNode['goal'];
  file?: EverflowNode['file'];
  ref?: string;
  source: EverflowNode['source'];
  confidence: number | null;
}

function node(spec: NodeSpec, at: string): EverflowNode {
  const goalSatisfied = spec.goal.state === 'satisfied';
  return {
    id: spec.id,
    kind: spec.kind,
    label: spec.label,
    content: spec.content,
    status: spec.kind === 'task' ? 'active' : goalSatisfied ? 'complete' : 'active',
    confidence: spec.confidence,
    owner: spec.owner,
    goal: spec.goal,
    file: spec.file ?? null,
    ref: spec.ref,
    source: spec.source,
    createdAt: at,
    updatedAt: at,
  };
}

export function materializeGraph(state: ProjectState): EverflowGraph {
  const at = nowIso();
  const nodes: EverflowNode[] = [];
  const edges: EverflowEdge[] = [];
  const seen = new Set<string>();

  // `add` returns the final id: on a slug collision the node is kept under
  // a hash-suffixed id instead of being silently dropped (the old `seen`
  // guard lost the node AND left its edges pointing at the wrong twin).
  const add = (spec: NodeSpec): string => {
    const id = uniqueNodeId(spec.id, seen);
    seen.add(id);
    nodes.push(node({ ...spec, id }, at));
    return id;
  };
  const link = (from: string, to: string, kind: EverflowEdge['kind'], note?: string): void => {
    if (from === to) return;
    // The id carries a hash of the full triple: distinct edges can never
    // collide (the old truncated-slug id dropped the second of two long
    // edges sharing a prefix), while the same triple still dedups.
    const id = edgeId(from, kind, to);
    if (edges.some((existing) => existing.id === id)) return;
    edges.push({ id, from, to, kind, ...(note ? { note } : {}) });
  };

  const requirements = state.requirements;
  const revision = Math.max(1, state.revision);

  /* ---------------- intent: the outcome ---------------- */
  const intentId = 'ev-intent';
  add({
    id: intentId,
    kind: 'intent',
    label: state.name,
    content: requirements?.goal || state.prompt,
    owner: 'shared',
    confidence: 1,
    goal: {
      criterion: 'Every goal below is satisfied, or parked behind a named task.',
      kind: 'custom',
      state: 'open',
    },
    source: { origin: requirements ? 'pipeline' : 'intake', stage: 'understanding' },
  });

  /* ---------------- claims: stated requirements ---------------- */
  (requirements?.requirements ?? []).forEach((requirement, index) => {
    const id = `ev-req-${index + 1}`;
    add({
      id,
      kind: 'claim',
      label: `Requirement ${index + 1}`,
      content: requirement,
      owner: 'shared',
      // Model-asserted, not yet proven: 0.85 keeps it under the research
      // threshold, so the agent double-checks brief claims against the docs.
      confidence: 0.85,
      goal: {
        criterion: 'Covered by components, firmware or a named open task.',
        kind: 'requirement_covered',
        checkId: requirement,
        state: 'open',
      },
      source: { origin: 'pipeline', stage: 'understanding' },
    });
    link(intentId, id, 'supports');
  });

  (requirements?.constraints ?? []).forEach((constraint, index) => {
    const id = `ev-constraint-${index + 1}`;
    add({
      id,
      kind: 'claim',
      label: `Constraint ${index + 1}`,
      content: constraint,
      owner: 'shared',
      confidence: 0.85,
      goal: {
        criterion: 'Respected by the design (no validation issue names it).',
        kind: 'requirement_covered',
        checkId: constraint,
        state: 'open',
      },
      source: { origin: 'pipeline', stage: 'understanding' },
    });
    link(intentId, id, 'supports');
  });

  /* ---------------- assumptions: recorded guesses ---------------- */
  (requirements?.assumptions ?? []).forEach((assumption, index) => {
    const id = `ev-assume-${index + 1}`;
    add({
      id,
      kind: 'assumption',
      label: `Assumption ${index + 1}`,
      content: assumption,
      owner: 'shared',
      confidence: 0.4,
      goal: {
        criterion: 'Confirmed or corrected by the human.',
        kind: 'human_confirmed',
        checkId: assumption,
        state: 'open',
      },
      source: { origin: 'pipeline', stage: 'understanding' },
    });
    link(intentId, id, 'supports');
  });

  /* ---------------- intake doubts still open ---------------- */
  for (const doubt of state.doubts) {
    if (doubt.status !== 'open') continue;
    const id = `ev-doubt-${doubt.id}`;
    add({
      id,
      kind: 'doubt',
      label: 'Open question',
      content: doubt.question,
      owner: doubt.decider === 'human' ? 'human' : 'ai',
      confidence: doubt.confidence,
      goal: {
        criterion: 'Answered (by you, by an AI default, or deferred on the record).',
        kind: 'doubt_answered',
        checkId: doubt.id,
        state: 'open',
      },
      ref: doubt.id,
      source: { origin: 'intake' },
    });
    link(intentId, id, 'supports');
  }

  /* ---------------- decisions ---------------- */
  const controller = state.hardwarePlan?.controller;
  if (controller) {
    add({
      id: 'ev-decision-controller',
      kind: 'decision',
      label: 'Controller pick',
      content: `${controller.name} — ${controller.reason}`,
      owner: 'ai',
      confidence: 0.85,
      goal: {
        criterion: 'Stands, unless a human veto lands on this node.',
        kind: 'custom',
        state: 'satisfied',
      },
      ref: controller.componentId,
      source: { origin: 'pipeline', stage: 'hardware' },
    });
    link(intentId, 'ev-decision-controller', 'part_of');
  }

  for (const library of state.softwarePlan?.libraries ?? []) {
    if (library.builtIn) continue;
    const libId = add({
      id: `ev-decision-lib-${slug(library.name)}`,
      kind: 'decision',
      label: `Library: ${library.name}`,
      content: library.purpose || `Required by the firmware (${library.manager}).`,
      owner: 'ai',
      confidence: 0.8,
      goal: {
        criterion: 'Present in libraries.json and used by the code.',
        kind: 'evidence_attached',
        checkId: library.name,
        state: 'open',
      },
      ref: library.name,
      source: { origin: 'pipeline', stage: 'software' },
    });
    link(intentId, libId, 'part_of');
  }

  for (const rev of state.revisions) {
    add({
      id: `ev-decision-rev-${rev.version}`,
      kind: 'decision',
      label: `Revision v${rev.version}`,
      content: rev.summary,
      owner: rev.reason === 'firmware_edit' ? 'shared' : 'ai',
      confidence: 0.9,
      goal: {
        criterion: 'Frozen and diffable against v' + (rev.version - 1 || 0) + '.',
        kind: 'custom',
        state: 'satisfied',
      },
      ref: `v${rev.version}`,
      source: { origin: 'pipeline', stage: rev.stage, revision: rev.version },
    });
    link(intentId, `ev-decision-rev-${rev.version}`, 'part_of');
  }

  /* ---------------- goals ---------------- */
  const assertions = requirements?.behavioralSpec?.assertions ?? [];
  for (const assertion of assertions) {
    const id = add({
      id: `ev-goal-behaviour-${slug(assertion.id)}`,
      kind: 'goal',
      label: `Behaviour: ${assertion.title}`,
      content: `The build must ${assertion.title.toLowerCase()}.`,
      owner: 'shared',
      confidence: 0.6,
      goal: {
        criterion: 'Proven by the behavioural evaluator, or confirmed by a human test.',
        kind: 'behaviour_proven',
        checkId: assertion.id,
        state: 'open',
      },
      ref: assertion.id,
      source: { origin: 'pipeline', stage: 'understanding' },
    });
    link(intentId, id, 'supports');
  }

  add({
    id: 'ev-goal-validation',
    kind: 'goal',
    label: 'Design is clean',
    content: 'No blocking validation issues remain.',
    owner: 'ai',
    confidence: 0.8,
    goal: {
      criterion: 'Validation reports zero blocking issues.',
      kind: 'validation_clean',
      state: 'open',
    },
    source: { origin: 'pipeline', stage: 'validating' },
  });
  link(intentId, 'ev-goal-validation', 'supports');

  const artifacts = state.artifacts;
  add({
    id: 'ev-goal-artifacts',
    kind: 'goal',
    label: 'All artifacts present',
    content: 'Firmware, diagram, libraries and instructions all exist and are in sync.',
    owner: 'ai',
    confidence: 0.8,
    goal: {
      criterion: 'All four artifacts exist for the current revision.',
      kind: 'custom',
      checkId: 'artifact_set',
      state: 'open',
    },
    source: { origin: 'pipeline', stage: 'instructions' },
  });
  link(intentId, 'ev-goal-artifacts', 'supports');

  /* ---------------- artifacts: the workspace files ---------------- */
  for (const file of artifacts.code?.files ?? []) {
    const artId = add({
      id: `ev-art-${slug(file.path)}`,
      kind: 'artifact',
      label: file.path,
      content: file.purpose,
      owner: 'ai',
      confidence: 0.95,
      goal: {
        criterion: 'Exists and compiles against the managed pin map.',
        kind: 'artifact_exists',
        checkId: file.path,
        state: 'open',
      },
      file: { path: file.path },
      source: { origin: 'pipeline', stage: 'code' },
    });
    link(artId, 'ev-goal-artifacts', 'produces');
  }
  if (artifacts.diagram) {
    add({
      id: 'ev-art-diagram',
      kind: 'artifact',
      label: 'wireup-diagram.json',
      content: artifacts.diagram.stats ? `Layout: ${artifacts.diagram.stats.components} component(s), ${artifacts.diagram.stats.connections} connection(s).` : 'Machine-readable wiring diagram.',
      owner: 'ai',
      confidence: 0.95,
      goal: {
        criterion: 'In sync with the wiring plan.',
        kind: 'artifact_exists',
        checkId: 'diagram',
        state: 'open',
      },
      file: { path: 'wireup-diagram.json' },
      source: { origin: 'pipeline', stage: 'diagram' },
    });
    link('ev-art-diagram', 'ev-goal-artifacts', 'produces');
  }
  if (artifacts.libraries) {
    add({
      id: 'ev-art-libraries',
      kind: 'artifact',
      label: 'libraries.json',
      content: `${artifacts.libraries.libraries.length} librar${artifacts.libraries.libraries.length === 1 ? 'y' : 'ies'}.`,
      owner: 'ai',
      confidence: 0.95,
      goal: {
        criterion: 'Matches the software plan.',
        kind: 'artifact_exists',
        checkId: 'libraries',
        state: 'open',
      },
      file: { path: 'libraries.json' },
      source: { origin: 'pipeline', stage: 'libraries' },
    });
    link('ev-art-libraries', 'ev-goal-artifacts', 'produces');
  }
  if (artifacts.instructions) {
    add({
      id: 'ev-art-instructions',
      kind: 'artifact',
      label: 'instructions.md',
      content: `${artifacts.instructions.sections.length} section(s), bill of materials included.`,
      owner: 'ai',
      confidence: 0.95,
      goal: {
        criterion: 'Sections cover the build steps and BOM.',
        kind: 'artifact_exists',
        checkId: 'instructions',
        state: 'open',
      },
      file: { path: 'instructions.md' },
      source: { origin: 'pipeline', stage: 'instructions' },
    });
    link('ev-art-instructions', 'ev-goal-artifacts', 'produces');
  }

  /* ---------------- evidence ---------------- */
  for (const check of state.validation?.checks ?? []) {
    if (check.status !== 'passed') continue;
    const evId = add({
      id: `ev-evidence-${slug(check.id)}`,
      kind: 'evidence',
      label: check.name,
      content: check.message,
      owner: 'ai',
      confidence: 1,
      goal: {
        criterion: 'Evidence is complete by construction.',
        kind: 'custom',
        state: 'satisfied',
      },
      ref: check.id,
      source: { origin: 'pipeline', stage: 'validating' },
    });
    if (check.id.startsWith('behavioral.')) {
      const assertionId = check.id.slice('behavioral.'.length);
      link(evId, `ev-goal-behaviour-${slug(assertionId)}`, 'verified_by');
    } else if (check.domain === 'structure' || check.id.includes('compile')) {
      link(evId, 'ev-goal-validation', 'verified_by');
    }
  }

  for (const task of state.humanTasks) {
    if (task.direction === 'ai_to_human' && task.response) {
      const id = add({
        id: `ev-evidence-task-${task.id}`,
        kind: 'evidence',
        label: `Human answer: ${task.title}`,
        content: `${task.response.value}${task.response.note ? ` — ${task.response.note}` : ''}`,
        owner: 'human',
        confidence: 1,
        goal: {
          criterion: 'Recorded on the project record.',
          kind: 'custom',
          state: 'satisfied',
        },
        ref: task.id,
        source: { origin: 'human' },
      });
      for (const linked of task.linkedNodeIds) {
        link(id, linked, 'verified_by');
      }
    }
  }

  /* ---------------- tasks: the open human channel ---------------- */
  for (const task of state.humanTasks) {
    const open = task.direction === 'ai_to_human' ? task.status === 'open' : task.status === 'open';
    if (!open) continue;
    add({
      id: `ev-task-${task.id}`,
      kind: 'task',
      label: task.title,
      content: task.body,
      owner: task.direction === 'ai_to_human' ? 'human' : 'ai',
      confidence: null,
      goal: {
        criterion:
          task.direction === 'ai_to_human'
            ? 'Answered by the human.'
            : 'Processed by the agent (registered + follow-up filed).',
        kind: 'custom',
        state: 'open',
      },
      ref: task.id,
      source: { origin: task.direction === 'ai_to_human' ? 'continuation' : 'human' },
    });
    link(intentId, `ev-task-${task.id}`, 'supports');
    for (const linked of task.linkedNodeIds) {
      link(`ev-task-${task.id}`, linked, 'supports');
    }
  }

  /* ---------------- idea graph: the decomposition subtree ------------------
   * Persisted idea-graph nodes (subsystem / test_result / review) join the
   * projected graph so the UI watches one tree. The graph stays a pure
   * projection: these nodes ARE project state (state.ideaGraph), re-rendered
   * on every pass, never mutated here. Breaking this loop must never break
   * the build — hence the defensive shape checks.
   */
  const ideaGraph = state.ideaGraph;
  if (ideaGraph && Array.isArray(ideaGraph.nodes)) {
    for (const ideaNode of ideaGraph.nodes) {
      if (!ideaNode || typeof ideaNode.id !== 'string' || seen.has(ideaNode.id)) continue;
      seen.add(ideaNode.id);
      nodes.push(ideaNode);
    }
    for (const edge of ideaGraph.edges ?? []) {
      if (!edge || typeof edge.id !== 'string') continue;
      if (edges.some((existing) => existing.id === edge.id)) continue;
      if (!seen.has(edge.from) || !seen.has(edge.to)) continue;
      edges.push(edge);
    }
  }

  /* ---------------- research: the agent's cited documentation findings ----
   * AFTER the idea merge: findings may target subsystem nodes, which did
   * not exist yet when this block ran earlier (the finding was skipped).
   */
  for (const finding of state.research) {
    const target = nodes.find((node) => node.id === finding.nodeId);
    if (!target) continue;
    const id = add({
      id: `ev-research-${finding.id}`,
      kind: 'evidence',
      label: `Checked docs: ${target.label}`,
      content: finding.facts.slice(0, 3).join(' ') + (finding.facts.length > 3 ? ' …' : ''),
      owner: 'ai',
      confidence: finding.confidence,
      goal: {
        criterion: 'Citation recorded; informs — does not satisfy on its own.',
        kind: 'custom',
        state: 'satisfied',
      },
      ref: finding.id,
      source: { origin: 'research', stage: finding.title },
    });
    link(id, finding.nodeId, 'verified_by');
    if (finding.needsHumanCheck) {
      link(intentId, id, 'supports');
    }
  }

  return { projectId: state.id, nodes, edges, updatedAt: at };
}
