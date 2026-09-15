/**
 * Idea graph — the per-node test ladder + repair/escalation.
 *
 * Six rungs, cheapest first: catalog → electrical → compile → behavioral →
 * rooting → human-verify. The ladder does NOT reinvent any checker: it wires
 * the EXISTING machinery per node — the validator's deterministic checks
 * (`power.budget`, `code.compile`, `code.firmware` with the rooting gate's
 * outcome, `components.selection`, `pins.assignments`, `wiring.graph`),
 * the behavioural evaluator, and the human verify asks — instead of running
 * them only globally.
 *
 * Every leaf runs its test once the build produces it.
 *   fail   ⇒ targeted fix of THAT node only (the existing deterministic
 *            fixer, never a regenerate) ⇒ re-test;
 *   still failing after WIREUP_IDEA_GRAPH_MAX_NODE_REPAIRS ⇒ escalate: one
 *            left-drawer ask (choose, default-on-expiry `defer`) carrying
 *            the failing assertion, what was tried, and a proposal.
 *
 * Every run/verdict emits an `idea_graph_test` event and materialises a
 * test_result node with a `verified_by` edge, so a node repaired twice and
 * passing is visibly different from a first-try pass.
 */

import type { EverflowNode, IdeaGraphState, NodeTestSpec } from '@/types/everflow';
import type { ComponentDefinition } from '@/types/component';
import type { ProjectState, ProjectRevision } from '@/types/project';
import type { ValidationResult } from '@/types/validation';

import { describeError, logger } from '@/lib/logging/logger';
import { nowIso } from '@/lib/validation/time';

import { evaluateBehavioral } from '@/modules/behaviour-evaluator';
import { summariseIssues } from '@/modules/validator/rules';
import { validateProject } from '@/modules/validator';
import { fixProject } from '@/modules/fixer';
import { buildRefreshers } from '@/modules/orchestrator/context';
import { understandPrompt } from '@/modules/project-understanding';
import { appendRevision, createRevision } from '@/modules/orchestrator/revisions';

/* ------------------------------------------------------------------------- */
/* The rungs                                                                  */
/* ------------------------------------------------------------------------- */

const RUNG_CHECK: Record<NodeTestSpec['rung'], string | null> = {
  catalog: null, // resolved per node (part presence or a named check)
  electrical: 'power.budget',
  compile: 'code.compile',
  behavioral: null, // the behavioural evaluator runs per assertion
  rooting: 'code.firmware',
  human_verify: null, // a human ask is the test
};

function checkVerdict(state: ProjectState, checkId: string): { verdict: 'passed' | 'failed' | 'blocked_human'; message: string } {
  const check = state.validation?.checks.find((entry) => entry.id === checkId);
  if (!check) {
    return { verdict: 'blocked_human', message: `Validation has not produced a "${checkId}" check yet.` };
  }
  if (check.status === 'passed') return { verdict: 'passed', message: check.message };
  if (check.status === 'failed') return { verdict: 'failed', message: check.message };
  return { verdict: 'blocked_human', message: `${checkId} could not run: ${check.message}` };
}

/** The behavioural evaluator, run for THIS node's assertion only. */
function behavioralVerdict(state: ProjectState, node: EverflowNode): { verdict: 'passed' | 'failed' | 'blocked_human'; message: string } {
  const assertionId = node.testSpec?.checkId ?? node.ref ?? '';
  if (!state.requirements?.behavioralSpec?.assertions.length) {
    return { verdict: 'blocked_human', message: 'No behavioural spec was derived, so nothing can be asserted statically.' };
  }
  const report = evaluateBehavioral({
    requirements: state.requirements,
    code: state.artifacts.code,
    pinAssignments: state.pinAssignments,
    selections: state.components,
  });
  const check = report.checks.find((entry) => entry.assertionId === assertionId);
  if (!check) {
    return { verdict: 'blocked_human', message: `No behavioural check named "${assertionId}" ran (available: ${report.checks.map((entry) => entry.assertionId).join(', ') || 'none'}).` };
  }
  if (check.status === 'passed') return { verdict: 'passed', message: `${check.title}: ${check.actual} (mode ${check.mode}).` };
  if (check.status === 'failed') return { verdict: 'failed', message: `${check.title}: expected ${check.expected}, got ${check.actual}.` };
  return { verdict: 'blocked_human', message: `${check.title} ${check.status}: ${check.failure ?? 'needs a run'}.` };
}

