/**
 * Everflow — the planner (pure, deterministic, offline-testable).
 *
 * Moved verbatim out of `continuation.ts` so the legacy pass runner AND the
 * StateGraph pass (`pass-graph.ts`) plan from the same code: same
 * state/evaluation in, same plan out, idempotent per open task. Nothing here
 * performs I/O.
 */

import type { EverflowEvaluation, EverflowGraph, HumanTask } from '@/types/everflow';
import type { ProjectState } from '@/types/project';
import type { ValidationIssue, ValidationIssueCode } from '@/types/validation';

import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';

/**
 * Threshold configuration for human escalation.
 *
 * The fixer can leave behind issues that are:
 *   - Cosmetic (minor, don't affect functionality)
 *   - Single-issue (isolated, not systemic)
 *   - Warning-adjacent (low severity)
 *
 * These should auto-accept rather than bothering the user.
 */
export interface EscalationThreshold {
  /** Max errors that can auto-accept (vs escalate to human). */
  maxAutoAcceptErrors: number;
  /** Issue codes considered "cosmetic" — auto-accepted if no serious issues. */
  cosmeticCodes: ValidationIssueCode[];
  /** Max ratio of cosmetic issues to total (if higher, escalate). */
  maxCosmeticRatio: number;
}

/** Default threshold: auto-accept up to 2 cosmetic issues, escalate on structural problems. */
export const DEFAULT_ESCALATION_THRESHOLD: EscalationThreshold = {
  maxAutoAcceptErrors: 2,
  cosmeticCodes: [
    'diagram_out_of_sync',      // Visual-only, doesn't affect hardware
    'instructions_out_of_sync', // Documentation issue
    'library_unused',           // Extra library, harmless
    'code_stray_include',       // Extra include, harmless
    'model_review',             // Model suggestion, not a hard error
  ],
  maxCosmeticRatio: 1.0, // If all remaining issues are cosmetic, auto-accept
};

/**
 * Classify remaining validation issues to decide whether to escalate to human.
 *
 * Returns:
 *   - escalate: true if human review needed
 *   - reason: explanation for the decision
 *   - autoAcceptable: issues that can be silently accepted
 *   - serious: issues that would require human attention
 */
function classifyIssues(
  issues: ValidationIssue[],
  threshold: EscalationThreshold,
): {
  escalate: boolean;
  reason: string;
  autoAcceptable: ValidationIssue[];
  serious: ValidationIssue[];
} {
  const cosmeticSet = new Set(threshold.cosmeticCodes);
  const autoAcceptable: ValidationIssue[] = [];
  const serious: ValidationIssue[] = [];

  for (const issue of issues) {
    if (cosmeticSet.has(issue.code)) {
      autoAcceptable.push(issue);
    } else {
      serious.push(issue);
    }
  }

  // Escalate if there are serious issues
  if (serious.length > 0) {
    return {
      escalate: true,
      reason: `${serious.length} serious issue(s) require human review`,
      autoAcceptable,
      serious,
    };
  }

  // Escalate if too many cosmetic issues
  if (autoAcceptable.length > threshold.maxAutoAcceptErrors) {
    return {
      escalate: true,
      reason: `${autoAcceptable.length} cosmetic issues exceed threshold (${threshold.maxAutoAcceptErrors})`,
      autoAcceptable,
      serious,
    };
  }

  // Auto-accept: all remaining issues are cosmetic and within threshold
  return {
    escalate: false,
    reason: `All ${autoAcceptable.length} remaining issue(s) are cosmetic — auto-accepting`,
    autoAcceptable,
    serious,
  };
}

export interface PlanResult {
  /** ai→human tasks to file this pass. */
  newTasks: HumanTask[];
  /** human→ai task ids the agent now claims (status → `processed`). */
  processedInjections: string[];
  /** follow-up asks filed for processed additions. */
  followUps: HumanTask[];
  description: string[];
}

export const EVERFLOW_DEFAULT_MAX_HUMAN_TASKS = 12;

export function makeTask(partial: Omit<HumanTask, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'response'>, at: string): HumanTask {
  return {
    id: createId('htask'),
    status: 'open',
    response: null,
    createdAt: at,
    updatedAt: at,
    ...partial,
  };
}

/**
 * Decide what the agent does on this pass. Pure: same state/evaluation in,
 * same plan out. Idempotent per open task — a goal with an open task linked
 * never gets a duplicate filed.
 */
