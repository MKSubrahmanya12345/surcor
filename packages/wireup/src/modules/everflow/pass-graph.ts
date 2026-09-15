/**
 * Everflow — the continuation pass expressed AS a StateGraph.
 *
 * Nodes: materialize → evaluate → foldSteers → plan → idea → research →
 * persist. Every node calls the SAME pure helpers as the legacy runner, in
 * the same order, so the two runners are behaviour-identical (the graph
 * verifier asserts equivalence over a synthetic state). What the graph adds:
 *
 *   - a checkpoint after every node (per-pass thread: pause/resume/audit),
 *   - steer folding at a node boundary INSIDE the pass (Tier-1.5): a steer
 *     published while the pass runs lands in the same pass instead of
 *     waiting for the next one,
 *   - `interruptBefore` support for future human-gated persists.
 *
 * Reducers: `snapshot`/`graph`/`evaluation`/`plan` REPLACE (current
 * values); `ideaEvents`/`ideaTasks`/`findings`/`foldedSteers` APPEND
 * (accumulators — never silently overwritten across nodes).
 */

import type { AgentEvent } from '@/types/generation';
import type { EverflowActionState, EverflowEvaluation, EverflowGraph, HumanTask, IdeaGraphState, ResearchFinding } from '@/types/everflow';
import type { ProjectState } from '@/types/project';

import { drainSteers, MemoryCheckpointer, StateGraph, type Checkpointer } from '@/modules/graph';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';

import { runEverflowActions, type ActOptions } from './actions';
import { evaluateEverflow } from './evaluate';
import { runIdeaMoves, type IdeaMovesOptions } from './idea-moves';
import { materializeGraph } from './materialize';
import { passEventMessage, passEventMetadata, type PassSummaryInput } from './pass-summary';
import { EVERFLOW_DEFAULT_MAX_HUMAN_TASKS, planContinuation, type PlanResult } from './planner';
import { planAutoResearch, researchNode } from './research';

/** Persistence seam (structurally identical to `EverflowStore` — no import to avoid a cycle). */
export interface PassStore {
  getState(id: string): Promise<ProjectState | null>;
  save(id: string, patch: Record<string, unknown>): Promise<ProjectState | null>;
  appendEvent(id: string, event: Omit<AgentEvent, 'seq'> & { seq?: number }): Promise<void>;
}

export interface PassGraphOptions {
  maxHumanTasks?: number;
  ideaGraph?: IdeaMovesOptions & { enabled?: boolean };
  /** Act-phase wiring (tests inject a catalog/budgets; production reads env). */
  actions?: ActOptions;
  interruptBefore?: string[];
  checkpointer?: Checkpointer<PassState>;
}

export interface PassState extends Record<string, unknown> {
  projectId: string;
  trigger: string;
  pass: number;
  maxHumanTasks: number;
  snapshot: ProjectState;
  graph: EverflowGraph | null;
  evaluation: EverflowEvaluation | null;
  plan: PlanResult | null;
  ideaGraph: IdeaGraphState | null;
  ideaMoved: boolean;
  ideaEvents: (AgentEvent & { seq?: number })[];
  ideaTasks: HumanTask[];
  findings: ResearchFinding[];
  foldedSteers: string[];
  ideaOptions: IdeaMovesOptions;
  /** Act phase: bookkeeping, and how many moves ran / changed the project. */
  actions: EverflowActionState | null;
  actionsChanged: number;
  actionsRun: number;
  actionOptions: ActOptions;
}

export interface PassGraphResult {
  state: ProjectState;
  graph: EverflowGraph;
  evaluation: EverflowEvaluation;
  plan: PlanResult;
  progressed: boolean;
  /** Node path the graph walked (for the verifier + the pass event). */
  path: string[];
}

function emptyPlan(): PlanResult {
  return { newTasks: [], processedInjections: [], followUps: [], description: [] };
}

function foldSteerUpdate(state: PassState): Partial<PassState> {
  const steers = drainSteers(state.projectId);
  if (steers.length === 0) return {};
  const seen = new Set(state.snapshot.humanTasks.map((task) => task.id));
  const fresh = steers.filter((steer) => !seen.has(steer.id));
  if (fresh.length === 0) return {};
  // Reconstruct the exact task shape `createHumanInjection` persisted
  // (the bus carries a copy for prompt delivery; the id dedups).
  const tasks: HumanTask[] = fresh.map((steer) => ({
    id: steer.id,
    direction: 'human_to_ai',
    type: 'steer',
    title: steer.title,
    body: steer.text,
    asks: { shape: 'text' },
    linkedNodeIds: ['ev-intent'],
    lookAt: null,
    priority: 'high',
    status: 'open',
    response: { value: steer.text, at: steer.at },
    defaultOnExpiry: 'defer',
    assumptionIfSkipped: null,
    source: 'human',
    createdAt: steer.at,
    updatedAt: steer.at,
  }));
  return {
    snapshot: { ...state.snapshot, humanTasks: [...state.snapshot.humanTasks, ...tasks] },
    foldedSteers: fresh.map((steer) => steer.id),
  };
}