/** The catalog rung: the node's part (or named check) must be real. */
function catalogVerdict(state: ProjectState, node: EverflowNode): { verdict: 'passed' | 'failed' | 'blocked_human'; message: string } {
  const spec = node.testSpec;
  // A named validator check (pins.assignments, wiring.graph, instructions.completeness…)
  if (spec?.checkId && spec.checkId.includes('.')) {
    return checkVerdict(state, spec.checkId);
  }
  // A part reference: real only if actually selected from the catalog.
  const ref = node.ref ?? spec?.checkId;
  if (ref) {
    const selection = state.components.find((entry) => entry.componentId === ref);
    if (selection) return { verdict: 'passed', message: `${selection.name} is selected (×${selection.quantity}, source ${selection.source}).` };
    return { verdict: 'failed', message: `${ref} is not in the component selection — the realization is missing.` };
  }
  // Otherwise the node's realization is the artifact set.
  const check = checkVerdict(state, 'components.selection');
  return check;
}

/** The human_verify rung: a real ask, answered positively — or parked honestly. */
function humanVerifyVerdict(state: ProjectState, node: EverflowNode): { verdict: 'passed' | 'failed' | 'blocked_human'; message: string } {
  const linked = state.humanTasks.filter((task) => node.id && task.linkedNodeIds.includes(node.id));
  const answered = linked.find((task) => task.status === 'answered' && task.response);
  const positives = new Set(['yes', 'true', 'ok', 'okay', 'confirmed', 'correct', 'confirmed, as-is', 'good', 'y', 'yes, it works', 'accepted', 'accepted as-is']);
  if (answered) {
    const value = answered.response!.value.trim().toLowerCase();
    const positive = positives.has(value) || /^yes\b/.test(value) || /^apply\b/.test(value);
    return positive
      ? { verdict: 'passed', message: `Human confirmed: "${answered.response!.value}".` }
      : { verdict: 'failed', message: `Human says not yet: "${answered.response!.value}".` };
  }
  const open = linked.find((task) => task.status === 'open');
  if (open) return { verdict: 'blocked_human', message: `Parked behind the open ask "${open.title}" (default on expiry: ${open.defaultOnExpiry}).` };
  return { verdict: 'blocked_human', message: 'No verify ask exists yet — the ladder files one.' };
}

/** Run ONE node's test. Deterministic, offline-safe, honest about skips. */
export function runNodeTest(state: ProjectState, node: EverflowNode): { verdict: 'passed' | 'failed' | 'blocked_human'; message: string } {
  const spec = node.testSpec;
  if (!spec || !spec.assertion) {
    return { verdict: 'failed', message: 'No test is attached to this node — the testability floor (R1) was bypassed.' };
  }
  switch (spec.rung) {
    case 'catalog':
      return catalogVerdict(state, node);
    case 'electrical':
      return checkVerdict(state, RUNG_CHECK.electrical!);
    case 'compile':
      return checkVerdict(state, RUNG_CHECK.compile!);
    case 'behavioral':
      return behavioralVerdict(state, node);
    case 'rooting':
      // The rooting gate runs inside codegen; its outcome is carried by the
      // firmware-correctness check (managed pin map authoritative).
      return checkVerdict(state, RUNG_CHECK.rooting!);
    case 'human_verify':
      return humanVerifyVerdict(state, node);
    default:
      return { verdict: 'blocked_human', message: `Unknown rung on this node.` };
  }
}

/* ------------------------------------------------------------------------- */
/* Targeted repair                                                            */
/* ------------------------------------------------------------------------- */

