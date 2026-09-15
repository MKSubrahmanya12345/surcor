/**
 * Everflow — the act phase (the loop's hands).
 *
 * The loop could already JUDGE every goal by code and NAME its next action
 * (`run_fix`, `verify_sim`) — but it could not EXECUTE anything: a pass could
 * only file human asks, advance the idea graph and read docs. The engineering
 * loop (validate ⇄ fix) was locked inside the build and could never be
 * re-entered, a canvas sync froze a revision without revalidating it, and a
 * behavioural promise the emulator had already proven could still only be
 * closed by a human.
 *
 * The act phase runs inside every continuation pass, AFTER the evaluation and
 * BEFORE the planner files asks — so a human is asked only what the loop
 * could not close itself. Three moves, in this order:
 *
 *   revalidate — the design fingerprint drifted since the validation the loop
 *                last observed (canvas sync, ladder repair, applied human
 *                input) → re-run the deterministic rule engine.
 *   reprove    — behavioural promises are unproven and the firmware/spec
 *                fingerprint drifted → re-run the behavioural emulator and
 *                merge per-assertion checks/issues, so `behaviour_proven`
 *                goals can be satisfied BY CODE.
 *   repair     — blocking issues remain → the loop's own targeted fix pass
 *                (deterministic strategies first, same mechanics as the idea
 *                ladder's node repair): changeset applied, revision frozen,
 *                revalidated. Never retries an identical issue signature.
 *
 * Invariants this file exists to keep:
 *   • goals are judged by code — moves consume the deterministic evaluator,
 *     rule engine and fixer; a model is never asked whether a goal is met;
 *   • offline-complete — every move runs with no credentials and no network
 *     (engine-only revalidation, deterministic fixer, host-shim emulator);
 *   • idempotent and bounded — content fingerprints guard repeats, budgets
 *     backstop them, and a repair that applied nothing is never retried on
 *     the same issue set;
 *   • never silent — every move (including skips and failures) is recorded in
 *     `everflow.actions.history` and emitted as an `everflow_move` event, and
 *     a design change freezes a revision like every other design change;
 *   • never blocks on a human — acting first is what makes the asks that
 *     remain genuinely human-shaped.
 */

import { createHash } from 'node:crypto';

import type { AgentEvent } from '@/types/generation';
import type { ComponentDefinition } from '@/types/component';
import type { ProjectRevision, ProjectState, ProjectStatus } from '@/types/project';
import type { ValidationResult } from '@/types/validation';
import type { EverflowActionRecord, EverflowActionState, EverflowMoveKind } from '@/types/everflow';

import { AgentEventLog } from '@/lib/logging/events';
import { describeError, logger } from '@/lib/logging/logger';
import { env } from '@/lib/validation/env';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';

import { behavioralFindings, evaluateBehavioral } from '@/modules/behaviour-evaluator';
import { getCatalog } from '@/modules/components';
import { fixProject } from '@/modules/fixer';
import { buildRefreshers, controllerInfo } from '@/modules/orchestrator/context';
import { appendRevision, createRevision, summariseChanges } from '@/modules/orchestrator/revisions';
import { understandPrompt } from '@/modules/project-understanding';
import { validateProject } from '@/modules/validator';
import { issueSignature } from '@/modules/validator/llm';
import { summariseIssues } from '@/modules/validator/rules';

/** Cap on the persisted move history (the audit trail, not the guard). */
const HISTORY_CAP = 20;

/** Statuses the act phase may operate on — finished designs, never a live build. */
const ACTABLE_STATUSES: ReadonlySet<ProjectStatus> = new Set(['completed', 'completed_with_warnings', 'completed_with_errors']);

/* ------------------------------------------------------------------------- */
/* Fingerprints — the idempotency guards                                      */
/* ------------------------------------------------------------------------- */

/** Deterministic JSON (sorted keys) so equal content always hashes equal. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

/**
 * Everything the rule engine reads. When this drifts, the validation on
 * record no longer describes the design in front of us.
 */
