/**
 * Idea graph — the fresh-context reviewer.
 *
 * After every leaf is tested, a reviewer runs with a DELIBERATELY CLEAN
 * context: it receives ONLY the brief, the graph, the artifacts and the test
 * results — never the builder's reasoning, never the pipeline transcripts,
 * never the event log. Its question: "given only this, would this build
 * work? is any goal unproven, any test self-serving, any assumption hiding?"
 *
 * Verdicts: PASS / FAIL (+patch proposal) / ESCALATE (+human question).
 * The reviewer NEVER edits — findings materialise as review nodes with
 * evidence edges; proposals ride the existing fixer/apply paths.
 *
 * Two enforced separations:
 *   • the reviewer model ≠ builder model (BEDROCK_VALIDATION_MODEL_ID, then
 *     the main model — never a silently different one);
 *   • no edit rights (this module returns records; it patches nothing).
 *
 * Deterministic fallback: a rules-based review that checks the same list
 * (unproven goals, dangling nodes, skipped tests, unconfirmed assumptions)
 * and returns findings without a model — the review always happens.
 */

import type { EverflowNode, IdeaGraphState, ReviewerFinding, ReviewerRecord } from '@/types/everflow';
import type { ProjectState } from '@/types/project';

import { env } from '@/lib/validation/env';
import { nowIso } from '@/lib/validation/time';

/* ------------------------------------------------------------------------- */
/* The clean input (what the reviewer may see — and nothing else)              */
/* ------------------------------------------------------------------------- */

export interface ReviewerInput {
  brief: string;
  graph: {
    nodes: { id: string; kind: string; label: string; content: string; goal: unknown; level?: number; testSpec?: unknown; stakes?: string; expansionState?: string }[];
    edges: { from: string; to: string; kind: string }[];
  };
  artifacts: {
    files: { path: string; generatedBy: string; purpose: string }[];
    diagram: boolean;
    libraries: number;
    instructions: boolean;
  };
  testResults: { node: string; rung: string; verdict: string; message: string }[];
  validationSummary: { passed: boolean; errors: number; warnings: number } | null;
}

/**
 * Build the reviewer's input from the project. Deliberately narrow: it reads
 * the brief, the graph, artifact metadata and the ladder's verdicts. It does
 * NOT read state.events (the builder transcript), state.llm (model calls) or
 * any pipeline reasoning — that separation is the point, and the verify
 * script asserts on this function's output.
 */
export function buildReviewerInput(state: ProjectState, ideaGraph: IdeaGraphState): ReviewerInput {
  const brief = state.everflow?.evaluation?.brief ?? state.expandedBrief?.text ?? state.prompt;
  const graph = {
    nodes: ideaGraph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      content: node.content,
      goal: node.goal,
      ...(node.level !== undefined ? { level: node.level } : {}),
      ...(node.testSpec ? { testSpec: node.testSpec } : {}),
      ...(node.stakes ? { stakes: node.stakes } : {}),
      ...(node.expansionState ? { expansionState: node.expansionState } : {}),
    })),
    edges: ideaGraph.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind })),
  };
  const artifacts = {
    files: (state.artifacts.code?.files ?? []).map((file) => ({ path: file.path, generatedBy: file.generatedBy, purpose: file.purpose })),
    diagram: state.artifacts.diagram !== null,
    libraries: state.artifacts.libraries?.libraries.length ?? 0,
    instructions: state.artifacts.instructions !== null,
  };
  const testResults = ideaGraph.nodes
    .filter((node) => node.kind === 'subsystem' && node.testSpec)
    .map((node) => ({ node: node.label, rung: node.testSpec!.rung, verdict: node.testSpec!.status, message: node.testSpec!.message ?? '' }));
  const validationSummary = state.validation
    ? { passed: state.validation.passed, errors: state.validation.summary.errors, warnings: state.validation.summary.warnings }
    : null;
  return { brief, graph, artifacts, testResults, validationSummary };
}

/* ------------------------------------------------------------------------- */
/* The rules-based review (the deterministic fallback)                         */
/* ------------------------------------------------------------------------- */

/**
 * The same list a model reviewer gets, checked by code:
 *   1. unproven goals      — behaviour promises without a passing proof
 *   2. dangling nodes      — unmet goals with no task working on them
 *   3. skipped tests       — leaves with no run verdict (or parked without an ask)
 *   4. hidden assumptions  — unconfirmed guesses that shape the design
 *   5. validation verdict  — blocking issues that survived the fix loop
 */
