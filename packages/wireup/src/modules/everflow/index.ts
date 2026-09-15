/**
 * Everflow module — public surface.
 *
 *   composeIntake / runIntake / startIntake   the Phase-0 doubt session
 *   materializeGraph                          project state → graph
 *   evaluateEverflow                          per-node goal verdicts + open ends
 *   planContinuation / runEverflowPass /
 *   continueEverflow / mongoEverflowStore     the iteration loop
 *
 * Everything deterministic is a pure function (offline-testable); the only
 * side effects are persistence through the `EverflowStore` seam and one
 * optional Bedrock call at intake.
 */

import { z } from 'zod';

import type { AgentEvent } from '@/types/generation';
import type { ProjectDoubt } from '@/types/everflow';
import type { ProjectState } from '@/types/project';
import type { IntakeDoubtSeed, IntakeLlmPayload } from './intake';
import { composeIntake, deterministicExpansion, deriveDeterministicDoubts, expandedBriefFromLlm } from './intake';
import { evaluateEverflow, isPositiveResponse } from './evaluate';
import { materializeGraph } from './materialize';
import { continueEverflow, mongoEverflowStore, type EverflowPassResult } from './continuation';

import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import { publishSteer } from '@/modules/graph';
import { describeError } from '@/lib/logging/logger';
import { env } from '@/lib/validation/env';
import { getProjectState, saveProjectState } from '@/lib/mongodb/projects';
import { proposeIntake } from '@/lib/bedrock/operations';
import { analyzePrompt, formatAnalysisForPrompt } from '@/modules/project-understanding/heuristics';

export {
  answerValueForDoubt,
  buildIntakeContext,
  composeIntake,
  deterministicExpansion,
  deriveDeterministicDoubts,
  expandedBriefFromLlm,
  type IntakeDoubtSeed,
  type IntakeLlmPayload,
} from './intake';
export { matchCorpus, planAutoResearch, researchNode, type ResearchInput } from './research';
export { DOCS_CORPUS, type CorpusEntry } from './docs-corpus';
export { evaluateEverflow, isPositiveResponse } from './evaluate';
export { materializeGraph } from './materialize';
export {
  classifyProject,
  decideStop,
  deterministicChildren,
  emptyIdeaGraphState,
  expansionMove,
  levelOneSeeds,
  pickNodeToExpand,
  subtreeOf,
  leavesOf,
  subtreeTestedVerdict,
  nullExpansionModel,
  type ExpansionModel,
  type ProposedChild,
  type ProjectClass,
} from './decompose';
export { runNodeTest, testLadderMove, repairNode, pendingTestNodes } from './test-ladder';
export { buildReviewerInput, rulesBasedReview, reviewerMove, type ReviewerInput } from './reviewer';
export { assignSwarms, swarmMove, roleForClass, modelForRole, SWARM_BY_CLASS, SWARM_ROLE_ORDER } from './swarm';
export {
  continueEverflow,
  mongoEverflowStore,
  planContinuation,
  runEverflowPass,
  runEverflowPassLegacy,
  EVERFLOW_DEFAULT_MAX_HUMAN_TASKS,
  type EverflowPassResult,
  type EverflowStore,
  type PlanResult,
} from './continuation';
export {
  behaviorFingerprint,
  designFingerprint,
  ensureActionState,
  mergeBehavioralReport,
  planActions,
  repairSignature,
  runEverflowActions,
  unprovenPromises,
  type ActionMove,
  type ActionPlan,
  type ActOptions,
  type ActResult,
} from './actions';
export { passEventMessage, passEventMetadata, type PassSummaryInput } from './pass-summary';
export { runIdeaMoves, type IdeaMovesOptions, type IdeaMovesResult } from './idea-moves';
export { buildPassGraph, runPassGraph, type PassGraphOptions, type PassGraphResult, type PassState, type PassStore } from './pass-graph';

/* ------------------------------------------------------------------------- */
/* Intake run                                                                 */
/* ------------------------------------------------------------------------- */