export function designFingerprint(state: ProjectState): string {
  return hash({
    prompt: state.prompt,
    requirements: state.requirements,
    components: state.components,
    hardwarePlan: state.hardwarePlan,
    pinAssignments: state.pinAssignments,
    wiring: state.wiring,
    artifacts: state.artifacts,
  });
}

/** Everything the behavioural evaluator reads (firmware, spec, pin roles). */
export function behaviorFingerprint(state: ProjectState): string {
  return hash({
    spec: state.requirements?.behavioralSpec ?? null,
    code: state.artifacts.code,
    pinAssignments: state.pinAssignments,
    selections: state.components.map((selection) => ({ id: selection.componentId, instances: selection.instances })),
  });
}

/** The exact issue set a repair would target — never retried unchanged. */
export function repairSignature(validation: ValidationResult): string {
  const targets = validation.issues.filter((issue) => issue.severity === 'error' || (issue.severity === 'warning' && issue.autoFixable));
  return hash(targets.map((issue) => issueSignature(issue)).sort());
}

/* ------------------------------------------------------------------------- */
/* Bookkeeping                                                                */
/* ------------------------------------------------------------------------- */

function hasBehavioralChecks(validation: ValidationResult | null): boolean {
  return Boolean(validation?.checks.some((check) => check.id.startsWith('behavioral.') || check.id === 'behavior.assertions'));
}

/**
 * Seed the act-phase bookkeeping for a project that has none. The pipeline's
 * fresh validation is trusted as the baseline (its fingerprints are recorded
 * as already-observed), and a blocking-issue set the build's own fix loop
 * just exhausted is recorded as already-attempted — the loop never blindly
 * retries what the pipeline proved unfixable moments ago. New evidence
 * (a revalidate, a reprove, a canvas sync) drifts the signatures and unlocks
 * a repair again.
 */
export function ensureActionState(state: ProjectState): EverflowActionState {
  const existing = state.everflow?.actions;
  if (existing) return existing;
  return {
    lastValidatedFingerprint: state.validation ? designFingerprint(state) : null,
    lastReprovedFingerprint: hasBehavioralChecks(state.validation) ? behaviorFingerprint(state) : null,
    lastRepairSignature: state.validation && state.validation.summary.errors > 0 ? repairSignature(state.validation) : null,
    repairsUsed: 0,
    reproofsUsed: 0,
    history: [],
    lastRunAt: null,
  };
}

/* ------------------------------------------------------------------------- */
/* The planner (pure)                                                         */
/* ------------------------------------------------------------------------- */

export interface ActionMove {
  move: EverflowMoveKind;
  /** Why this move, grounded in the state — shown in the record and event. */
  trigger: string;
}

export interface ActionPlan {
  moves: ActionMove[];
  description: string[];
}

/** Behavioural promises the evaluator has not proven (no passed per-assertion check). */
export function unprovenPromises(state: ProjectState): string[] {
  const assertions = state.requirements?.behavioralSpec?.assertions ?? [];
  if (assertions.length === 0) return [];
  return assertions
    .filter((assertion) => {
      const check = state.validation?.checks.find((entry) => entry.id === `behavioral.${assertion.id}`);
      return !check || check.status !== 'passed';
    })
    .map((assertion) => assertion.id);
}

/**
 * Decide what the loop DOES on this pass, before any ask is filed. Pure:
 * same state + bookkeeping in, same plan out. The executor re-checks every
 * guard against its working state, because an earlier move in the same pass
 * may have already done the work.
 */
