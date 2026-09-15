/**
 * Everflow — the continuation loop (the "everflowing" agent).
 *
 * After the pipeline finalises — and after every human-channel event — a
 * continuation pass runs:
 *
 *   1. materialise  — project state → graph (deterministic projection)
 *   2. evaluate     — every node's goal is judged by code; dangling nodes
 *                     are flagged as open ends
 *   3. plan         — for every unmet goal the agent names its next move:
 *                        • file an ai→human task (it can never close this
 *                          goal alone), or
 *                        • process a human→ai addition (register the fact,
 *                          file a "apply to the build?" ask — never a silent
 *                          self-modification), or
 *                        • record that the work is already in flight
 *   4. persist      — graph + evaluation + tasks land on the project doc and
 *                     the event log explains the pass
 *
 * The agent iterates until `done` (every goal satisfied, nothing dangling) or
 * `blockedOnHuman` (only human-owned work remains). Budgets bound the loop;
 * human tasks carry a default-on-expiry, so the agent never waits on a human.
 *
 * Two runners, one behaviour: `runEverflowPass` executes the pass as a
 * checkpointed StateGraph (`pass-graph.ts`) when `WIREUP_ENABLE_GRAPH_PASS`
 * is on (the default), and falls back to the legacy straight-line runner on
 * any error — the flag can never break the build. Both runners share the
 * planner (`planner.ts`) and the idea moves (`idea-moves.ts`).
 */

import type { AgentEvent } from '@/types/generation';
import type { EverflowEvaluation, EverflowGraph, HumanTask, IdeaGraphState, ResearchFinding } from '@/types/everflow';
import type { ProjectState } from '@/types/project';

import { appendEvents, getProjectState, saveProjectState } from '@/lib/mongodb/projects';
import { env } from '@/lib/validation/env';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';

import { evaluateEverflow } from './evaluate';
import { runIdeaMoves, type IdeaMovesOptions } from './idea-moves';
import { materializeGraph } from './materialize';
import { EVERFLOW_DEFAULT_MAX_HUMAN_TASKS, planContinuation } from './planner';
import { planAutoResearch, researchNode } from './research';
import { runEverflowActions, type ActOptions } from './actions';
import { passEventMessage, passEventMetadata, type PassSummaryInput } from './pass-summary';

/* ------------------------------------------------------------------------- */
/* Store — the only persistence seam (tests pass an in-memory implementation) */
/* ------------------------------------------------------------------------- */

export interface EverflowStore {
  getState(id: string): Promise<ProjectState | null>;
  save(id: string, patch: Record<string, unknown>): Promise<ProjectState | null>;
  appendEvent(id: string, event: Omit<AgentEvent, 'seq'> & { seq?: number }): Promise<void>;
}

function eventSeq(state: ProjectState | null): number {
  return state?.events.reduce((max, event) => Math.max(max, event.seq), 0) ?? 0;
}

/* Planner re-exports (the implementation lives in `planner.ts`, shared with
 * the StateGraph pass; every existing import path keeps working). */
export { EVERFLOW_DEFAULT_MAX_HUMAN_TASKS, makeTask, planContinuation, type PlanResult } from './planner';

/* ------------------------------------------------------------------------- */
/* Pass runner                                                                */
/* ------------------------------------------------------------------------- */

export interface EverflowPassResult {
  state: ProjectState;
  graph: EverflowGraph;
  evaluation: EverflowEvaluation;
  plan: import('./planner').PlanResult;
  /** False when no further pass would change anything. */
  progressed: boolean;
}

export interface EverflowPassOptions {
  maxHumanTasks?: number;
  /**
   * Idea-graph move wiring (runs when WIREUP_ENABLE_IDEA_GRAPH, default on).
   * Tests inject a canned model here; production lazily wires Bedrock only
   * when a model id is configured — so offline runs never touch the SDK.
   */
  ideaGraph?: IdeaMovesOptions & { enabled?: boolean };
  /**
   * Act-phase wiring (runs when WIREUP_ENABLE_EVERFLOW_ACTIONS, default on).
   * Tests inject a catalog / budgets here; production reads the environment
   * and loads the catalog lazily, so offline runs never touch MongoDB.
   */
  actions?: ActOptions;
}

/**
 * Run one continuation pass against the store. Safe to call repeatedly; each
 * pass is small and idempotent, so the loop below stops as soon as it makes
 * no progress.
 *
 * Graph runner first (checkpointed, with mid-pass steer folding); the legacy
 * runner is the catch-all fallback. A `runner` field on the pass event says
 * which one executed.
 */
