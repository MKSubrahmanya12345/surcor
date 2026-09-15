/**
 * Everflow — goal evaluation.
 *
 * The control loop that makes the agent "everflowing": after every pass it
 * asks the same question of every node — is your goal satisfied, and if not,
 * is there a named task or next action working on you? Nodes that answer
 * "no" to both are dangling and are reported as `openEnd`. A project is
 * `done` only when every non-waived goal is satisfied and nothing dangles.
 *
 * Everything here is deterministic and offline-safe: goals are judged by
 * code against the project state, never by the model.
 */

import type { EverflowEvaluation, EverflowGraph, GoalEvaluation, NodeGoal, NextAction } from '@/types/everflow';
import type { ProjectState } from '@/types/project';

import { nowIso } from '@/lib/validation/time';
// The shared slug: the goal node was materialised with it, so the human
// answer matches for long/odd assertion ids (the old inline regex differed).
import { slug } from '@/modules/graph';
import { subtreeTestedVerdict } from './decompose';

const POSITIVE = new Set(['yes', 'true', 'ok', 'okay', 'confirmed', 'correct', 'confirmed, as-is', 'apply — replan as a new revision', 'good', 'y']);

export function isPositiveResponse(task: { asks: { positiveOptions?: string[] } }, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  const positives = task.asks.positiveOptions?.map((option) => option.toLowerCase()) ?? [];
  if (positives.length > 0) return positives.includes(normalized);
  return POSITIVE.has(normalized) || /^yes\b/.test(normalized) || /^apply\b/.test(normalized);
}

interface CheckContext {
  state: ProjectState;
  /** Task ids that are open (either direction). */
  openTaskIds: Set<string>;
  /** Task id → task, for response inspection. */
  tasks: Map<string, ProjectState['humanTasks'][number]>;
  /** checkId (assertion id) → validation check id. */
  behavioralCheck: (assertionId: string) => { status: string; message: string } | null;
  /** Open issues (error+warning) that name a requirement, by requirement text. */
  uncovered: Set<string>;
  /** Open issue messages, for artifact-level checks. */
  openIssues: string[];
  /** Node id → task ids linked to it (open only). */
  tasksByNode: Map<string, string[]>;
}

function buildContext(state: ProjectState): CheckContext {
  const tasks = new Map(state.humanTasks.map((task) => [task.id, task]));
  const openTaskIds = new Set(state.humanTasks.filter((task) => task.status === 'open').map((task) => task.id));
  const tasksByNode = new Map<string, string[]>();
  for (const task of state.humanTasks) {
    if (task.status !== 'open') continue;
    for (const nodeId of task.linkedNodeIds) {
      const list = tasksByNode.get(nodeId) ?? [];
      list.push(task.id);
      tasksByNode.set(nodeId, list);
    }
  }

  const behavioralChecks = new Map<string, { status: string; message: string }>();
  for (const check of state.validation?.checks ?? []) {
    if (check.id.startsWith('behavioral.')) {
      behavioralChecks.set(check.id.slice('behavioral.'.length), { status: check.status, message: check.message });
    }
  }

  const uncovered = new Set<string>();
  const openIssues: string[] = [];
  for (const issue of state.validation?.issues ?? []) {
    if (issue.severity === 'info') continue;
    openIssues.push(issue.message);
    if (issue.code === 'requirement_uncovered') {
      const quoted = issue.message.match(/"(.+)"/)?.[1];
      if (quoted) uncovered.add(quoted);
    }
  }

  return {
    state,
    openTaskIds,
    tasks,
    behavioralCheck: (assertionId: string) => behavioralChecks.get(assertionId) ?? null,
    uncovered,
    openIssues,
    tasksByNode,
  };
}