const DoubtSeedSchema = z
  .object({
    question: z.string().trim().min(5).max(300).catch(''),
    consequence: z.string().trim().max(300).catch(''),
    decider: z.enum(['human', 'ai', 'ai_with_veto']).catch('human'),
    blocking: z.boolean().catch(false),
    options: z.array(z.string().trim().min(1).max(80)).max(4).catch([]),
    allowMultiple: z.boolean().catch(false),
    proposedDefault: z.string().trim().max(80).nullable().catch(null),
    confidence: z.number().min(0).max(1).catch(0.5),
  })
  .transform((value) => (value.question ? value : null))
  .nullable();

const IntakePayloadSchema = z.object({
  name: z.string().trim().max(120).catch(''),
  summary: z.string().trim().max(400).catch(''),
  doubts: z.array(DoubtSeedSchema).max(8).catch([]),
  claims: z
    .array(z.object({ label: z.string().trim().max(80).catch(''), content: z.string().trim().max(300).catch('') }))
    .max(10)
    .catch([]),
  expanded: z
    .object({
      goal: z.string().trim().max(300).catch(''),
      platform: z.union([z.string().trim().max(80), z.null()]).catch(null),
      components: z
        .array(
          z.object({
            name: z.string().trim().max(80).catch(''),
            quantity: z.number().min(1).max(99).catch(1),
            role: z.string().trim().max(120).catch(''),
          }),
        )
        .max(12)
        .catch([]),
      behaviours: z.array(z.string().trim().max(160)).max(8).catch([]),
      assumptions: z.array(z.string().trim().max(200)).max(8).catch([]),
      openQuestions: z.array(z.string().trim().max(200)).max(6).catch([]),
    })
    .partial()
    .catch({}),
});

function parseIntakePayload(payload: unknown): IntakeLlmPayload | null {
  const parsed = IntakePayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const data = parsed.data;
  return {
    ...(data.name ? { name: data.name } : {}),
    ...(data.summary ? { summary: data.summary } : {}),
    doubts: data.doubts.filter((doubt): doubt is NonNullable<typeof doubt> => doubt !== null).map((doubt) => ({
      question: doubt.question,
      consequence: doubt.consequence || 'It shapes the build.',
      decider: doubt.decider,
      blocking: doubt.blocking,
      options: doubt.options,
      ...(doubt.allowMultiple ? { allowMultiple: true } : {}),
      proposedDefault: doubt.proposedDefault,
      confidence: doubt.confidence,
    })),
    ...(data.expanded && Object.keys(data.expanded).length > 0
      ? {
          expanded: {
            ...(data.expanded.goal ? { goal: data.expanded.goal } : {}),
            ...(data.expanded.platform !== undefined ? { platform: data.expanded.platform } : {}),
            ...(data.expanded.components ? { components: data.expanded.components } : {}),
            ...(data.expanded.behaviours ? { behaviours: data.expanded.behaviours } : {}),
            ...(data.expanded.assumptions ? { assumptions: data.expanded.assumptions } : {}),
            ...(data.expanded.openQuestions ? { openQuestions: data.expanded.openQuestions } : {}),
          },
        }
      : {}),
  };
}

/**
 * Run the doubt session for a project: LLM (when configured) merged over the
 * deterministic layer, persisted, events emitted. Resolves with the final
 * state; a model outage degrades to the deterministic doubts, never to a
 * crash.
 */