export async function runEverflowPass(projectId: string, trigger: string, store: EverflowStore, maxHumanTasksOrOptions: number | EverflowPassOptions = EVERFLOW_DEFAULT_MAX_HUMAN_TASKS): Promise<EverflowPassResult | null> {
  const options: EverflowPassOptions = typeof maxHumanTasksOrOptions === 'number' ? { maxHumanTasks: maxHumanTasksOrOptions } : maxHumanTasksOrOptions;
  if (env().models.enableGraphPass) {
    try {
      const { runPassGraph } = await import('./pass-graph');
      const result = await runPassGraph(projectId, trigger, store, {
        ...(options.maxHumanTasks !== undefined ? { maxHumanTasks: options.maxHumanTasks } : {}),
        ...(options.ideaGraph ? { ideaGraph: options.ideaGraph } : {}),
        ...(options.actions ? { actions: options.actions } : {}),
      });
      if (result) return { state: result.state, graph: result.graph, evaluation: result.evaluation, plan: result.plan, progressed: result.progressed };
      return null;
    } catch (error) {
      // The flag can never break the build: fall back to the legacy runner
      // and say so on the event log (never silently).
      try {
        await store.appendEvent(projectId, {
          id: createId('evt'),
          type: 'everflow_pass',
          status: 'info',
          message: `Graph pass unavailable (${error instanceof Error ? error.message : 'unknown'}) — ran the legacy pass instead.`,
          timestamp: nowIso(),
          stage: 'completed',
          metadata: { trigger, runner: 'legacy_fallback', error: true },
        });
      } catch {
        // Event append is best-effort here; the legacy pass still runs.
      }
    }
  }
  return runEverflowPassLegacy(projectId, trigger, store, options);
}

/**
 * The legacy straight-line pass. Identical behaviour to the graph runner
 * (same planner, same idea moves, same order) — kept as the fallback and as
 * the equivalence baseline in `pnpm verify:graph`.
 */