/** The issues that belong to THIS node (by rung check / assertion id). */
function issuesForNode(state: ProjectState, node: EverflowNode): string[] {
  const spec = node.testSpec;
  if (!state.validation) return [];
  const issueIds: string[] = [];
  const collectCheck = (checkId: string): void => {
    const check = state.validation?.checks.find((entry) => entry.id === checkId);
    if (check) issueIds.push(...check.issueIds);
  };
  switch (spec?.rung) {
    case 'electrical':
      collectCheck('power.budget');
      break;
    case 'compile':
      collectCheck('code.compile');
      break;
    case 'rooting':
      collectCheck('code.firmware');
      break;
    case 'behavioral': {
      const assertionId = spec.checkId ?? node.ref ?? '';
      issueIds.push(...state.validation.issues.filter((issue) => issue.id === `behavioral.${assertionId}`).map((issue) => issue.id));
      break;
    }
    case 'catalog':
      if (spec.checkId && spec.checkId.includes('.')) collectCheck(spec.checkId);
      else collectCheck('components.selection');
      break;
    default:
      break;
  }
  return issueIds;
}

export interface LadderRepairOutcome {
  state: ProjectState;
  repaired: boolean;
  unresolvedReason: string | null;
  revisionCreated: boolean;
}

/**
 * Targeted fix of ONE node's failing test using the existing deterministic
 * fixer — never a regenerate, never touching sibling nodes' issues.
 */
export async function repairNode(state: ProjectState, node: EverflowNode, catalog: ComponentDefinition[]): Promise<LadderRepairOutcome> {
  const issueIds = new Set(issuesForNode(state, node));
  if (issueIds.size === 0 || !state.validation) {
    return { state, repaired: false, unresolvedReason: 'no deterministic issue is attributed to this node', revisionCreated: false };
  }
  const issues = state.validation.issues.filter((issue) => issueIds.has(issue.id));
  if (issues.length === 0) {
    return { state, repaired: false, unresolvedReason: 'the failing check carries no repairable issue objects', revisionCreated: false };
  }

  const scopedValidation: ValidationResult = {
    ...state.validation,
    issues,
    summary: { ...state.validation.summary, ...summariseIssues(issues) },
    passed: false,
  };

  const nextRevision = state.revision + 1;
  try {
    const analysis = understandPrompt(state.prompt).analysis;
    const refreshers = buildRefreshers({ catalog, baseline: state, analysis });
    const fix = await fixProject({
      project: { ...state, revision: nextRevision, status: 'fixing', stage: 'fixing' },
      validation: scopedValidation,
      catalog,
      catalogContext: '',
      mcuContext: '',
      iteration: node.repairCount ?? 0,
      enableLlmFixer: false, // the ladder's first repair is always deterministic
      refresh: refreshers,
    });

    const repaired = fix.result.applied.length > 0;
    let nextState: ProjectState = fix.project;
    let revisionCreated = false;
    if (repaired) {
      const revision: ProjectRevision = createRevision({
        project: fix.project,
        version: nextRevision,
        reason: 'targeted_fix',
        summary: `Idea-graph repair of "${node.label}" (attempt ${(node.repairCount ?? 0) + 1}): ${fix.result.applied.length} change(s) applied.`,
        changes: fix.result.changes,
        addressedIssueIds: issues.map((issue) => issue.id),
        validation: scopedValidation,
        stage: 'fixing',
      });
      nextState = { ...fix.project, revisions: appendRevision(fix.project, revision), revision: nextRevision };
      revisionCreated = true;
    }

    // Re-validate deterministically so the re-test sees fresh checks.
    if (repaired) {
      const fresh = await validateProject({
        project: nextState,
        catalog,
        catalogContext: '',
        mcuContext: '',
        iteration: 0,
        enableModelReview: false,
      });
      nextState = { ...nextState, validation: fresh.result };
    }

    return {
      state: nextState,
      repaired,
      unresolvedReason: repaired ? null : (fix.unresolved[0]?.reason ?? 'the fixer applied nothing'),
      revisionCreated,
    };
  } catch (error) {
    logger.warn({ err: describeError(error).message, node: node.id }, 'idea-graph node repair failed');
    return { state, repaired: false, unresolvedReason: describeError(error).message, revisionCreated: false };
  }
}

/* ------------------------------------------------------------------------- */
/* The ladder move                                                            */
/* ------------------------------------------------------------------------- */