export function planActions(
  state: ProjectState,
  actions: EverflowActionState,
  options: { maxRepairs: number; maxReproofs: number; maxRevisions: number },
): ActionPlan {
  const plan: ActionPlan = { moves: [], description: [] };

  if (!ACTABLE_STATUSES.has(state.status)) {
    plan.description.push(`Act phase idle — status "${state.status}" is not a finished design.`);
    return plan;
  }

  /* 1. revalidate — the design no longer matches the validation on record. */
  const designNow = designFingerprint(state);
  if (designNow !== actions.lastValidatedFingerprint) {
    plan.moves.push({
      move: 'revalidate',
      trigger: state.validation
        ? 'The design drifted since the validation the loop last observed.'
        : 'A finished design has no validation on record.',
    });
  }

  /* 2. reprove — unproven promises + drifted firmware/spec: try the emulator
   *    (or the static proofs) before asking a human to verify. */
  const unproven = unprovenPromises(state);
  const behaviorNow = behaviorFingerprint(state);
  if (unproven.length > 0 && behaviorNow !== actions.lastReprovedFingerprint) {
    if (actions.reproofsUsed >= options.maxReproofs) {
      plan.description.push(`Reprove budget spent (${actions.reproofsUsed}/${options.maxReproofs}) — ${unproven.length} promise(s) stay with the human channel.`);
    } else {
      plan.moves.push({
        move: 'reprove',
        trigger: `${unproven.length} behavioural promise(s) unproven and the firmware/spec changed — re-run the evaluator before asking a human.`,
      });
    }
  }

  /* 3. repair — blocking issues the loop has not already tried to fix. */
  const errors = state.validation?.summary.errors ?? 0;
  if (errors > 0 && state.validation) {
    const signature = repairSignature(state.validation);
    if (signature === actions.lastRepairSignature) {
      plan.description.push('Blocking issues match the last repair attempt — the same set is never retried; it belongs to the human review ask.');
    } else if (actions.repairsUsed >= options.maxRepairs) {
      plan.description.push(`Repair budget spent (${actions.repairsUsed}/${options.maxRepairs}) — the remaining issues belong to the human review ask.`);
    } else if (state.revision >= options.maxRevisions) {
      plan.description.push(`Revision cap reached (${state.revision}/${options.maxRevisions}) — no loop repair can freeze a revision.`);
    } else {
      plan.moves.push({
        move: 'repair',
        trigger: `${errors} blocking issue(s) the loop has not tried itself yet — run a deterministic fix pass (attempt ${actions.repairsUsed + 1} of ${options.maxRepairs}).`,
      });
    }
  }

  return plan;
}

/* ------------------------------------------------------------------------- */
/* The executor                                                               */
/* ------------------------------------------------------------------------- */

export interface ActOptions {
  /** Default: WIREUP_ENABLE_EVERFLOW_ACTIONS. */
  enabled?: boolean;
  /** Default: WIREUP_EVERFLOW_MAX_REPAIRS. */
  maxRepairs?: number;
  /** Default: WIREUP_EVERFLOW_MAX_REPROOFS. */
  maxReproofs?: number;
  /** Tests inject the catalog; production loads it lazily (offline-safe). */
  catalog?: ComponentDefinition[];
}

export interface ActResult {
  /** The working state after the moves (the input reference when nothing ran). */
  state: ProjectState;
  /** Updated bookkeeping — persist this even when nothing moved (seeding). */
  actions: EverflowActionState | null;
  /** One record per planned move (executed, skipped or failed). */
  records: EverflowActionRecord[];
  /** Sequenced events, ready to append after the pass saves. */
  sequencedEvents: (AgentEvent & { seq?: number })[];
  /** True when at least one move changed the project. */
  moved: boolean;
}

function statusAfterValidation(state: ProjectState): ProjectStatus {
  if (!state.validation || !ACTABLE_STATUSES.has(state.status)) return state.status;
  const { errors, warnings } = state.validation.summary;
  return errors > 0 ? 'completed_with_errors' : warnings > 0 ? 'completed_with_warnings' : 'completed';
}