export function rulesBasedReview(state: ProjectState, ideaGraph: IdeaGraphState): { verdict: ReviewerRecord['verdict']; findings: ReviewerFinding[]; question?: string } {
  const findings: ReviewerFinding[] = [];
  const evaluation = state.everflow?.evaluation;

  // 1. Unproven goals — including the HIDDEN ones: a behaviour promise whose
  // proof is only "a human was asked" is unproven as far as a fresh reader
  // is concerned when no ask was ever answered.
  for (const result of evaluation?.results ?? []) {
    if (result.kind !== 'goal' || result.nodeId === 'ev-intent') continue;
    if (result.satisfied || result.goal.state === 'waived') continue;
    const proof = result.goal.state === 'blocked_human' ? `unproven (parked behind a human ask: ${result.evidence})` : `unproven (${result.evidence})`;
    findings.push({
      id: `rev-goal-${result.nodeId}`,
      severity: result.goal.kind === 'behaviour_proven' ? 'blocking' : 'advisory',
      summary: `Goal "${result.label}" is ${proof}`,
      subjectNodeId: result.nodeId,
      proposal: result.goal.kind === 'behaviour_proven'
        ? 'Run the behavioural test in the simulator and record the answer, or accept it as a documented limitation.'
        : 'Close the goal or waive it explicitly with a reason.',
    });
  }

  // 2. Dangling nodes.
  for (const end of evaluation?.results.filter((result) => result.openEnd) ?? []) {
    findings.push({
      id: `rev-dangling-${end.nodeId}`,
      severity: 'advisory',
      summary: `Dangling: ${end.label} — ${end.openEndReason ?? end.evidence}`,
      subjectNodeId: end.nodeId,
    });
  }

  // 3. Skipped tests — a leaf without a run verdict, or parked with no ask.
  const openAskNodeIds = new Set(state.humanTasks.filter((task) => task.status === 'open').flatMap((task) => task.linkedNodeIds));
  for (const node of ideaGraph.nodes) {
    if (node.kind !== 'subsystem') continue;
    const spec = node.testSpec;
    if (!spec) {
      findings.push({ id: `rev-notest-${node.id}`, severity: 'blocking', summary: `Subsystem "${node.label}" carries no test at all.`, subjectNodeId: node.id, proposal: 'Attach a ladder rung and run it.' });
      continue;
    }
    if (spec.status === 'untested') {
      findings.push({ id: `rev-untested-${node.id}`, severity: 'blocking', summary: `Subsystem "${node.label}" was never tested (${spec.rung} rung).`, subjectNodeId: node.id });
    } else if (spec.status === 'blocked_human' && !openAskNodeIds.has(node.id)) {
      findings.push({ id: `rev-unparked-${node.id}`, severity: 'blocking', summary: `Subsystem "${node.label}" needs a human test but no ask is open.`, subjectNodeId: node.id, proposal: 'File the verify ask.' });
    }
  }

  // 4. Unconfirmed assumptions that shape the design.
  for (const result of evaluation?.results ?? []) {
    if (result.kind !== 'assumption' || result.satisfied) continue;
    findings.push({
      id: `rev-assume-${result.nodeId}`,
      severity: 'advisory',
      summary: `Unconfirmed assumption: ${(state.requirements?.assumptions ?? [])[(Number(result.nodeId.match(/(\d+)$/)?.[1] ?? 1) - 1)] ?? result.label}`,
      subjectNodeId: result.nodeId,
    });
  }

  // 5. Validation verdict.
  if (state.validation && state.validation.summary.errors > 0) {
    findings.push({
      id: 'rev-validation',
      severity: 'blocking',
      summary: `${state.validation.summary.errors} blocking validation issue(s) survived the fix loop.`,
      proposal: 'Run a targeted fix or accept the issue(s) explicitly.',
    });
  }

  const blocking = findings.filter((finding) => finding.severity === 'blocking');
  if (blocking.length > 0) return { verdict: 'FAIL', findings };
  const humanUnknowns = findings.length > 0;
  if (humanUnknowns) {
    return {
      verdict: 'ESCALATE',
      findings,
      question: 'The graph passes every machine check; advisory findings remain (assumptions, parked asks). Accept them or answer the open asks.',
    };
  }
  return { verdict: 'PASS', findings: [] };
}

