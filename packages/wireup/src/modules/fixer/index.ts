/**
 * FIXER MODULE — the targeted repair loop.
 *
 * Contract:
 *   • it never regenerates a project; it patches the existing artifacts;
 *   • every mutation is a typed `FixChange` recorded in a changeset;
 *   • deterministic engineering repairs run first, the model is only asked for
 *     what the deterministic strategies cannot safely do;
 *   • anything rejected is reported with a reason (nothing fails silently).
 */

import type { ComponentDefinition } from '@/types/component';
import type { FixChange, FixChangeOp, FixResult } from '@/types/generation';
import type { AgentEventLog } from '@/lib/logging/events';
import type { LlmCallRecord, ProjectState } from '@/types/project';
import type { ArtifactKind, ValidationIssue, ValidationResult } from '@/types/validation';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';

import { describeBedrockConfig } from '@/lib/bedrock';
import { logger } from '@/lib/logging/logger';

import { applyChanges, type ApplyOutput, type FixerRefreshers } from './apply';
import { proposeModelChanges } from './llm';
import { changeSignature, planDeterministicChanges, type UnresolvedIssue } from './strategies';

const ARTIFACT_BY_OP: Record<FixChangeOp, ArtifactKind> = {
  set_field: 'requirements',
  add_component: 'components',
  replace_component: 'components',
  remove_component: 'components',
  set_quantity: 'components',
  set_pin_assignment: 'pinAssignments',
  remove_pin_assignment: 'pinAssignments',
  add_connection: 'wiring',
  replace_connection: 'wiring',
  remove_connection: 'wiring',
  patch_code_file: 'code',
  add_code_file: 'code',
  remove_code_file: 'code',
  set_libraries: 'libraries',
  add_library: 'libraries',
  remove_library: 'libraries',
  patch_instructions: 'instructions',
  prune_assembly: 'assembly',
  rerun_stage: 'diagram',
};

export interface FixerInput {
  project: ProjectState;
  validation: ValidationResult;
  catalog: ComponentDefinition[];
  catalogContext: string;
  mcuContext: string;
  profile?: McuProfile;
  /** Zero-based fix iteration (0 = first fix pass). */
  iteration: number;
  events?: AgentEventLog;
  enableLlmFixer?: boolean;
  /** Deterministic re-derivations the orchestrator knows how to perform. */
  refresh?: FixerRefreshers;
}

export interface FixOutcome {
  /** Patched project state (a new object; the input is never mutated). */
  project: ProjectState;
  result: FixResult;
  llmCall?: LlmCallRecord;
  unresolved: UnresolvedIssue[];
  notes: string[];
}

/** Blocking issues first, then auto-fixable warnings. */
function issuesToRepair(validation: ValidationResult): ValidationIssue[] {
  const errors = validation.issues.filter((issue) => issue.severity === 'error');
  const warnings = validation.issues.filter((issue) => issue.severity === 'warning' && issue.autoFixable);
  return [...errors, ...warnings];
}

