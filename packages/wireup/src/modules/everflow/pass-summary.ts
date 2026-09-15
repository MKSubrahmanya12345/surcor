/**
 * Everflow — the pass event's text, built in ONE place.
 *
 * Both pass runners (the legacy straight-line one and the StateGraph one)
 * must emit identical messages for identical work — `pnpm verify:graph`
 * asserts that equivalence. Sharing the builder is what makes the act phase
 * (and everything else) parity-safe by construction instead of by luck.
 */

import type { EverflowEvaluation } from '@/types/everflow';

export interface PassSummaryInput {
  pass: number;
  trigger: string;
  evaluation: EverflowEvaluation;
  tasksFiled: number;
  docsChecked: number;
  injectionsProcessed: number;
  ideaMoved: boolean;
  ideaGraph?: { expansions: number; phase: string } | null;
  steersFolded: number;
  /** Act phase: moves that changed the project / moves recorded in total. */
  actionsChanged: number;
  actionsRun: number;
  runner: 'legacy' | 'graph';
}

export function passEventMessage(input: PassSummaryInput): string {
  if (input.evaluation.done) {
    return `Everflow pass ${input.pass} (${input.trigger}): every goal satisfied — the project is complete.`;
  }
  const pct = Math.round(input.evaluation.completion * 100);
  return `Everflow pass ${input.pass} (${input.trigger}): ${pct}% complete, ${input.evaluation.totals.openEnds} dangling, ${input.tasksFiled} ask(s) filed${
    input.ideaMoved ? ', idea graph advanced' : ''
  }${input.docsChecked > 0 ? `, ${input.docsChecked} doc check(s) recorded` : ''}${
    input.steersFolded > 0 ? `, ${input.steersFolded} steer(s) folded mid-pass` : ''
  }${input.actionsChanged > 0 ? `, ${input.actionsChanged} loop move(s) changed the project` : ''}.`;
}

export function passEventMetadata(input: PassSummaryInput): Record<string, unknown> {
  const pct = Math.round(input.evaluation.completion * 100);
  return {
    trigger: input.trigger,
    pass: input.pass,
    completion: pct,
    done: input.evaluation.done,
    blockedOnHuman: input.evaluation.blockedOnHuman,
    openEnds: input.evaluation.totals.openEnds,
    tasksFiled: input.tasksFiled,
    docsChecked: input.docsChecked,
    injectionsProcessed: input.injectionsProcessed,
    ideaGraphMoved: input.ideaMoved,
    steersFolded: input.steersFolded,
    actionsRun: input.actionsRun,
    actionsChanged: input.actionsChanged,
    runner: input.runner,
    ...(input.ideaGraph ? { ideaGraphExpansions: input.ideaGraph.expansions, ideaGraphPhase: input.ideaGraph.phase } : {}),
  };
}