export async function runIntake(projectId: string): Promise<ProjectState | null> {
  const state = await getProjectState(projectId);
  if (!state) return null;

  const at = nowIso();
  let llm: IntakeLlmPayload | null = null;
  let llmError: string | null = null;

  const bedrockModel = env().bedrock.modelId;
  if (bedrockModel) {
    try {
      const analysis = analyzePrompt(state.prompt);
      const result = await proposeIntake({
        prompt: state.prompt,
        preAnalysis: formatAnalysisForPrompt(analysis),
      });
      if (result.ok && result.payload) {
        llm = parseIntakePayload(result.payload);
      } else {
        llmError = result.error ?? 'no payload';
      }
    } catch (error) {
      llmError = describeError(error).message;
    }
  }

  const composed = composeIntake(state, llm);
  const doubts = composed.doubts;
  const expandedBrief = llm?.expanded ? expandedBriefFromLlm(llm.expanded, state) : deterministicExpansion(state);
  const graph = materializeGraph({ ...state, doubts, expandedBrief, status: 'intake' });
  const evaluation = evaluateEverflow({ ...state, doubts, expandedBrief, status: 'intake' }, graph, 0);

  const event: AgentEvent = {
    seq: (state.events.reduce((max, candidate) => Math.max(max, candidate.seq), 0) ?? 0) + 1,
    id: createId('evt'),
    type: 'intake_completed',
    status: 'completed',
    message: `Doubt session ready: ${doubts.length} question(s)${llm ? ', refined by the model' : ''}${llmError ? ' (model unavailable — deterministic questions only)' : ''}.`,
    timestamp: at,
    stage: 'idle',
    metadata: { doubts: doubts.length, blocking: doubts.filter((doubt) => doubt.blocking).length, llm: llm ? 'ok' : llmError ? 'degraded' : 'skipped' },
  };

  const saved = await saveProjectState(projectId, {
    status: 'intake',
    stage: 'idle',
    ...(composed.name && state.name === 'Untitled project' ? { name: composed.name } : {}),
    doubts,
    expandedBrief,
    everflow: { graph, evaluation, pass: 0 },
  });
  if (saved) {
    const { appendEvents } = await import('@/lib/mongodb/projects');
    await appendEvents(projectId, [event]);
  }
  return (await getProjectState(projectId)) ?? saved;
}

declare global {
  // eslint-disable-next-line no-var
  var __wireupIntakeRunning: Set<string> | undefined;
}

const intakeRunning: Set<string> = globalThis.__wireupIntakeRunning ?? new Set<string>();
globalThis.__wireupIntakeRunning = intakeRunning;

/** Fire-and-forget intake (the POST /api/projects handler uses this). */
export function startIntake(projectId: string): void {
  if (intakeRunning.has(projectId)) return;
  intakeRunning.add(projectId);
  void runIntake(projectId)
    .catch((error) => {
      // Intake must never leave a project stuck: fall back to deterministic doubts.
      void (async () => {
        const failed = await getProjectState(projectId);
        if (failed && failed.status === 'intake' && (failed.doubts?.length ?? 0) === 0) {
          const doubts = deriveDeterministicDoubts(failed.prompt);
          const graph = materializeGraph({ ...failed, doubts });
          const evaluation = evaluateEverflow({ ...failed, doubts }, graph, 0);
          await saveProjectState(projectId, { doubts, everflow: { graph, evaluation, pass: 0 } });
        }
      })().catch(() => undefined);
    })
    .finally(() => intakeRunning.delete(projectId));
}

/* ------------------------------------------------------------------------- */
/* Human-channel actions                                                      */
/* ------------------------------------------------------------------------- */

export interface EverflowChannelResult {
  state: ProjectState;
  pass: EverflowPassResult | null;
}

/** Answer an ai→human task (column one) and run a pass. */
export async function respondToHumanTask(projectId: string, taskId: string, value: string, note?: string): Promise<EverflowChannelResult | null> {
  const state = await getProjectState(projectId);
  if (!state) return null;
  const task = state.humanTasks.find((candidate) => candidate.id === taskId);
  if (!task || task.direction !== 'ai_to_human' || task.status !== 'open') return null;

  const humanTasks = state.humanTasks.map((candidate) =>
    candidate.id === taskId
      ? { ...candidate, status: 'answered' as const, response: { value, ...(note ? { note } : {}), at: nowIso() }, updatedAt: nowIso() }
      : candidate,
  );

  /* An answered convergence/backstop ask is what RESUMES the idea graph —
   * the pause is never lifted silently, only by the human's explicit answer. */
  let ideaGraph = state.ideaGraph ?? null;
  if (ideaGraph && ideaGraph.expansionPaused && isPositiveResponse(task, value)) {
    ideaGraph = {
      ...ideaGraph,
      expansionPaused: false,
      deadExpansions: 0,
      pausedReason: null,
    };
    await saveProjectState(projectId, { ideaGraph });
  }

  await saveProjectState(projectId, { humanTasks });

  const { appendEvents } = await import('@/lib/mongodb/projects');
  await appendEvents(projectId, [
    {
      seq: state.events.reduce((max, candidate) => Math.max(max, candidate.seq), 0) + 1,
      id: createId('evt'),
      type: 'human_task_answered',
      status: 'info',
      message: `You answered “${task.title}”: ${value}${isPositiveResponse(task, value) ? '' : ' (treated as "not yet")'}.`,
      timestamp: nowIso(),
      stage: 'completed',
      metadata: { taskId, type: task.type, positive: isPositiveResponse(task, value) },
    },
  ]);

  const pass = await continueEverflow(projectId, 'human_answer', mongoEverflowStore(), {
    maxPasses: env().agent.everflowMaxPasses,
    maxHumanTasks: env().agent.everflowMaxHumanTasks,
  });
  return { state: (await getProjectState(projectId))!, pass };
}