/** The pass as a graph. `store`/`pass`/`trigger` bind the persist node. */
export function buildPassGraph(store: PassStore, pass: number, trigger: string, projectId: string): StateGraph<PassState> {
  const graph = new StateGraph<PassState>({
    snapshot: 'replace',
    graph: 'replace',
    evaluation: 'replace',
    plan: 'replace',
    ideaGraph: 'replace',
    ideaMoved: 'replace',
    actions: 'replace',
    actionsChanged: 'replace',
    actionsRun: 'replace',
    actionOptions: 'replace',
    ideaEvents: 'append',
    ideaTasks: 'append',
    findings: 'append',
    foldedSteers: 'append',
  });

  graph.addNode('materialize', (state) => ({ graph: materializeGraph(state.snapshot) }));
  graph.addNode('evaluate', (state) => ({
    evaluation: evaluateEverflow(state.snapshot, state.graph!, state.pass + 1),
  }));
  graph.addNode('foldSteers', foldSteerUpdate);
  /* The act phase: engineering moves the loop runs ITSELF (revalidate drift →
   * reprove behaviour → targeted repair) BEFORE the planner files asks. The
   * move events ride inside the snapshot's event log so the idea moves —
   * which sequence from `snapshot.events` — number strictly after them, and
   * the persist node saves them exactly once. */
  graph.addNode('act', async (state) => {
    const act = await runEverflowActions(state.snapshot, state.pass + 1, state.actionOptions);
    const base: Partial<PassState> = {
      actions: act.actions,
      actionsChanged: act.records.filter((record) => record.outcome === 'changed').length,
      actionsRun: act.records.length,
    };
    if (act.sequencedEvents.length === 0) return base;
    const snapshot: ProjectState = { ...act.state, events: [...act.state.events, ...(act.sequencedEvents as AgentEvent[])] };
    if (!act.moved) return { ...base, snapshot };
    const graphNow = materializeGraph(snapshot);
    return { ...base, snapshot, graph: graphNow, evaluation: evaluateEverflow(snapshot, graphNow, state.pass + 1) };
  });
  graph.addNode('plan', (state) => ({
    plan: state.evaluation && state.graph ? planContinuation(state.snapshot, state.graph, state.evaluation, state.maxHumanTasks) : emptyPlan(),
  }));
  graph.addNode('idea', async (state) => {
    const outcome = await runIdeaMoves(state.snapshot, state.projectId, state.ideaOptions);
    return {
      snapshot: outcome.passState,
      ideaGraph: outcome.ideaGraph,
      ideaMoved: outcome.moved,
      ideaEvents: outcome.sequencedEvents,
      ideaTasks: outcome.newTasks,
    };
  });
  graph.addNode('research', async (state) => {
    const findings: ResearchFinding[] = [];
    if (state.graph) {
      for (const pick of planAutoResearch(state.snapshot, state.graph, 2)) {
        const finding = await researchNode({ state: state.snapshot, node: pick.node });
        if (finding) findings.push(finding);
      }
    }
    if (findings.length === 0) return {};
    return {
      snapshot: { ...state.snapshot, research: [...state.snapshot.research, ...findings] },
      findings,
    };
  });
  graph.addNode('persist', async (state) => {
    const plan = state.plan ?? emptyPlan();
    const humanTasks = [...state.snapshot.humanTasks, ...plan.newTasks, ...plan.followUps, ...state.ideaTasks].map((task) =>
      plan.processedInjections.includes(task.id) ? { ...task, status: 'processed' as const, updatedAt: nowIso() } : task,
    );
    let graphNow = state.graph!;
    let evaluationNow = state.evaluation!;
    let next: ProjectState = {
      ...state.snapshot,
      humanTasks,
      everflow: { graph: graphNow, evaluation: evaluationNow, pass: pass + 1, actions: state.actions },
      ...(state.ideaMoved && state.ideaGraph ? { ideaGraph: state.ideaGraph } : {}),
    };
    if (state.findings.length > 0 || state.ideaMoved) {
      // Re-project: new evidence/idea nodes join the graph and the brief.
      graphNow = materializeGraph(next);
      evaluationNow = evaluateEverflow(next, graphNow, pass + 1);
      next = { ...next, everflow: { graph: graphNow, evaluation: evaluationNow, pass: pass + 1, actions: state.actions } };
    }
    const saved = await store.save(projectId, {
      ...next,
      humanTasks,
      ...(state.findings.length > 0 ? { research: next.research } : {}),
      everflow: next.everflow,
      ...(state.ideaMoved && state.ideaGraph ? { ideaGraph: state.ideaGraph } : {}),
    });
    for (const event of state.ideaEvents) {
      await store.appendEvent(projectId, event);
    }
    const progressed =
      plan.newTasks.length + plan.followUps.length + plan.processedInjections.length + state.findings.length + (state.ideaMoved ? 1 : 0) + state.actionsChanged > 0;
    const summary: PassSummaryInput = {
      pass: pass + 1,
      trigger,
      evaluation: evaluationNow,
      tasksFiled: plan.newTasks.length + plan.followUps.length + state.ideaTasks.length,
      docsChecked: state.findings.length,
      injectionsProcessed: plan.processedInjections.length,
      ideaMoved: state.ideaMoved,
      ideaGraph: state.ideaGraph,
      steersFolded: state.foldedSteers.length,
      actionsChanged: state.actionsChanged,
      actionsRun: state.actionsRun,
      runner: 'graph',
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
    const finalState = saved ?? next;
    return { snapshot: finalState, graph: graphNow, evaluation: evaluationNow };
  });

  graph.setEntryPoint('materialize');
  graph.addEdge('materialize', 'evaluate');
  graph.addEdge('evaluate', 'foldSteers');
  graph.addEdge('foldSteers', 'act');
  graph.addEdge('act', 'plan');
  graph.addEdge('plan', 'idea');
  graph.addEdge('idea', 'research');
  graph.addEdge('research', 'persist');

  return graph;
}

export async function runPassGraph(
  projectId: string,
  trigger: string,
  store: PassStore,
  options: PassGraphOptions = {},
): Promise<PassGraphResult | null> {
  const snapshot = await store.getState(projectId);
  if (!snapshot) return null;
  const pass = snapshot.everflow?.pass ?? 0;

  const compiled = buildPassGraph(store, pass, trigger, projectId).compile(options.checkpointer ?? new MemoryCheckpointer<PassState>());
  const threadId = `pass-${createId('evt')}`;
  const initial: PassState = {
    projectId,
    trigger,
    pass,
    maxHumanTasks: options.maxHumanTasks ?? EVERFLOW_DEFAULT_MAX_HUMAN_TASKS,
    snapshot,
    graph: null,
    evaluation: null,
    plan: null,
    ideaGraph: snapshot.ideaGraph ?? null,
    ideaMoved: false,
    ideaEvents: [],
    ideaTasks: [],
    findings: [],
    foldedSteers: [],
    ideaOptions: {
      ...(options.ideaGraph?.enabled !== undefined ? { enabled: options.ideaGraph.enabled } : {}),
      ...(options.ideaGraph?.model ? { model: options.ideaGraph.model } : {}),
      ...(options.ideaGraph?.maxExpansions !== undefined ? { maxExpansions: options.ideaGraph.maxExpansions } : {}),
      ...(options.ideaGraph?.reviewerModel !== undefined ? { reviewerModel: options.ideaGraph.reviewerModel } : {}),
    },
    actions: snapshot.everflow?.actions ?? null,
    actionsChanged: 0,
    actionsRun: 0,
    actionOptions: options.actions ?? {},
  };

  const result = await compiled.invoke(threadId, initial, {
    ...(options.interruptBefore ? { interruptBefore: options.interruptBefore } : {}),
  });
  if (result.interrupted) {
    // A compiled pause point fired: the state is checkpointed; the caller
    // resumes with the same thread. The pass runner never sets interrupts
    // today — this branch exists for the verifier + future gates.
    throw new Error(`Pass interrupted before "${result.interrupted}" (thread ${threadId}).`);
  }
  const final = result.state;
  const plan = final.plan ?? emptyPlan();
  const progressed =
    plan.newTasks.length + plan.followUps.length + plan.processedInjections.length + final.findings.length + (final.ideaMoved ? 1 : 0) + final.actionsChanged > 0;
  return { state: final.snapshot, graph: final.graph!, evaluation: final.evaluation!, plan, progressed, path: result.path };
}