/** Does a human task answer (positively) close this goal? */
function humanSatisfied(ctx: CheckContext, checkId?: string, nodeRef?: string): { ok: boolean; by?: string; note?: string } {
  const candidates = [...ctx.tasks.values()].filter((task) => task.response && (task.linkedNodeIds.includes(nodeRef ?? '') || task.linkedNodeIds.length === 0));
  for (const task of candidates) {
    const response = task.response!;
    if (isPositiveResponse(task, response.value)) {
      return { ok: true, by: `ev-evidence-task-${task.id}`, note: `Human confirmed: "${response.value}"` };
    }
  }
  if (checkId) {
    const doubt = ctx.state.doubts.find((doubt) => doubt.id === checkId || doubt.nodeId === checkId);
    if (doubt && doubt.status === 'answered' && doubt.answer) {
      return { ok: true, note: `Doubt answered: "${doubt.answer.value}"` };
    }
  }
  return { ok: false };
}

function evaluateGoal(node: { id: string; goal: NodeGoal; ref?: string }, ctx: CheckContext): { state: NodeGoal['state']; evidence: string; satisfiedBy?: string } {
  const { goal } = node;
  const state = ctx.state;
  const artifacts = state.artifacts;

  switch (goal.kind) {
    case 'artifact_exists': {
      const path = goal.checkId;
      if (path === 'diagram') {
        const ok = artifacts.diagram !== null && !ctx.openIssues.some((issue) => issue.toLowerCase().includes('diagram'));
        return ok ? { state: 'satisfied', evidence: 'diagram.json exists and no open diagram issue.' } : { state: 'in_progress', evidence: artifacts.diagram ? 'diagram exists but an open issue names it.' : 'diagram.json does not exist yet.' };
      }
      if (path === 'libraries') {
        const ok = artifacts.libraries !== null;
        return ok ? { state: 'satisfied', evidence: 'libraries.json exists.' } : { state: 'in_progress', evidence: 'libraries.json does not exist yet.' };
      }
      if (path === 'instructions') {
        const ok = artifacts.instructions !== null;
        return ok ? { state: 'satisfied', evidence: 'instructions.md exists.' } : { state: 'in_progress', evidence: 'instructions.md does not exist yet.' };
      }
      const file = artifacts.code?.files.find((candidate) => candidate.path === path);
      return file
        ? { state: 'satisfied', evidence: `${path} exists (${file.content.length} chars, generated by ${file.generatedBy}).` }
        : { state: 'in_progress', evidence: `${path} does not exist yet.` };
    }

    case 'validation_clean': {
      const validation = state.validation;
      if (!validation) return { state: 'in_progress', evidence: 'Validation has not run yet.' };
      if (validation.summary.errors === 0) {
        return { state: 'satisfied', evidence: `Validation clean: 0 blocking issue(s), ${validation.summary.warnings} warning(s).` };
      }
      return { state: 'in_progress', evidence: `${validation.summary.errors} blocking issue(s) remain.` };
    }

    case 'behaviour_proven': {
      const assertionId = goal.checkId ?? node.ref ?? '';
      const check = ctx.behavioralCheck(assertionId);
      if (check?.status === 'passed') {
        return { state: 'satisfied', evidence: `Behavioural evaluator: ${check.message}` };
      }
      const human = humanSatisfied(ctx, assertionId, `ev-goal-behaviour-${slug(assertionId)}`);
      if (human.ok) return { state: 'satisfied', evidence: human.note ?? 'Confirmed by a human test.', satisfiedBy: human.by };
      if (check?.status === 'failed') {
        return { state: 'in_progress', evidence: `Evaluator says not yet: ${check.message}` };
      }
      if (check?.status === 'skipped' || check?.status === 'error' || !check) {
        return {
          state: 'blocked_human',
          evidence: check
            ? `Evaluator could not prove it (${check.status}); needs a human run: ${check.message}`
            : 'Not yet evaluated — needs a simulator or bench run.',
        };
      }
      return { state: 'in_progress', evidence: 'Evaluation pending.' };
    }

    case 'human_confirmed': {
      const human = humanSatisfied(ctx, goal.checkId, undefined);
      if (human.ok) return { state: 'satisfied', evidence: human.note ?? 'Confirmed by the human.', satisfiedBy: human.by };
      return { state: 'blocked_human', evidence: 'The human has not confirmed or corrected this yet.' };
    }

    case 'doubt_answered': {
      const doubt = ctx.state.doubts.find((candidate) => candidate.id === goal.checkId);
      if (!doubt) return { state: 'waived', evidence: 'No matching doubt (already resolved at intake).' };
      if (doubt.status !== 'open') {
        return { state: 'satisfied', evidence: `Doubt ${doubt.status}: "${doubt.answer?.value ?? doubt.proposedDefault ?? '—'}"` };
      }
      return { state: 'blocked_human', evidence: 'Still open in the doubt session.' };
    }

    case 'requirement_covered': {
      const statement = goal.checkId ?? '';
      if (ctx.uncovered.has(statement)) {
        return { state: 'in_progress', evidence: 'Validator reports this requirement as unimplemented.' };
      }
      if (!state.validation) return { state: 'in_progress', evidence: 'Validation has not run yet.' };
      return { state: 'satisfied', evidence: 'No open coverage issue names this requirement.' };
    }

    case 'subtree_tested': {
      // Idea-graph subsystem goals: judged by code against the persisted tree.
      const ideaGraph = state.ideaGraph;
      if (!ideaGraph) return { state: 'in_progress', evidence: 'No idea graph on the project yet.' };
      const openAskNodeIds = new Set<string>();
      for (const task of state.humanTasks) {
        if (task.status !== 'open') continue;
        for (const linked of task.linkedNodeIds) openAskNodeIds.add(linked);
      }
      return subtreeTestedVerdict(ideaGraph, node.id, openAskNodeIds);
    }

    case 'evidence_attached': {
      const name = goal.checkId ?? '';
      const library = state.artifacts.libraries?.libraries.find((candidate) => candidate.name === name);
      if (library) return { state: 'satisfied', evidence: `libraries.json lists ${library.name}.` };
      const passed = (state.validation?.checks ?? []).some((check) => check.status === 'passed' && check.id.toLowerCase().includes('librar'));
      if (passed) return { state: 'satisfied', evidence: 'Libraries check passed.' };
      return { state: 'in_progress', evidence: `No evidence that ${name || 'this'} is wired in yet.` };
    }

    default: {
      // `custom` goals: materialise declared decisions/revisions/evidence as
      // satisfied-by-construction; the artifact-set and intent goals get
      // special treatment below.
      if (goal.checkId === 'artifact_set') {
        const missing: string[] = [];
        if (!artifacts.code) missing.push('firmware');
        if (!artifacts.diagram) missing.push('diagram');
        if (!artifacts.libraries) missing.push('libraries');
        if (!artifacts.instructions) missing.push('instructions');
        return missing.length === 0
          ? { state: 'satisfied', evidence: 'All four artifacts exist.' }
          : { state: 'in_progress', evidence: `Missing: ${missing.join(', ')}.` };
      }
      return { state: goal.state === 'satisfied' ? 'satisfied' : 'open', evidence: goal.criterion };
    }
  }
}