/* ------------------------------------------------------------------------- */
/* The model review (clean-context call)                                       */
/* ------------------------------------------------------------------------- */

function normaliseFindings(raw: unknown): ReviewerFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewerFinding[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const summary = typeof record.summary === 'string' ? record.summary.trim().slice(0, 400) : '';
    if (!summary) continue;
    out.push({
      id: typeof record.id === 'string' ? record.id.slice(0, 80) : `rev-${out.length + 1}`,
      severity: record.severity === 'advisory' ? 'advisory' : 'blocking',
      summary,
      ...(typeof record.subjectNodeId === 'string' ? { subjectNodeId: record.subjectNodeId } : {}),
      ...(typeof record.proposal === 'string' ? { proposal: record.proposal.slice(0, 400) } : {}),
    });
  }
  return out.slice(0, 12);
}

/** The reviewer's model: BEDROCK_VALIDATION_MODEL_ID, else the main model. */
async function reviewModelAvailable(): Promise<{ useModel: boolean; modelId: string | null }> {
  const config = env();
  const modelId = config.bedrock.validationModelId ?? config.bedrock.modelId ?? null;
  return { useModel: Boolean(modelId), modelId };
}

/* ------------------------------------------------------------------------- */
/* The reviewer move                                                          */
/* ------------------------------------------------------------------------- */

export interface ReviewerMoveResult {
  ideaGraph: IdeaGraphState;
  reviewer: ReviewerRecord;
  events: {
    type: 'idea_graph_review';
    status: 'completed' | 'info' | 'failed';
    message: string;
    metadata: Record<string, unknown>;
  }[];
  /** ESCALATE files ONE ask (default-on-expiry defer). */
  newTasks: {
    type: 'review';
    title: string;
    body: string;
    linkedNodeId: string;
    defaultOnExpiry: 'defer';
    assumptionIfSkipped: string;
  }[];
  description: string[];
  moved: boolean;
  /** The exact input the reviewer saw (the verify script asserts separation on it). */
  input: ReviewerInput;
}

