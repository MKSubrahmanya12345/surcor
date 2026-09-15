/**
 * Everflow — the idea-graph move inside a continuation pass.
 *
 * Extracted verbatim from `runEverflowPass` so the legacy runner and the
 * StateGraph pass (`pass-graph.ts`) execute the same move: one expansion,
 * then the phase hand-overs (testing ladder → swarm → fresh-context
 * reviewer). Same inputs, same events, same tasks — the extraction is
 * mechanical, and `pnpm verify:idea-graph` proves the behaviour did not move.
 */

import type { AgentEvent } from '@/types/generation';
import type { HumanTask, IdeaGraphState } from '@/types/everflow';
import type { ProjectState } from '@/types/project';

import { env } from '@/lib/validation/env';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import { getCatalog } from '@/modules/components';

import { expansionMove, type ExpansionModel } from './decompose';
import { testLadderMove } from './test-ladder';
import { reviewerMove, type ReviewerInput } from './reviewer';
import { swarmMove } from './swarm';
import { makeTask } from './planner';

export interface IdeaMovesOptions {
  enabled?: boolean;
  model?: ExpansionModel;
  maxExpansions?: number;
  maxRepairs?: number;
  /** Injected fresh-context reviewer (tests); production wires Bedrock lazily. */
  reviewerModel?: { review(input: ReviewerInput): Promise<{ verdict: string; findings: unknown[]; question?: string } | null | 'unavailable'> } | null;
}

/** Lazily wire the Bedrock-backed model (keeps the AWS SDK out of offline runs). */
async function productionExpansionModel(): Promise<ExpansionModel | null> {
  if (!env().bedrock.modelId) return null;
  try {
    const { bedrockExpansionModel } = await import('./expansion-model');
    return bedrockExpansionModel();
  } catch {
    return null;
  }
}

export interface IdeaMovesResult {
  moved: boolean;
  ideaGraph: IdeaGraphState | null;
  /** Raw move events (unsequenced). */
  rawEvents: { type: AgentEvent['type']; status: AgentEvent['status']; message: string; metadata: Record<string, unknown> }[];
  /** The same events, sequenced and ready to append to the store. */
  sequencedEvents: (AgentEvent & { seq?: number })[];
  newTasks: HumanTask[];
  /** The ladder may repair artifacts — the pass persists THIS state. */
  passState: ProjectState;
}