export interface LadderMoveResult {
  ideaGraph: IdeaGraphState;
  state: ProjectState;
  events: {
    type: 'idea_graph_test';
    status: 'completed' | 'info' | 'failed';
    message: string;
    metadata: Record<string, unknown>;
  }[];
  /** Human asks to file (verify parks + escalations), already idempotent-filtered. */
  newTasks: {
    type: 'verify' | 'choose';
    title: string;
    body: string;
    linkedNodeId: string;
    defaultOnExpiry: 'defer' | 'halt';
    assumptionIfSkipped: string;
    shape: 'boolean' | 'choice';
    options?: string[];
  }[];
  description: string[];
  moved: boolean;
}

export interface LadderMoveOptions {
  catalog: ComponentDefinition[];
  maxRepairs: number;
}

function testResultNode(partial: {
  id: string;
  node: EverflowNode;
  attempt: number;
  verdict: 'passed' | 'failed' | 'blocked_human';
  message: string;
  at: string;
}): EverflowNode {
  return {
    id: partial.id,
    kind: 'test_result',
    label: `${partial.node.label} · test #${partial.attempt} · ${partial.verdict}`,
    content: partial.message,
    status: 'complete',
    confidence: partial.verdict === 'passed' ? 1 : partial.verdict === 'failed' ? 0.95 : 0.6,
    owner: 'ai',
    goal: { criterion: 'Test record — complete by construction.', kind: 'custom', state: 'satisfied' },
    file: null,
    source: { origin: 'ladder', stage: 'idea-graph' },
    parentId: partial.node.id,
    level: (partial.node.level ?? 1) + 1,
    subsystemClass: partial.node.subsystemClass,
    swarmRole: partial.node.swarmRole,
    createdAt: partial.at,
    updatedAt: partial.at,
  };
}

/** Leaves (and strategic stops) that still owe a test run. */
export function pendingTestNodes(ideaGraph: IdeaGraphState): EverflowNode[] {
  const parents = new Set(ideaGraph.nodes.map((node) => node.parentId ?? ''));
  return ideaGraph.nodes.filter(
    (node) =>
      node.kind === 'subsystem' &&
      !parents.has(node.id) && // no children → leaf
      node.testSpec &&
      (node.testSpec.status === 'untested' || node.testSpec.status === 'failed' || node.testSpec.status === 'blocked_human'),
  );
}

/**
 * Run ONE ladder move: test every owing leaf, repair+re-test failures within
 * budget, escalate the stubborn ones. Pure in `state` apart from the injected
 * catalog; every verdict lands on the node, in an event and in a test_result.
 */