export async function reviewerMove(state: ProjectState, model?: { review(input: ReviewerInput): Promise<{ verdict: string; findings: unknown[]; question?: string } | null | 'unavailable'> } | null): Promise<ReviewerMoveResult> {
  const at = nowIso();
  const ideaGraph: IdeaGraphState = state.ideaGraph ?? { rootId: 'ev-intent', nodes: [], edges: [], phase: 'reviewing', expansions: 0, deadExpansions: 0, expansionPaused: false, pausedReason: null, reviewer: null, swarms: null };
  const input = buildReviewerInput(state, ideaGraph);

  let record: ReviewerRecord;
  const { useModel, modelId } = await reviewModelAvailable();

  if (model) {
    // Injected reviewer (tests / role overrides).
    try {
      const answer = await model.review(input);
      if (answer && answer !== 'unavailable') {
        record = {
          verdict: answer.verdict === 'PASS' || answer.verdict === 'FAIL' || answer.verdict === 'ESCALATE' ? answer.verdict : 'FAIL',
          findings: normaliseFindings(answer.findings),
          ...(answer.question ? { question: answer.question } : {}),
          reviewedBy: 'llm',
          modelId: 'injected',
          at,
        };
      } else {
        const rules = rulesBasedReview(state, ideaGraph);
        record = { ...rules, reviewedBy: 'rules', modelId: null, at };
      }
    } catch {
      const rules = rulesBasedReview(state, ideaGraph);
      record = { ...rules, reviewedBy: 'rules', modelId: null, at };
    }
  } else if (useModel) {
    try {
      const { proposeIdeaReview } = await import('@/lib/bedrock/operations');
      const result = await proposeIdeaReview({ reviewDocument: JSON.stringify(input, null, 2) });
      if (result.ok && result.payload) {
        const payload = result.payload as { verdict?: unknown; findings?: unknown; question?: unknown };
        const verdict = typeof payload.verdict === 'string' ? payload.verdict.toUpperCase() : '';
        record = {
          verdict: verdict === 'PASS' || verdict === 'FAIL' || verdict === 'ESCALATE' ? (verdict as ReviewerRecord['verdict']) : 'FAIL',
          findings: normaliseFindings(payload.findings),
          ...(typeof payload.question === 'string' && payload.question ? { question: payload.question.slice(0, 500) } : {}),
          reviewedBy: 'llm',
          modelId: modelId,
          at,
        };
      } else {
        const rules = rulesBasedReview(state, ideaGraph);
        record = { ...rules, reviewedBy: 'rules', modelId: null, at };
      }
    } catch {
      const rules = rulesBasedReview(state, ideaGraph);
      record = { ...rules, reviewedBy: 'rules', modelId: null, at };
    }
  } else {
    const rules = rulesBasedReview(state, ideaGraph);
    record = { ...rules, reviewedBy: 'rules', modelId: null, at };
  }

  /* Findings materialise as review nodes with evidence edges (never edits). */
  const taken = new Set(ideaGraph.nodes.map((node) => node.id));
  for (const finding of record.findings) {
    const id = `ig-review-${finding.id}`.replace(/[^a-z0-9-]/gi, '-').slice(0, 60);
    if (taken.has(id)) continue;
    taken.add(id);
    const node: EverflowNode = {
      id,
      kind: 'review',
      label: finding.summary.slice(0, 60),
      content: `${finding.severity.toUpperCase()}: ${finding.summary}${finding.proposal ? `\nProposal: ${finding.proposal}` : ''}`,
      status: 'active',
      confidence: record.reviewedBy === 'llm' ? 0.8 : 1,
      owner: 'ai',
      goal: { criterion: 'Review finding — recorded on the graph; the reviewer never edits.', kind: 'custom', state: 'satisfied' },
      file: null,
      source: { origin: 'reviewer', stage: 'idea-graph' },
      parentId: ideaGraph.rootId,
      level: 1,
      createdAt: at,
      updatedAt: at,
    };
    ideaGraph.nodes.push(node);
    ideaGraph.edges.push({ id: `edge-${id}-verified_by-root`, from: id, to: ideaGraph.rootId, kind: 'verified_by' });
    if (finding.subjectNodeId && ideaGraph.nodes.some((candidate) => candidate.id === finding.subjectNodeId)) {
      ideaGraph.edges.push({ id: `edge-${id}-verified_by-${finding.subjectNodeId}`, from: id, to: finding.subjectNodeId, kind: 'verified_by' });
    }
  }

  ideaGraph.reviewer = record;
  if (record.verdict === 'PASS') {
    ideaGraph.phase = 'swarming';
  } else if (record.verdict === 'ESCALATE') {
    ideaGraph.phase = 'reviewing';
  } else {
    ideaGraph.phase = 'reviewing'; // FAIL: findings recorded; the fixer/apply paths own repairs
  }

  const events: ReviewerMoveResult['events'] = [
    {
      type: 'idea_graph_review',
      status: record.verdict === 'PASS' ? 'completed' : record.verdict === 'FAIL' ? 'failed' : 'info',
      message:
        record.verdict === 'PASS'
          ? `Reviewer verdict: PASS (${record.reviewedBy === 'rules' ? 'rules-based' : 'model'} review, ${record.findings.length} finding(s)).`
          : record.verdict === 'FAIL'
            ? `Reviewer verdict: FAIL — ${record.findings.filter((finding) => finding.severity === 'blocking').length} blocking finding(s). ${record.findings[0]?.summary ?? ''}`
            : `Reviewer verdict: ESCALATE — ${record.question ?? 'advisory findings need a human.'}`,
      metadata: {
        kind: 'idea_graph.review',
        verdict: record.verdict,
        reviewedBy: record.reviewedBy,
        modelId: record.modelId,
        findings: record.findings.length,
        blocking: record.findings.filter((finding) => finding.severity === 'blocking').length,
      },
    },
  ];

  const newTasks: ReviewerMoveResult['newTasks'] = [];
  if (record.verdict === 'ESCALATE' && record.question) {
    newTasks.push({
      type: 'review',
      title: 'Reviewer escalation — a human call is needed',
      body: `${record.question}\n\nAdvisory findings:\n${record.findings.slice(0, 5).map((finding) => `• ${finding.summary}`).join('\n')}`,
      linkedNodeId: 'ig-review-escalation',
      defaultOnExpiry: 'defer',
      assumptionIfSkipped: 'Escalation recorded on the graph; advisory findings stand as recorded.',
    });
  }

  return {
    ideaGraph,
    reviewer: record,
    events,
    newTasks,
    description: [`Reviewer: ${record.verdict} (${record.findings.length} finding(s), ${record.reviewedBy}).`],
    moved: true,
    input,
  };
}