/**
 * Evaluate every node goal and compute completion, open ends and next
 * actions. Pure: same inputs, same output.
 */
export function evaluateEverflow(state: ProjectState, graph: EverflowGraph, pass = 0): EverflowEvaluation {
  const ctx = buildContext(state);
  const results: GoalEvaluation[] = [];

  for (const node of graph.nodes) {
    const verdict = evaluateGoal(node, ctx);
    const goal: NodeGoal = { ...node.goal, state: verdict.state, ...(verdict.satisfiedBy ? { satisfiedBy: verdict.satisfiedBy } : {}), note: verdict.evidence };
    const satisfied = verdict.state === 'satisfied';
    const blockedHuman = verdict.state === 'blocked_human';

    // A node dangles when its goal is unmet and nothing is working on it:
    // no open task links it, and (for AI-owned work) no next action exists.
    let openEnd = false;
    let openEndReason: string | undefined;
    const hasOpenTask = (ctx.tasksByNode.get(node.id) ?? []).length > 0;
    if (!satisfied && verdict.state !== 'waived') {
      const isTaskNode = node.kind === 'task';
      const isEvidence = node.kind === 'evidence';
      if (!isTaskNode && !isEvidence && !hasOpenTask) {
        if (node.kind === 'goal' || node.kind === 'claim' || node.kind === 'artifact') {
          openEnd = true;
          openEndReason = `${node.goal.criterion} — and no task is working on it.`;
        } else if (node.kind === 'assumption') {
          openEnd = true;
          openEndReason = 'Unconfirmed assumption with no open ask.';
        } else if (node.kind === 'doubt') {
          // Open doubts are parked by design in the intake session — not dangling.
          openEnd = false;
        }
      }
    }

    results.push({
      nodeId: node.id,
      kind: node.kind,
      label: node.label,
      goal,
      satisfied,
      evidence: verdict.evidence,
      openEnd,
      ...(openEndReason ? { openEndReason } : {}),
    });
  }

  // Intent goal: satisfied only when the project itself is done (computed next).
  const intentResult = results.find((result) => result.nodeId === 'ev-intent');
  const goals = results.filter((result) => result.nodeId !== 'ev-intent');
  const waived = goals.filter((result) => result.goal.state === 'waived').length;
  const countable = goals.length - waived;
  const satisfiedCount = goals.filter((result) => result.satisfied).length;
  const openEnds = goals.filter((result) => result.openEnd);
  const aiTasksOpen = state.humanTasks.filter((task) => task.direction === 'ai_to_human' && task.status === 'open').length;
  const humanTasksOpen = state.humanTasks.filter((task) => task.direction === 'human_to_ai' && task.status === 'open').length;
  const blockedHumanCount = goals.filter((result) => result.goal.state === 'blocked_human').length;

  const completion = countable === 0 ? 0 : satisfiedCount / countable;
  const done = countable > 0 && satisfiedCount === countable && openEnds.length === 0;

  // blockedOnHuman: nothing left for the AI — every unmet goal is either
  // parked on a human (blocked_human with an open ask, or an open task node)
  // and there are no AI-actionable open ends.
  const aiActionableEnds = openEnds.filter((end) => {
    const node = graph.nodes.find((candidate) => candidate.id === end.nodeId);
    return node?.kind !== 'doubt';
  });
  const blockedOnHuman =
    !done && aiActionableEnds.length === 0 && (blockedHumanCount > 0 || aiTasksOpen > 0 || humanTasksOpen > 0 || goals.some((result) => result.goal.state === 'blocked_human'));

  if (intentResult) {
    intentResult.satisfied = done;
    intentResult.goal = { ...intentResult.goal, state: done ? 'satisfied' : 'open' };
    intentResult.evidence = done
      ? 'All goals satisfied, nothing dangling.'
      : `${satisfiedCount}/${countable} goals satisfied, ${openEnds.length} dangling, ${aiTasksOpen + humanTasksOpen} task(s) in flight.`;
    intentResult.openEnd = false;
  }

  const nextActions: NextAction[] = [];
  const validationErrors = state.validation?.summary.errors ?? 0;
  if (validationErrors > 0) {
    nextActions.push({
      kind: 'run_fix',
      nodeId: 'ev-goal-validation',
      description: `${validationErrors} blocking validation issue(s) — run a fix pass or review the Check & fix panel.`,
    });
  }
  const openDoubts = state.doubts.filter((doubt) => doubt.status === 'open');
  if (openDoubts.length > 0) {
    nextActions.push({
      kind: 'ask_human',
      nodeId: `ev-doubt-${openDoubts[0].id}`,
      description: `${openDoubts.length} intake doubt(s) still open in the session.`,
    });
  }
  for (const end of openEnds) {
    if (end.kind === 'goal' && end.goal.kind === 'behaviour_proven') {
      nextActions.push({ kind: 'verify_sim', nodeId: end.nodeId, description: `Confirm "${end.label}" in the simulator or on the bench.` });
    }
  }
  if (humanTasksOpen > 0) {
    nextActions.push({ kind: 'integrate_input', description: `${humanTasksOpen} human addition(s) waiting for the agent to process.` });
  }
  if (nextActions.length === 0) {
    nextActions.push({ kind: 'none', description: done ? 'Done.' : 'Waiting — the open work is parked in the human channel.' });
  }

  return {
    at: nowIso(),
    pass,
    totals: {
      nodes: graph.nodes.length,
      goalsTotal: goals.length,
      goalsSatisfied: satisfiedCount,
      goalsOpen: goals.filter((result) => result.goal.state === 'open' || result.goal.state === 'in_progress').length,
      goalsBlockedHuman: blockedHumanCount,
      goalsWaived: waived,
      openEnds: openEnds.length,
      aiTasksOpen,
      humanTasksOpen,
    },
    completion,
    done,
    blockedOnHuman,
    results,
    nextActions,
    brief: renderBrief(state, graph, results, { completion, done, blockedOnHuman, pass }),
  };
}