/** Fold a fresh behavioural report into the validation on record. */
export function mergeBehavioralReport(validation: ValidationResult, report: ReturnType<typeof evaluateBehavioral>): ValidationResult {
  const findings = behavioralFindings(report);
  const isBehavioral = (id: string): boolean => id === 'behavior.assertions' || id.startsWith('behavioral.');
  const issues = [...validation.issues.filter((issue) => !isBehavioral(issue.id)), ...findings.issues];
  const checks = [...validation.checks.filter((check) => !isBehavioral(check.id)), ...findings.checks];
  const counts = summariseIssues(issues);
  return {
    ...validation,
    issues,
    checks,
    passed: counts.errors === 0,
    summary: {
      errors: counts.errors,
      warnings: counts.warnings,
      info: counts.info,
      checksRun: checks.length,
      checksPassed: checks.filter((check) => check.status === 'passed').length,
    },
    checkedAt: nowIso(),
    durationMs: report.durationMs,
  };
}

function behavioralSurface(validation: ValidationResult | null): string {
  if (!validation) return '';
  const checks = validation.checks.filter((check) => check.id.startsWith('behavioral.')).map((check) => `${check.id}=${check.status}`);
  const issues = validation.issues.filter((issue) => issue.id.startsWith('behavioral.')).map((issue) => issue.id);
  return [...checks.sort(), ...issues.sort()].join(';');
}

/**
 * Run the act phase for one pass. Never throws: a move that fails is recorded
 * and reported honestly, and the pass continues — the loop degrades to the
 * ask-only behaviour it had before, with the reason on the record.
 */