export async function fixProject(input: FixerInput): Promise<FixOutcome> {
  const { project, validation, catalog, iteration, events } = input;
  const startedAt = Date.now();

  const targets = issuesToRepair(validation);
  const codes = Array.from(new Set(targets.map((issue) => issue.code)));

  const handle = events?.start('fix_started', `Targeted fix pass ${iteration + 1} — ${targets.length} issue(s) to repair (${codes.slice(0, 6).join(', ')}${codes.length > 6 ? ', …' : ''}).`, {
    stage: 'fixing',
    metadata: {
      iteration,
      issues: targets.length,
      codes: codes.slice(0, 12),
      autoFixable: targets.filter((issue) => issue.autoFixable).length,
    },
  });

  /* --- 1. Deterministic strategies ---------------------------------------- */
  const deterministic = planDeterministicChanges({
    project,
    issues: targets,
    catalog,
    ...(input.profile ? { profile: input.profile } : {}),
    iteration,
  });

  const changes: FixChange[] = [...deterministic.changes];
  const seen = new Set(changes.map(changeSignature));
  const notes: string[] = [...deterministic.notes];

  /* --- 2. Model proposals for what stayed unresolved ---------------------- */
  const remaining = targets.filter((issue) => !deterministic.handledIssueIds.includes(issue.id));
  let llmCall: LlmCallRecord | undefined;
  let modelRejections: { op: string; reason: string }[] = [];

  const bedrock = await describeBedrockConfig();
  const llmEnabled = input.enableLlmFixer !== false && bedrock.configured;

  if (remaining.length > 0 && llmEnabled) {
    const proposal = await proposeModelChanges({
      project,
      issues: remaining,
      catalog,
      catalogContext: input.catalogContext,
      mcuContext: input.mcuContext,
      iteration,
      ...(events ? { events } : {}),
    });
    llmCall = proposal.call;
    modelRejections = proposal.rejected;
    notes.push(...proposal.notes);

    if (proposal.error) {
      notes.push(`Model fixer unavailable: ${proposal.error}. Deterministic repairs were still applied.`);
    }

    for (const change of proposal.changes) {
      const signature = changeSignature(change);
      if (seen.has(signature)) continue;
      seen.add(signature);
      changes.push(change);
    }
    notes.push(
      `${proposal.changes.length} model-proposed change(s) considered, ${proposal.changes.length - (changes.length - deterministic.changes.length)} duplicate(s) suppressed.`,
    );
  } else if (remaining.length > 0) {
    notes.push(
      bedrock.configured
        ? `${remaining.length} issue(s) have no deterministic repair and the model fixer is disabled (WIREUP_ENABLE_LLM_FIXER=false).`
        : `${remaining.length} issue(s) have no deterministic repair${bedrock.problem ? ` and Bedrock is unavailable (${bedrock.problem})` : ''}.`,
    );
  }

  /* --- 3. Apply the changeset -------------------------------------------- */
  const applyInput = {
    project,
    changes,
    catalog,
    ...(input.profile ? { profile: input.profile } : {}),
    iteration,
    ...(events ? { events } : {}),
    syncFirmware: targets.some((issue) => issue.domain === 'code' || issue.domain === 'libraries' || issue.domain === 'pins'),
    ...(input.refresh ? { refresh: input.refresh } : {}),
  };

  let apply: ApplyOutput;
  try {
    apply = await applyChanges(applyInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    handle?.fail(`Fix pass ${iteration + 1} failed: ${message}`, message, { iteration });
    logger.error({ err: error, projectId: project.id, iteration }, 'fixer: applier crashed');
    return {
      project,
      result: {
        changes,
        applied: [],
        rejected: [{ id: 'applier', op: 'apply', artifact: 'requirements', reason: message }],
        touchedArtifacts: [],
        notes: [`Fixer failed: ${message}`],
      },
      ...(llmCall ? { llmCall } : {}),
      unresolved: deterministic.unresolved,
      notes: [`Fixer failed: ${message}`],
    };
  }

  const rejected: FixResult['rejected'] = [
    ...apply.rejected,
    ...modelRejections.map((entry, index) => ({
      id: `model-reject-${index + 1}`,
      op: entry.op,
      artifact: ARTIFACT_BY_OP[entry.op as FixChangeOp] ?? 'requirements',
      reason: entry.reason,
    })),
  ];

  for (const stage of apply.pendingStages) {
    notes.push(`Stage "${stage}" was requested but no deterministic re-derivation is available in this run.`);
  }
  for (const issue of deterministic.unresolved) {
    notes.push(`${issue.issue.code}: ${issue.reason}`);
  }

  const result: FixResult = {
    changes: apply.changes,
    applied: apply.applied,
    rejected,
    touchedArtifacts: apply.touchedArtifacts,
    notes: [...new Set([...notes, ...apply.notes])],
  };

  const durationMs = Date.now() - startedAt;
  const modelHandled = new Set(
    apply.changes.filter((change) => change.origin === 'model' && change.issueId).map((change) => change.issueId as string),
  );
  const stillUnresolved = deterministic.unresolved.filter((entry) => !modelHandled.has(entry.issue.id));

  if (apply.applied.length === 0) {
    handle?.fail(
      `Fix pass ${iteration + 1} produced no applicable change (${rejected.length} rejected).`,
      rejected.map((entry) => `${entry.op}: ${entry.reason}`).join(' | ').slice(0, 500),
      { iteration, rejected: rejected.length, durationMs },
    );
  } else {
    handle?.complete(
      `Fix pass ${iteration + 1} applied ${apply.applied.length} targeted change(s) across ${apply.touchedArtifacts.join(', ') || 'no artifacts'}${rejected.length > 0 ? `; ${rejected.length} rejected` : ''}.`,
      {
        iteration,
        applied: apply.applied.length,
        rejected: rejected.length,
        touchedArtifacts: apply.touchedArtifacts,
        changes: apply.changes.length,
        unresolved: stillUnresolved.length,
        durationMs,
      },
    );
  }

  logger.info(
    {
      projectId: project.id,
      iteration,
      changes: apply.changes.length,
      applied: apply.applied.length,
      rejected: rejected.length,
      touched: apply.touchedArtifacts,
      durationMs,
    },
    'fix pass complete',
  );

  return {
    project: apply.project,
    result,
    ...(llmCall ? { llmCall } : {}),
    unresolved: stillUnresolved,
    notes: result.notes,
  };
}

export { applyChanges, type FixerRefreshers, type RefreshResult } from './apply';
export { proposeModelChanges, normaliseModelChange, MAX_MODEL_CHANGES } from './llm';
export { changeSignature, chooseDriverFor, closestCatalogMatch, MAX_CHANGES_PER_PASS, planDeterministicChanges } from './strategies';
export { findFunctionBody, hasFunction, replaceFunctionBody } from './codePatch';