/* ------------------------------------------------------------------------- */
/* Brief — the global project document                                        */
/* ------------------------------------------------------------------------- */

function renderBrief(
  state: ProjectState,
  graph: EverflowGraph,
  results: GoalEvaluation[],
  summary: { completion: number; done: boolean; blockedOnHuman: boolean; pass: number },
): string {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const resultByNode = new Map(results.map((result) => [result.nodeId, result]));
  const lines: string[] = [];
  const pct = Math.round(summary.completion * 100);
  const stateLabel = summary.done ? 'DONE' : summary.blockedOnHuman ? 'WAITING ON HUMAN' : 'IN FLIGHT';

  lines.push(`# ${state.name} — project brief`);
  lines.push(``);
  lines.push(`Generated ${summary.pass === 0 ? 'at intake' : `on pass ${summary.pass}`} · completion ${pct}% · ${stateLabel}`);
  lines.push(``);
  lines.push(`## Outcome`);
  const intent = byId.get('ev-intent');
  lines.push(intent ? intent.content : state.prompt);
  lines.push(``);

  const goals = results.filter((result) => byId.get(result.nodeId)?.kind === 'goal' && result.nodeId !== 'ev-intent');
  if (goals.length > 0) {
    lines.push(`## Goals`);
    for (const result of goals) {
      const mark = result.satisfied ? 'x' : result.goal.state === 'blocked_human' ? '?' : ' ';
      lines.push(`- [${mark}] **${result.label}** — ${result.goal.criterion}`);
      lines.push(`      ${result.evidence}`);
    }
    lines.push(``);
  }

  const assumptions = results.filter((result) => byId.get(result.nodeId)?.kind === 'assumption' && !result.satisfied);
  if (assumptions.length > 0) {
    lines.push(`## Assumptions (unconfirmed — confirm or correct in Everflow)`);
    for (const result of assumptions) lines.push(`- ${byId.get(result.nodeId)?.content}`);
    lines.push(``);
  }

  const openTasks = state.humanTasks.filter((task) => task.status === 'open');
  if (openTasks.length > 0) {
    lines.push(`## Human channel (open)`);
    for (const task of openTasks) {
      lines.push(`- **${task.direction === 'ai_to_human' ? 'AI needs you' : 'You added'}** — ${task.title}: ${task.body}`);
    }
    lines.push(``);
  }

  const claims = results.filter((result) => byId.get(result.nodeId)?.kind === 'claim' && result.satisfied);
  if (claims.length > 0) {
    lines.push(`## Confirmed requirements`);
    for (const result of claims) lines.push(`- ${byId.get(result.nodeId)?.content}`);
    lines.push(``);
  }

  const evidence = results.filter((result) => byId.get(result.nodeId)?.kind === 'evidence').slice(0, 10);
  if (evidence.length > 0) {
    lines.push(`## Evidence (latest)`);
    for (const result of evidence) lines.push(`- ${result.label}: ${result.evidence}`);
    lines.push(``);
  }

  const dangling = results.filter((result) => result.openEnd);
  if (dangling.length > 0) {
    lines.push(`## Dangling (no task working on these)`);
    for (const result of dangling) lines.push(`- ${result.label} — ${result.openEndReason ?? result.evidence}`);
    lines.push(``);
  }

  lines.push(`_This brief is generated from the project graph. The AI receives it as its working context; every statement above is a node with provenance._`);
  return lines.join('\n');
}