export async function runIdeaMoves(state: ProjectState, projectId: string, options: IdeaMovesOptions = {}): Promise<IdeaMovesResult> {
  let ideaGraph: IdeaGraphState | null = state.ideaGraph ?? null;
  const rawIdeaEvents: IdeaMovesResult['rawEvents'] = [];
  let ideaTasks: HumanTask[] = [];
  let ideaMoved = false;
  let passState: ProjectState = state;

  const ideaEnabled = options.enabled ?? env().agent.ideaGraphEnabled;
  if (ideaEnabled) {
    const at = nowIso();
    const model = options.model ?? (await productionExpansionModel());
    const makeIdeaTask = (task: {
      type: 'review' | 'verify' | 'choose';
      title: string;
      body: string;
      linkedNodeId: string;
      defaultOnExpiry: 'defer' | 'assume' | 'halt';
      assumptionIfSkipped: string;
      shape: 'text' | 'boolean' | 'choice';
      options?: string[];
      positiveOptions?: string[];
    }): HumanTask =>
      makeTask(
        {
          direction: 'ai_to_human',
          type: task.type,
          title: task.title,
          body: task.body,
          asks: { shape: task.shape, ...(task.options ? { options: task.options } : {}), ...(task.positiveOptions ? { positiveOptions: task.positiveOptions } : {}) },
          linkedNodeIds: [task.linkedNodeId],
          lookAt: { kind: 'project', ref: `/project/${projectId}/everflow`, label: 'See the idea graph' },
          priority: task.type === 'choose' ? 'high' : 'medium',
          defaultOnExpiry: task.defaultOnExpiry,
          assumptionIfSkipped: task.assumptionIfSkipped,
          source: 'ai',
        },
        at,
      );

    const move = await expansionMove(state, {
      maxExpansions: options.maxExpansions ?? env().agent.ideaGraphMaxExpansions,
      ...(model ? { model } : {}),
    });
    if (move.moved) {
      ideaMoved = true;
      ideaGraph = move.ideaGraph;
      rawIdeaEvents.push(...move.events);
      ideaTasks.push(...move.newTasks.map((task) => makeIdeaTask({ ...task, shape: 'text', positiveOptions: ['Accepted as-is', 'Accepted'] })));
    }

    /* Phase hand-over: once the graph finished expanding, the ladder tests
     * every leaf (repair within budget, escalate the stubborn ones). */
    if (ideaGraph && ideaGraph.phase === 'testing') {
      try {
        const catalog = (await getCatalog()).components;
        const ladder = await testLadderMove(state, { catalog, maxRepairs: options.maxRepairs ?? env().agent.ideaGraphMaxNodeRepairs });
        if (ladder.moved) {
          ideaGraph = ladder.ideaGraph;
          passState = ladder.state;
          ideaMoved = true;
          rawIdeaEvents.push(...ladder.events);
          ideaTasks.push(
            ...ladder.newTasks.map((task) =>
              makeIdeaTask({
                ...task,
                positiveOptions: task.type === 'verify' ? ['Yes, it works'] : ['Accept as a documented limitation'],
              }),
            ),
          );
        }
      } catch (error) {
        // The ladder is best-effort inside the pass; a catalog outage must
        // never fail the whole continuation pass — and is never faked.
        rawIdeaEvents.push({
          type: 'idea_graph_test',
          status: 'failed',
          message: `Ladder could not run (${error instanceof Error ? error.message : 'unknown'}) — the graph stays as-is; nothing was faked.`,
          metadata: { kind: 'idea_graph.test', error: true },
        });
        ideaMoved = true;
      }
    }

    /* Phase hand-over: the reviewer passed → the swarm owns the subtrees
     * (sequential, graph-only communication). */
    if (ideaGraph && ideaGraph.phase === 'swarming') {
      try {
        const swarm = swarmMove(passState);
        if (swarm.moved) {
          ideaGraph = swarm.ideaGraph;
          ideaMoved = true;
          rawIdeaEvents.push(...swarm.events);
        }
      } catch (error) {
        rawIdeaEvents.push({
          type: 'idea_graph_swarm',
          status: 'info',
          message: `Swarm move failed (${error instanceof Error ? error.message : 'unknown'}) — assignments unchanged.`,
          metadata: { kind: 'idea_graph.swarm', error: true },
        });
        ideaMoved = true;
      }
    }

    /* Phase hand-over: every leaf tested and no verdict yet → the
     * fresh-context reviewer runs ONCE (it never edits). */
    if (ideaGraph && ideaGraph.phase === 'reviewing' && !ideaGraph.reviewer) {
      try {
        const review = await reviewerMove(passState, options.reviewerModel ?? null);
        ideaGraph = review.ideaGraph;
        ideaMoved = true;
        rawIdeaEvents.push(...review.events);
        ideaTasks.push(...review.newTasks.map((task) => makeIdeaTask({ ...task, shape: 'text', positiveOptions: ['Accepted as-is', 'Accepted'] })));
      } catch (error) {
        rawIdeaEvents.push({
          type: 'idea_graph_review',
          status: 'failed',
          message: `Reviewer could not run (${error instanceof Error ? error.message : 'unknown'}) — no verdict was invented.`,
          metadata: { kind: 'idea_graph.review', error: true },
        });
        ideaMoved = true;
      }
    }
  }

  const sequencedEvents: IdeaMovesResult['sequencedEvents'] = [];
  if (ideaMoved) {
    const at = nowIso();
    const baseSeq = state.events.reduce((max, event) => Math.max(max, event.seq), 0);
    rawIdeaEvents.forEach((event, index) => {
      sequencedEvents.push({
        seq: baseSeq + 1 + index,
        id: createId('evt'),
        type: event.type,
        status: event.status,
        message: event.message,
        timestamp: at,
        stage: 'completed',
        metadata: event.metadata,
      });
    });
  }

  return { moved: ideaMoved, ideaGraph, rawEvents: rawIdeaEvents, sequencedEvents, newTasks: ideaTasks, passState };
}