export async function testLadderMove(state: ProjectState, options: LadderMoveOptions): Promise<LadderMoveResult> {
  const at = nowIso();
  const ideaGraph: IdeaGraphState = state.ideaGraph ?? { rootId: 'ev-intent', nodes: [], edges: [], phase: 'testing', expansions: 0, deadExpansions: 0, expansionPaused: false, pausedReason: null, reviewer: null, swarms: null };
  const result: LadderMoveResult = { ideaGraph, state, events: [], newTasks: [], description: [], moved: false };
  if (!ideaGraph.nodes.some((node) => node.kind === 'subsystem')) {
    return result; // nothing to test yet
  }

  const taken = new Set(ideaGraph.nodes.map((node) => node.id));
  let working: ProjectState = state;
  let repairedAny = false;

  for (const leaf of pendingTestNodes(ideaGraph)) {
    const spec = leaf.testSpec!;
    const priorAttempts = leaf.repairCount ?? 0;
    const attempt = priorAttempts + 1;

    let outcome = runNodeTest(working, leaf);

    /* fail ⇒ targeted repair of this node only ⇒ re-test, within budget. */
    let escalationReason: string | null = null;
    if (outcome.verdict === 'failed' && priorAttempts < options.maxRepairs) {
      const repair = await repairNode(working, leaf, options.catalog);
      working = repair.state;
      repairedAny = repairedAny || repair.repaired;
      leaf.repairCount = attempt;
      const retest = runNodeTest(working, leaf);
      outcome =
        retest.verdict === 'passed'
          ? { verdict: 'passed', message: `${retest.message} (passed after ${attempt} repair(s).)` }
          : { verdict: retest.verdict, message: `${retest.message} (repair attempt ${attempt} ${repair.repaired ? 'applied changes but' : 'could not be applied:'} ${repair.unresolvedReason ?? 'no change'})` };
      if (retest.verdict !== 'passed') escalationReason = repair.unresolvedReason;
    } else if (outcome.verdict === 'failed') {
      escalationReason = `repair budget exhausted (${priorAttempts} attempt(s))`;
    }

    spec.status = outcome.verdict;
    spec.lastRunAt = at;
    spec.message = outcome.message;
    leaf.updatedAt = at;

    /* test_result node with a verified_by edge (history is visible per attempt). */
    const testId = `ig-test-${leaf.id.replace(/^ig-/, '')}-a${attempt}`;
    if (!taken.has(testId)) {
      taken.add(testId);
      ideaGraph.nodes.push(testResultNode({ id: testId, node: leaf, attempt, verdict: outcome.verdict, message: outcome.message, at }));
      ideaGraph.edges.push({ id: `edge-${testId}-verified_by-${leaf.id}`, from: testId, to: leaf.id, kind: 'verified_by' });
    }

    /* The human_verify rung parks behind a real ask — file it once. */
    if (outcome.verdict === 'blocked_human' && spec.rung === 'human_verify') {
      const askExists = working.humanTasks.some((task) => task.linkedNodeIds.includes(leaf.id) && (task.status === 'open' || task.status === 'answered'));
      if (!askExists) {
        spec.checkId = spec.checkId ?? testId;
        result.newTasks.push({
          type: 'verify',
          title: `Run the test for ${leaf.label}`,
          body: `${spec.assertion}\n\nI cannot prove this from source alone — run it in the simulator (or on the bench) and tell me whether it holds.`,
          linkedNodeId: leaf.id,
          defaultOnExpiry: 'defer',
          assumptionIfSkipped: `Unverified: ${spec.assertion} — assumed on paper only.`,
          shape: 'boolean',
          options: ['Yes, it works', 'No, it does not'],
        });
      }
    }

    /* Escalation: over repair budget and still failing → ONE choose ask. */
    if (escalationReason) {
      const openAsk = working.humanTasks.some((task) => task.type === 'choose' && task.status === 'open' && task.linkedNodeIds.includes(leaf.id));
      const alreadyFiled = result.newTasks.some((task) => task.type === 'choose' && task.linkedNodeId === leaf.id);
      if (!openAsk && !alreadyFiled) {
        result.newTasks.push({
          type: 'choose',
          title: `"${leaf.label}" keeps failing its test — how should I proceed?`,
          body: [
            `Failing assertion: ${spec.assertion}`,
            `Last verdict: ${outcome.message}`,
            `What was tried: ${priorAttempts + 1} targeted repair attempt(s) on this node only${escalationReason ? ` — ${escalationReason}` : ''}.`,
            `Proposal: accept the node as a documented limitation, or point me at the change you want (part swap, pin change, firmware behaviour).`,
          ].join('\n'),
          linkedNodeId: leaf.id,
          defaultOnExpiry: 'defer',
          assumptionIfSkipped: 'The failing node stays flagged failed with its evidence; nothing else was changed.',
          shape: 'choice',
          options: ['Accept as a documented limitation', 'Defer — I will decide later'],
        });
      }
    }

    result.events.push({
      type: 'idea_graph_test',
      status: outcome.verdict === 'failed' ? 'failed' : 'completed',
      message: `Ladder [${spec.rung}] "${leaf.label}": ${outcome.verdict.toUpperCase()} — ${outcome.message}`,
      metadata: {
        kind: 'idea_graph.test',
        node: leaf.id,
        rung: spec.rung,
        verdict: outcome.verdict,
        attempt,
        repairCount: leaf.repairCount ?? 0,
        escalated: Boolean(escalationReason),
        testResultNode: testId,
      },
    });
    result.description.push(`${leaf.label}: ${outcome.verdict}`);
  }

  result.state = working;
  result.moved = result.events.length > 0 || repairedAny;

  /* Phase hand-over: every leaf has a run verdict → the reviewer is next. */
  const owing = pendingTestNodes(ideaGraph).filter((leaf) => leaf.testSpec?.status === 'untested' || leaf.testSpec?.status === 'failed');
  if (result.moved && owing.length === 0 && ideaGraph.phase === 'testing') {
    ideaGraph.phase = 'reviewing';
    result.description.push('Every leaf tested — the fresh-context reviewer is next.');
  }

  return result;
}