export async function runEverflowPassLegacy(projectId: string, trigger: string, store: EverflowStore, options: EverflowPassOptions = {}): Promise<EverflowPassResult | null> {
  const maxHumanTasks = options.maxHumanTasks ?? EVERFLOW_DEFAULT_MAX_HUMAN_TASKS;
  const state = await store.getState(projectId);
  if (!state) return null;

  const pass = state.everflow?.pass ?? 0;
  let graph = materializeGraph(state);
  let evaluation = evaluateEverflow(state, graph, pass + 1);

  /* --- the act phase: engineering moves the loop runs ITSELF, before any
   * ask is filed (revalidate drift → reprove behaviour → targeted repair).
   * Humans get asked only what the loop could not close by code. ------------ */
  const act = await runEverflowActions(state, pass + 1, options.actions ?? {});
  // The act events ride inside the working state's log so the idea moves —
  // which sequence from `state.events` — number strictly after them, and the
  // single save below persists them exactly once.
  const working: ProjectState =
    act.sequencedEvents.length > 0
      ? { ...act.state, events: [...act.state.events, ...(act.sequencedEvents as AgentEvent[])] }
      : act.state;
  if (act.moved) {
    // The design moved: re-project and re-judge so the plan sees fresh goals.
    graph = materializeGraph(working);
    evaluation = evaluateEverflow(working, graph, pass + 1);
  }
  const actionsChanged = act.records.filter((record) => record.outcome === 'changed').length;

  const plan = planContinuation(working, graph, evaluation, maxHumanTasks);

  /* --- the idea-graph move (one per pass, flag-gated) ---------------------- */
  const ideaOutcome = await runIdeaMoves(working, projectId, {
    ...(options.ideaGraph?.enabled !== undefined ? { enabled: options.ideaGraph.enabled } : {}),
    ...(options.ideaGraph?.model ? { model: options.ideaGraph.model } : {}),
    ...(options.ideaGraph?.maxExpansions !== undefined ? { maxExpansions: options.ideaGraph.maxExpansions } : {}),
    ...(options.ideaGraph?.reviewerModel !== undefined ? { reviewerModel: options.ideaGraph.reviewerModel } : {}),
  });
  const ideaGraph: IdeaGraphState | null = ideaOutcome.ideaGraph;
  const ideaEvents = ideaOutcome.sequencedEvents;
  const ideaTasks: HumanTask[] = ideaOutcome.newTasks;
  const ideaMoved = ideaOutcome.moved;
  /** The ladder may repair artifacts — the pass then persists THAT state. */
  const passState: ProjectState = ideaOutcome.passState;

  // The agent checks its low-confidence claims/decisions against the docs —
  // offline sources (catalog + corpus); the live web stays a deliberate act.
  const findings: ResearchFinding[] = [];
  for (const pick of planAutoResearch(passState, graph, 2)) {
    const finding = await researchNode({ state: passState, node: pick.node });
    if (finding) findings.push(finding);
  }
  const research = findings.length > 0 ? [...passState.research, ...findings] : passState.research;

  const humanTasks = [...passState.humanTasks, ...plan.newTasks, ...plan.followUps, ...ideaTasks].map((task) =>
    plan.processedInjections.includes(task.id) ? { ...task, status: 'processed' as const, updatedAt: nowIso() } : task,
  );

  let next: ProjectState = {
    ...passState,
    humanTasks,
    research,
    everflow: { graph, evaluation, pass: pass + 1, actions: act.actions },
    ...(ideaMoved && ideaGraph ? { ideaGraph } : {}),
  };
  if (findings.length > 0 || ideaMoved) {
    // Re-project: new evidence/idea nodes join the graph and the brief.
    graph = materializeGraph(next);
    evaluation = evaluateEverflow(next, graph, pass + 1);
    next = { ...next, everflow: { graph, evaluation, pass: pass + 1, actions: act.actions } };
  }

  const saved = await store.save(projectId, {
    ...next,
    humanTasks,
    ...(findings.length > 0 ? { research } : {}),
    everflow: next.everflow,
    ...(ideaMoved && ideaGraph ? { ideaGraph } : {}),
  });
  const finalState = saved ?? next;

  for (const event of ideaEvents) {
    await store.appendEvent(projectId, event);
  }

  const progressed =
    plan.newTasks.length + plan.followUps.length + plan.processedInjections.length + findings.length + (ideaMoved ? 1 : 0) + actionsChanged > 0;

  const summary: PassSummaryInput = {
    pass: pass + 1,
    trigger,
    evaluation,
    tasksFiled: plan.newTasks.length + plan.followUps.length + ideaTasks.length,
    docsChecked: findings.length,
    injectionsProcessed: plan.processedInjections.length,
    ideaMoved,
    ideaGraph,
    steersFolded: 0,
    actionsChanged,
    actionsRun: act.records.length,
    runner: 'legacy',
  };

  await store.appendEvent(projectId, {
    id: createId('evt'),
    type: 'everflow_pass',
    status: 'info',
    message: passEventMessage(summary),
    timestamp: nowIso(),
    stage: 'completed',
    metadata: passEventMetadata(summary),
  });

  return { state: finalState, graph, evaluation, plan, progressed };
}

/**
 * Iterate passes until the project is done, blocked only on humans, or no
 * pass makes progress. Bounded by `maxPasses` so a looping state can never
 * spin the server.
 */
export async function continueEverflow(
  projectId: string,
  trigger: string,
  store: EverflowStore,
  options: { maxPasses?: number; maxHumanTasks?: number; ideaGraph?: EverflowPassOptions['ideaGraph']; actions?: EverflowPassOptions['actions'] } = {},
): Promise<EverflowPassResult | null> {
  const maxPasses = options.maxPasses ?? 3;
  let last: EverflowPassResult | null = null;
  for (let i = 0; i < maxPasses; i += 1) {
    const result = await runEverflowPass(projectId, trigger, store, {
      maxHumanTasks: options.maxHumanTasks,
      ...(options.ideaGraph ? { ideaGraph: options.ideaGraph } : {}),
      ...(options.actions ? { actions: options.actions } : {}),
    });
    if (!result) break;
    last = result;
    if (result.evaluation.done) break;
    if (!result.progressed) break;
    if (result.evaluation.blockedOnHuman && result.plan.newTasks.length === 0 && result.plan.followUps.length === 0) break;
  }
  return last;
}

/** MongoDB-backed store (the only production implementation). */
export function mongoEverflowStore(): EverflowStore {
  return {
    async getState(id) {
      return getProjectState(id);
    },
    async save(id, patch) {
      return saveProjectState(id, patch);
    },
    async appendEvent(id, event) {
      if (!('seq' in event && event.seq)) {
        const current = await getProjectState(id);
        event = { ...event, seq: eventSeq(current) + 1 };
      }
      await appendEvents(id, [event as AgentEvent]);
    },
  };
}