/**
 * Whether 'steer' injections are accepted at all. The gate is the product of
 * an explicit env flag AND an Astra model id — with anything else the honest
 * answer is no, and steer is refused at the route (the other four types never
 * touch this gate, so the default path cannot break).
 */
export function midTurnSteerEnabled(): boolean {
  const parsed = env();
  return parsed.agent.enableMidTurnSteer === true && (parsed.bedrock.modelId?.toLowerCase().includes('astra') ?? false);
}

export type SteerTier = 'off' | 'tier1' | 'tier1.5';

/**
 * Which steering tier is actually in effect:
 *   off     — the gate is closed (route refuses `steer`)
 *   tier1   — persisted, folded at the next pass (always, once gated in)
 *   tier1.5 — the steer bus is ALSO drained at StateGraph node boundaries
 *             inside the running pass, so a steer can land mid-pass
 * Tier-2 (true mid-token steering over an Astra WebSocket) is designed but
 * not implemented — nothing reports it until it exists.
 */
export function steerTier(): SteerTier {
  if (!midTurnSteerEnabled()) return 'off';
  return env().models.enableGraphPass ? 'tier1.5' : 'tier1';
}

/** Register a human→ai addition (column two) and run a pass. */
export async function createHumanInjection(
  projectId: string,
  input: { type: 'note' | 'idea' | 'correction' | 'resource' | 'steer'; text: string; title?: string },
): Promise<EverflowChannelResult | null> {
  const state = await getProjectState(projectId);
  if (!state) return null;

  const at = nowIso();
  const task = {
    id: createId('htask'),
    direction: 'human_to_ai' as const,
    type: input.type,
    title: (input.title ?? input.text).trim().slice(0, 120) || input.type,
    body: input.text.trim().slice(0, 2000),
    asks: { shape: 'text' as const },
    linkedNodeIds: ['ev-intent'],
    lookAt: null,
    priority: input.type === 'note' ? ('low' as const) : ('high' as const),
    status: 'open' as const,
    response: { value: input.text.trim().slice(0, 2000), at },
    defaultOnExpiry: 'defer' as const,
    assumptionIfSkipped: null,
    source: 'human' as const,
    createdAt: at,
    updatedAt: at,
  };

  const humanTasks = [...state.humanTasks, task];
  await saveProjectState(projectId, { humanTasks });

  // Steers ALSO ride the bus: the persisted task is the Tier-1 record, and
  // the bus copy lets a RUNNING pass fold it at its next node boundary
  // (Tier-1.5) instead of waiting for the next pass. Same id — deduped.
  if (input.type === 'steer') {
    publishSteer({ id: task.id, projectId, text: task.body, title: task.title, at });
  }

  const { appendEvents } = await import('@/lib/mongodb/projects');
  await appendEvents(projectId, [
    {
      seq: state.events.reduce((max, candidate) => Math.max(max, candidate.seq), 0) + 1,
      id: createId('evt'),
      type: 'injection_registered',
      status: 'info',
      message:
        input.type === 'steer'
          ? steerTier() === 'tier1.5'
            ? `Steer registered: ${task.title} — folds in at the next node boundary (mid-pass when a pass is running, else the next pass).`
            : `Steer registered: ${task.title} — the current move finishes first; the planner folds it in at the next pass.`
          : `You added (${input.type}): ${task.title}`,
      timestamp: at,
      stage: 'completed',
      metadata: { taskId: task.id, type: input.type },
    },
  ]);

  const pass = await continueEverflow(projectId, 'human_injection', mongoEverflowStore(), {
    maxPasses: env().agent.everflowMaxPasses,
    maxHumanTasks: env().agent.everflowMaxHumanTasks,
  });
  return { state: (await getProjectState(projectId))!, pass };
}