export async function runEverflowActions(state: ProjectState, pass: number, options: ActOptions = {}): Promise<ActResult> {
  const enabled = options.enabled ?? env().agent.everflowActionsEnabled;
  if (!enabled) {
    return { state, actions: state.everflow?.actions ?? null, records: [], sequencedEvents: [], moved: false };
  }

  const maxRepairs = options.maxRepairs ?? env().agent.everflowMaxRepairs;
  const maxReproofs = options.maxReproofs ?? env().agent.everflowMaxReproofs;
  const maxRevisions = Math.max(1, env().agent.maxRevisions);

  const seeded = ensureActionState(state);
  let actions: EverflowActionState = { ...seeded, history: [...seeded.history] };
  const records: EverflowActionRecord[] = [];
  const collected: AgentEvent[] = [];
  const baseSeq = state.events.reduce((max, event) => Math.max(max, event.seq), 0);
  const log = new AgentEventLog({ initialSeq: baseSeq, sink: (event) => collected.push(event) });

  let working: ProjectState = state;
  let moved = false;

  const plan = planActions(state, actions, { maxRepairs, maxReproofs, maxRevisions });

  const record = (move: EverflowMoveKind, trigger: string, outcome: EverflowActionRecord['outcome'], summary: string, extra: { fingerprint?: string; revision?: number; metadata?: Record<string, unknown> } = {}): void => {
    const entry: EverflowActionRecord = {
      id: createId('evact'),
      move,
      pass,
      at: nowIso(),
      trigger,
      outcome,
      summary,
      ...(extra.fingerprint ? { fingerprint: extra.fingerprint } : {}),
      ...(extra.revision !== undefined ? { revision: extra.revision } : {}),
      ...(extra.metadata ? { metadata: extra.metadata } : {}),
    };
    records.push(entry);
    actions.history = [...actions.history, entry].slice(-HISTORY_CAP);
    actions.lastRunAt = entry.at;
    log.emit('everflow_move', `Everflow move ${move} (${outcome}) — ${summary}`, {
      stage: 'completed',
      metadata: { move, outcome, trigger, pass, ...(extra.metadata ?? {}) },
    });
    if (outcome === 'changed') moved = true;
  };

  const loadCatalog = async (): Promise<ComponentDefinition[]> => {
    if (options.catalog) return options.catalog;
    const catalogState = await getCatalog();
    return catalogState.components;
  };

  for (const planned of plan.moves) {
    try {
      /* ---------------- revalidate ---------------- */
      if (planned.move === 'revalidate') {
        const fingerprint = designFingerprint(working);
        if (fingerprint === actions.lastValidatedFingerprint) {
          record('revalidate', planned.trigger, 'skipped', 'An earlier move in this pass already revalidated this design.', { fingerprint });
          continue;
        }
        const catalog = await loadCatalog();
        const controller = controllerInfo(working, catalog);
        const outcome = await validateProject({
          project: working,
          catalog,
          catalogContext: '',
          mcuContext: '',
          ...(controller.profile ? { profile: controller.profile } : {}),
          iteration: working.iteration.current,
          events: log,
          // Engine-only: the deterministic rules are the source of engineering
          // truth; the model review belongs to the build, not to the loop's
          // cheap re-check. Honest about it in the record.
          enableModelReview: false,
        });
        const before = working.validation;
        const changed =
          !before ||
          before.passed !== outcome.result.passed ||
          before.summary.errors !== outcome.result.summary.errors ||
          before.summary.warnings !== outcome.result.summary.warnings;
        working = { ...working, validation: outcome.result };
        working = { ...working, status: statusAfterValidation(working) };
        actions.lastValidatedFingerprint = designFingerprint(working);
        record(
          'revalidate',
          planned.trigger,
          changed ? 'changed' : 'no_change',
          `Rule engine re-run on the drifted design — ${outcome.result.summary.errors} blocking, ${outcome.result.summary.warnings} warning(s).`,
          { fingerprint, metadata: { errors: outcome.result.summary.errors, warnings: outcome.result.summary.warnings, engineOnly: true } },
        );
        continue;
      }

      /* ---------------- reprove ---------------- */
      if (planned.move === 'reprove') {
        const fingerprint = behaviorFingerprint(working);
        if (fingerprint === actions.lastReprovedFingerprint) {
          record('reprove', planned.trigger, 'skipped', 'The firmware and spec are unchanged since the loop last ran the evaluator.', { fingerprint });
          continue;
        }
        if (!working.validation || !working.requirements) {
          record('reprove', planned.trigger, 'skipped', 'No validation or requirements on record to merge the evaluator outcome into.', { fingerprint });
          continue;
        }
        const surfaceBefore = behavioralSurface(working.validation);
        const report = evaluateBehavioral({
          requirements: working.requirements,
          code: working.artifacts.code,
          pinAssignments: working.pinAssignments,
          selections: working.components,
        });
        const merged = mergeBehavioralReport(working.validation, report);
        const changed = behavioralSurface(merged) !== surfaceBefore;
        working = { ...working, validation: merged };
        working = { ...working, status: statusAfterValidation(working) };
        actions.lastReprovedFingerprint = fingerprint;
        actions.reproofsUsed += 1;
        const proven = report.checks.filter((check) => check.status === 'passed').length;
        record(
          'reprove',
          planned.trigger,
          changed ? 'changed' : 'no_change',
          `Evaluator re-run — ${proven}/${report.checks.length} assertion(s) proven${report.runtimeRan ? ' (emulation ran)' : ' (static only)'}.`,
          { fingerprint, metadata: { proven, total: report.checks.length, runtimeRan: report.runtimeRan, ...(report.runtimeError ? { runtimeError: report.runtimeError } : {}) } },
        );
        continue;
      }

      /* ---------------- repair ---------------- */
      if (planned.move === 'repair') {
        const validation = working.validation;
        if (!validation || validation.summary.errors === 0) {
          record('repair', planned.trigger, 'skipped', 'An earlier move in this pass already cleared the blocking issues.');
          continue;
        }
        const signature = repairSignature(validation);
        if (signature === actions.lastRepairSignature) {
          record('repair', planned.trigger, 'skipped', 'The issue set matches the last repair attempt — never retried unchanged.');
          continue;
        }
        if (actions.repairsUsed >= maxRepairs) {
          record('repair', planned.trigger, 'skipped', `Repair budget spent (${actions.repairsUsed}/${maxRepairs}).`);
          continue;
        }
        if (working.revision >= maxRevisions) {
          record('repair', planned.trigger, 'skipped', `Revision cap reached (${working.revision}/${maxRevisions}).`);
          continue;
        }

        const catalog = await loadCatalog();
        const nextRevision = working.revision + 1;
        const analysis = understandPrompt(working.prompt).analysis;
        const refreshers = buildRefreshers({ catalog, baseline: working, analysis });
        const fix = await fixProject({
          project: { ...working, revision: nextRevision, status: 'fixing', stage: 'fixing' },
          validation,
          catalog,
          catalogContext: '',
          mcuContext: '',
          iteration: actions.repairsUsed,
          events: log,
          // The loop's own attempt is deterministic-first: the model fixer
          // already ran in the build's fix loop; retrying it here would spend
          // tokens on the same wall. The human review ask is the escalation.
          enableLlmFixer: false,
          refresh: refreshers,
        });

        actions.repairsUsed += 1;
        actions.lastRepairSignature = signature;

        if (fix.result.applied.length === 0) {
          const reason = fix.unresolved[0]?.reason ?? 'the fixer applied nothing';
          record('repair', planned.trigger, 'no_change', `Loop fix pass applied nothing (${reason}) — this exact set is never retried; it escalates to the human review ask.`, {
            metadata: { applied: 0, rejected: fix.result.rejected.length, unresolved: fix.unresolved.length },
          });
          // Nothing was applied — keep the working state exactly as it was
          // (the fixer's copy carries transient `fixing` status/stage).
          continue;
        }

        const revision: ProjectRevision = createRevision({
          project: fix.project,
          version: nextRevision,
          reason: 'targeted_fix',
          summary: `Everflow act-phase repair: ${summariseChanges(fix.result.changes)}.`,
          changes: fix.result.changes,
          addressedIssueIds: validation.issues.filter((issue) => issue.severity === 'error' || issue.autoFixable).map((issue) => issue.id),
          validation,
          stage: 'fixing',
        });
        working = { ...fix.project, revisions: appendRevision(fix.project, revision), revision: nextRevision };

        // Revalidate deterministically so the re-evaluation sees fresh checks
        // (the same contract the idea ladder's node repair keeps).
        const controller = controllerInfo(working, catalog);
        const fresh = await validateProject({
          project: working,
          catalog,
          catalogContext: '',
          mcuContext: '',
          ...(controller.profile ? { profile: controller.profile } : {}),
          iteration: 0,
          enableModelReview: false,
        });
        // The fixer's copy carries the transient `fixing` status/stage — the
        // design is finished again now, so normalise back into the completed
        // family honestly (errors → completed_with_errors).
        const afterRepair: ProjectStatus =
          fresh.result.summary.errors > 0 ? 'completed_with_errors' : fresh.result.summary.warnings > 0 ? 'completed_with_warnings' : 'completed';
        working = { ...working, validation: fresh.result, status: afterRepair, stage: 'completed' };
        actions.lastValidatedFingerprint = designFingerprint(working);

        record(
          'repair',
          planned.trigger,
          'changed',
          `Loop fix pass applied ${fix.result.applied.length} change(s) — revision v${nextRevision} frozen; revalidated with ${fresh.result.summary.errors} blocking issue(s) left.`,
          { revision: nextRevision, metadata: { applied: fix.result.applied.length, rejected: fix.result.rejected.length, errorsLeft: fresh.result.summary.errors, codes: fix.result.changes.map((change) => change.op).slice(0, 8) } },
        );
      }
    } catch (error) {
      const described = describeError(error);
      logger.warn({ err: described.message, move: planned.move }, 'everflow act move failed');
      record(planned.move, planned.trigger, 'failed', `Move failed — ${described.message}`);
    }
  }

  return { state: working, actions, records, sequencedEvents: collected, moved };
}