export function planContinuation(state: ProjectState, graph: EverflowGraph, evaluation: EverflowEvaluation, maxHumanTasks = EVERFLOW_DEFAULT_MAX_HUMAN_TASKS): PlanResult {
  const at = nowIso();
  const result: PlanResult = { newTasks: [], processedInjections: [], followUps: [], description: [] };

  if (evaluation.done) {
    result.description.push('All goals satisfied and nothing dangling — the project is done.');
    return result;
  }

  const openAiTasks = state.humanTasks.filter((task) => task.direction === 'ai_to_human' && task.status === 'open');
  const linkedBy = (nodeId: string): HumanTask | undefined =>
    openAiTasks.find((task) => task.linkedNodeIds.includes(nodeId));

  const fileTask = (task: HumanTask): void => {
    if (state.humanTasks.length + result.newTasks.length + result.followUps.length >= maxHumanTasks) {
      result.description.push(`Task budget (${maxHumanTasks}) reached — "${task.title}" stays parked without a filed ask.`);
      return;
    }
    result.newTasks.push(task);
    result.description.push(`Filed AI→human ${task.type} ask: "${task.title}".`);
  };

  /* 1. Behavioural goals the evaluator could not prove → human verification. */
  for (const outcome of evaluation.results) {
    const node = graph.nodes.find((candidate) => candidate.id === outcome.nodeId);
    if (!node || node.kind !== 'goal' || node.goal.kind !== 'behaviour_proven') continue;
    if (outcome.satisfied) continue;
    if (linkedBy(node.id)) continue;
    fileTask(
      makeTask(
        {
          direction: 'ai_to_human',
          type: 'verify',
          title: `Confirm: ${node.label}`,
          body: `The evaluator cannot prove this from the source alone. Run the project in the simulator (or on the bench) and tell me whether it holds.`,
          asks: { shape: 'boolean', options: ['Yes, it works', 'No, it does not'], positiveOptions: ['Yes, it works'] },
          linkedNodeIds: [node.id],
          lookAt: { kind: 'sim', ref: `/project/${state.id}/simulation`, label: 'Open the simulator' },
          priority: 'medium',
          defaultOnExpiry: 'defer',
          assumptionIfSkipped: `Unverified: ${node.content} — assumed on paper only.`,
          source: 'ai',
        },
        at,
      ),
    );
  }

  /* 2. Unconfirmed assumptions → one consolidated confirmation ask. */
  const openAssumptions = evaluation.results.filter((outcome) => outcome.kind === 'assumption' && !outcome.satisfied);
  if (openAssumptions.length > 0 && !state.humanTasks.some((task) => task.status === 'open' && task.direction === 'ai_to_human' && task.type === 'context' && task.linkedNodeIds.some((id) => id.startsWith('ev-assume-')))) {
    const linked = openAssumptions.slice(0, 3).map((outcome) => outcome.nodeId);
    fileTask(
      makeTask(
        {
          direction: 'ai_to_human',
          type: 'context',
          title: `Confirm or correct ${openAssumptions.length} assumption(s)`,
          body: openAssumptions.slice(0, 3).map((outcome) => `• ${graph.nodes.find((node) => node.id === outcome.nodeId)?.content}`).join('\n') + (openAssumptions.length > 3 ? `\n• …and ${openAssumptions.length - 3} more` : ''),
          asks: { shape: 'text', positiveOptions: ['Confirmed, as-is', 'Confirmed'] },
          linkedNodeIds: linked,
          lookAt: { kind: 'project', ref: `/project/${state.id}/everflow`, label: 'See the graph' },
          priority: 'high',
          defaultOnExpiry: 'assume',
          assumptionIfSkipped: 'Assumptions stand as recorded; revisit them from the Everflow tab.',
          source: 'ai',
        },
        at,
      ),
    );
  }

  /* 3. Blocking validation issues the fixer could not repair → review ask.
   *
   * THRESHOLD LOGIC: Not all surviving errors are equal. Cosmetic issues
   * (diagram out of sync, unused libraries, etc.) are auto-accepted with a
   * note. Only serious issues (compatibility, pin conflicts, compile errors)
   * escalate to human review.
   */
  const validationErrors = state.validation?.summary.errors ?? 0;
  const errorIssues = state.validation?.issues.filter((i) => i.severity === 'error') ?? [];

  if (validationErrors > 0 && !state.humanTasks.some((task) => task.status === 'open' && task.direction === 'ai_to_human' && task.type === 'review')) {
    const classification = classifyIssues(errorIssues, DEFAULT_ESCALATION_THRESHOLD);

    if (classification.escalate) {
      // Serious issues: escalate to human
      fileTask(
        makeTask(
          {
            direction: 'ai_to_human',
            type: 'review',
            title: `${classification.serious.length} blocking issue(s) survived the fix loop`,
            body: `I repaired what I could deterministically; ${classification.reason}. Look at the issues and tell me which to accept, drop or change.`,
            asks: { shape: 'text', positiveOptions: ['Accept as-is', 'Accepted'] },
            linkedNodeIds: ['ev-goal-validation'],
            lookAt: { kind: 'quality', ref: `/project/${state.id}/quality`, label: 'Open Check & fix' },
            priority: 'high',
            defaultOnExpiry: 'halt',
            assumptionIfSkipped: 'Design call pending — the project stays flagged completed_with_errors.',
            source: 'ai',
          },
          at,
        ),
      );
    } else {
      // Cosmetic issues only: auto-accept with a note
      result.description.push(`Auto-accepted ${classification.autoAcceptable.length} cosmetic issue(s): ${classification.reason}`);
      for (const issue of classification.autoAcceptable) {
        result.description.push(`  - ${issue.code}: ${issue.message}`);
      }
    }
  }

  /* 4. Human → AI additions waiting for the agent. */
  for (const task of state.humanTasks) {
    if (task.direction !== 'human_to_ai' || task.status !== 'open') continue;
    result.processedInjections.push(task.id);
    result.description.push(`Registered your addition: "${task.title}".`);
    if (task.type === 'idea' || task.type === 'correction' || task.type === 'resource' || task.type === 'steer') {
      const apply = makeTask(
        {
          direction: 'ai_to_human',
          type: 'choose',
          title: `Apply “${task.title.slice(0, 60)}” to the build?`,
          body: `You added: ${task.response?.value ?? task.body}\n\nApplying it re-runs the pipeline as a new revision (your current design is preserved as a diff).`,
          asks: { shape: 'choice', options: ['Apply — replan as a new revision', 'Note only, keep the current design'] },
          linkedNodeIds: [task.linkedNodeIds[0] ?? 'ev-intent'],
          lookAt: { kind: 'project', ref: `/project/${state.id}/everflow`, label: 'See the addition' },
          priority: 'high',
          defaultOnExpiry: 'defer',
          assumptionIfSkipped: 'Held as a note; nothing was changed in the design.',
          source: 'ai',
        },
        at,
      );
      result.followUps.push(apply);
      result.description.push(`Filed follow-up: apply “${task.title.slice(0, 40)}” to the build?`);
    }
  }

  return result;
}
