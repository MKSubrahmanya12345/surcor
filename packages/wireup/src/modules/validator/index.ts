/**
 * VALIDATOR MODULE.
 *
 * Two layers, always in this order:
 *   1. the deterministic rule engine (`./rules`) — it owns engineering truth
 *      (schema shape, catalog existence, pin capability, wiring completeness,
 *      power budget, firmware/pin agreement, diagram sync, docs);
 *   2. the Bedrock critical review (`./llm`) — optional, additive only. It
 *      receives the engine findings and may confirm, extend or refute them,
 *      but it can never remove an engine issue.
 *
 * Validation never throws: a Bedrock failure degrades to engine-only results
 * and is recorded in `engineError` so the UI can show why.
 */

import type { ComponentDefinition } from '@/types/component';
import type { AgentEventLog } from '@/lib/logging/events';
import type { LlmCallRecord, ProjectState } from '@/types/project';
import type { ModelReview, ValidationCheck, ValidationIssue, ValidationResult, ValidationSummary } from '@/types/validation';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';

import { describeBedrockConfig } from '@/lib/bedrock';
import { logger } from '@/lib/logging/logger';
import { nowIso, nowMs } from '@/lib/validation/time';

import { groupIssuesByArtifact, runRuleEngine, summariseIssues } from './rules';
import { issueSignature, runModelReview } from './llm';
import { behavioralFindings, evaluateBehavioral } from '@/modules/behaviour-evaluator';
import { compileFirmware, formatDiagnostic } from '@/modules/firmware-compiler';
import { validateWithRealSim } from '@/modules/sim-validator';
import { env } from '@/lib/validation/env';

export const ENGINE_VERSION = 'wireup-validator/1.0';

/** Highest number of blocking issues echoed as individual console events. */
const MAX_ERROR_EVENTS = 12;
const MAX_WARNING_EVENTS = 8;

export interface ValidatorInput {
  project: ProjectState;
  catalog: ComponentDefinition[];
  /** Pre-formatted catalog excerpt (same one the generator saw). */
  catalogContext: string;
  /** Pre-formatted MCU capability excerpt. */
  mcuContext: string;
  /** Controller profile used by the pin/wiring rules. */
  profile?: McuProfile;
  iteration: number;
  events?: AgentEventLog;
  enableModelReview?: boolean;
}

export interface ValidateProjectResult {
  result: ValidationResult;
  llmCall?: LlmCallRecord;
}

function summarise(issues: ValidationIssue[], checks: ValidationCheck[]): ValidationSummary {
  const counts = summariseIssues(issues);
  return {
    ...counts,
    checksRun: checks.length,
    checksPassed: checks.filter((check) => check.status === 'passed').length,
  };
}

export async function validateProject(input: ValidatorInput): Promise<ValidateProjectResult> {
  const { project, iteration, events } = input;
  const startedAt = nowMs();

  const bedrock = await describeBedrockConfig();
  const modelReviewEnabled = input.enableModelReview !== false && bedrock.configured;

  const startHandle = events?.start('validation_started', `Validation pass ${iteration + 1} starting...`, {
    stage: 'validating',
    metadata: {
      iteration,
      revision: iteration + 1,
      mode: modelReviewEnabled ? 'engine+model' : 'engine-only',
      engineVersion: ENGINE_VERSION,
    },
  });

  /* --- 1. Deterministic rule engine ---------------------------------------- */
  const engine = runRuleEngine({
    project,
    catalog: input.catalog,
    ...(input.profile ? { profile: input.profile } : {}),
  });

  const issues: ValidationIssue[] = [...engine.issues];
  const checks: ValidationCheck[] = [...engine.checks];
  let llmCall: LlmCallRecord | undefined;
  let modelReview: ModelReview | undefined;
  let engineError: string | undefined;

  /* --- 1b. Behavioural assertion layer ------------------------------------- */
  /*
   * Structural validation stops at "it compiles / the schema holds". The
   * behavioural layer checks that the firmware actually keeps the promises
   * extracted from the prompt: each failed assertion becomes a targeted,
   * auto-fixable `behavioral_assertion_failed` issue the fixer receives as
   * structured input ("expected X, got Y").
   */
  if (project.requirements?.behavioralSpec?.assertions.length) {
    const report = evaluateBehavioral({
      requirements: project.requirements,
      code: project.artifacts.code,
      pinAssignments: project.pinAssignments,
      selections: project.components,
    });

    /*
     * The shared findings helper is the single source of this vocabulary:
     * the aggregate check, one `behavioral.<assertionId>` check per assertion
     * (what the Everflow evaluator reads to satisfy `behaviour_proven` goals
     * BY CODE — a promise the emulator proved never needs a human ask), and
     * one auto-fixable issue per failure for the fixer. The Everflow act
     * phase merges with the exact same function, so a mid-loop emulator
     * re-run writes precisely what the build-time validator would.
     */
    const findings = behavioralFindings(report);
    issues.push(...findings.issues);
    checks.push(...findings.checks);
  }

  /* --- 1c. Host compile gate ------------------------------------------------ */
  /*
   * The sketch is type-checked against the stub Arduino core with the host
   * compiler. Every error becomes a `firmware_compile_error` issue whose
   * details quote the gcc diagnostic, so the LLM fixer (and the workbench)
   * see exactly what the compiler saw. When no compiler is on PATH the check
   * reports itself as skipped — validation never pretends to have compiled.
   */
  {
    const artifact = project.artifacts.code;
    const entry = artifact?.files.find((file) => file.path === artifact.entryPoint) ?? artifact?.files[0];
    if (artifact && entry) {
      const compile = compileFirmware({ files: artifact.files, entryPoint: artifact.entryPoint });
      const compileIssueIds: string[] = [];

      for (const diagnostic of compile.diagnostics.filter((entry) => entry.severity === 'error').slice(0, 20)) {
        const quoted = formatDiagnostic(diagnostic);
        const issue: ValidationIssue = {
          id: `compile.${diagnostic.file}.${diagnostic.line}.${diagnostic.column}`,
          code: 'firmware_compile_error',
          severity: 'error',
          domain: 'code',
          message: `${diagnostic.file}:${diagnostic.line} — ${diagnostic.message}`,
          details: quoted,
          fixHint: `Fix the compiler error at ${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}.`,
          target: { artifact: 'code', filePath: diagnostic.file },
          autoFixable: true,
          origin: 'rules',
        };
        issues.push(issue);
        compileIssueIds.push(issue.id);
      }

      /*
       * The compiler rejected the sketch but produced no diagnostic the gate
       * could attribute to a project file (shim-header failure, timeout,
       * oversized output). Surface that honestly instead of passing the check
       * with an empty issue list — the fixer needs to know the build failed.
       */
      if (compile.ran && !compile.ok && compileIssueIds.length === 0) {
        const issue: ValidationIssue = {
          id: 'compile.unattributed',
          code: 'firmware_compile_error',
          severity: 'error',
          domain: 'code',
          message: 'The firmware failed the compile gate without a parseable diagnostic.',
          details: compile.skippedReason ?? 'The compiler exited non-zero.',
          fixHint: 'Inspect the sketch for constructs the host shim cannot type-check, or re-generate the firmware.',
          target: { artifact: 'code', filePath: entry.path },
          autoFixable: true,
          origin: 'rules',
        };
        issues.push(issue);
        compileIssueIds.push(issue.id);
      }

      checks.push({
        id: 'code.compile',
        name: 'Firmware type-check (host shim)',
        domain: 'code',
        status: !compile.ran ? 'skipped' : compileIssueIds.length > 0 ? 'failed' : 'passed',
        message: !compile.ran
          ? `Not run: ${compile.skippedReason ?? 'compiler unavailable'}.`
          : `${compileIssueIds.length} error(s) in ${compile.durationMs} ms (${compile.compiler ?? 'host compiler'}).`,
        issueIds: compileIssueIds,
      });
    }
  }

  /* --- 1d. Real simulation gate (arduino-cli → avr8js, opt-in) ------------- */
  /*
   * The third feedback source, fully separated from the two above: the sketch
   * is CROSS-COMPILED to real AVR machine code and EXECUTED instruction by
   * instruction; the runtime assertions of the behavioral spec are checked
   * against the actual pin/serial trace. Failures become
   * `sim_behavior_mismatch` issues, which the fixer loop consumes like any
   * other structured feedback ("expected X, got Y" from a real execution).
   *
   * Gated by WIREUP_ENABLE_REAL_SIM_LOOP (default off) and AVR controllers
   * only; when it cannot run, the check says exactly why and validation
   * continues on the deterministic gates.
   */
  if (env().agent.enableRealSimLoop && project.requirements) {
    const runtimeAssertions = (project.requirements.behavioralSpec?.assertions ?? []).filter(
      (assertion) => assertion.subject.kind !== 'firmware',
    );
    const compileGateFailed = checks.some((check) => check.id === 'code.compile' && check.status === 'failed');

    const skipRealSim = (reason: string): void => {
      checks.push({
        id: 'code.real_sim',
        name: 'Real AVR simulation (arduino-cli + avr8js)',
        domain: 'behavior',
        status: 'skipped',
        message: `Not run: ${reason}.`,
        issueIds: [],
      });
      events?.emit('info', `Real simulation gate skipped — ${reason}.`, {
        stage: 'validating',
        metadata: { gate: 'real_sim', reason },
      });
    };

    if (runtimeAssertions.length === 0) {
      skipRealSim('the behavioral spec has no runtime assertions to execute against');
    } else if (compileGateFailed) {
      skipRealSim('the host compile gate already reported errors — fix them before spending a cross-compile');
    } else {
      const controller = project.components.find((selection) => selection.category === 'microcontroller');
      const libraries = (project.artifacts.libraries?.libraries ?? project.softwarePlan?.libraries ?? []).map(
        (library) => library.name,
      );
      const sim = await validateWithRealSim({
        requirements: project.requirements,
        code: project.artifacts.code,
        pinAssignments: project.pinAssignments,
        selections: project.components,
        ...(controller ? { controllerComponentId: controller.componentId } : {}),
        libraries,
      });

      issues.push(...sim.issues);
      checks.push({
        id: 'code.real_sim',
        name: 'Real AVR simulation (arduino-cli + avr8js)',
        domain: 'behavior',
        status: !sim.ran ? 'skipped' : sim.passed ? 'passed' : 'failed',
        message: !sim.ran
          ? `Not run: ${sim.skippedReason ?? 'real simulation unavailable'}.`
          : `${sim.report.checks.length} runtime assertion(s) executed against the emulated AVR in ${sim.report.durationMs} ms — ${sim.issues.length} mismatch(es).`,
        issueIds: sim.issues.map((issue) => issue.id),
      });
      if (!sim.ran) {
        events?.emit('info', `Real simulation gate skipped — ${sim.skippedReason ?? 'unavailable'}.`, {
          stage: 'validating',
          metadata: { gate: 'real_sim', reason: sim.skippedReason ?? 'unavailable' },
        });
      }
    }
  }

  /* --- 2. Model review (additive) ------------------------------------------ */
  if (modelReviewEnabled) {
    const review = await runModelReview({
      project,
      catalogContext: input.catalogContext,
      mcuContext: input.mcuContext,
      ruleIssues: engine.issues,
      iteration,
      ...(events ? { events } : {}),
    });
    llmCall = review.call;

    if (review.error) {
      engineError = `Model review unavailable (${review.error}). Deterministic rule-engine results still applied.`;
    }

    const seen = new Set(engine.issues.map(issueSignature));
    let duplicates = 0;
    for (const issue of review.issues) {
      const signature = issueSignature(issue);
      if (seen.has(signature)) {
        duplicates += 1;
        continue;
      }
      seen.add(signature);
      issues.push(issue);
    }

    modelReview = {
      verdict: review.verdict,
      confidence: review.confidence,
      notes: review.notes,
      model: review.call.model,
      reviewedAt: nowIso(),
    };

    const modelIssueIds = review.issues.map((issue) => issue.id);
    checks.push({
      id: 'model.critical_review',
      name: 'Model critical review',
      domain: 'structure',
      status: review.error ? 'skipped' : review.verdict === 'reject' ? 'failed' : 'passed',
      message: review.error
        ? review.error
        : `Verdict ${review.verdict} (confidence ${Math.round(review.confidence * 100)}%): ${modelIssueIds.length} finding(s) added, ${duplicates} duplicate(s) of engine findings suppressed.`,
      issueIds: modelIssueIds,
    });
  } else {
    const reason = bedrock.configured
      ? 'Disabled by configuration (WIREUP_ENABLE_LLM_VALIDATION=false).'
      : `Amazon Bedrock is not configured${bedrock.problem ? ` (${bedrock.problem})` : ''} — deterministic validation only.`;
    checks.push({
      id: 'model.critical_review',
      name: 'Model critical review',
      domain: 'structure',
      status: 'skipped',
      message: reason,
      issueIds: [],
    });
  }

  /* --- 3. Verdict ---------------------------------------------------------- */
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const autoFixable = issues.filter((issue) => issue.autoFixable);
  const passed = errors.length === 0;
  const durationMs = Date.now() - startedAt;

  const result: ValidationResult = {
    passed,
    iteration,
    checkedAt: nowIso(),
    durationMs,
    issues,
    checks,
    summary: summarise(issues, checks),
    ...(modelReview ? { modelReview } : {}),
    ...(engineError ? { engineError } : {}),
  };

  /* --- 4. Console events --------------------------------------------------- */
  const reportedErrors = errors.slice(0, MAX_ERROR_EVENTS);
  for (const issue of reportedErrors) {
    events?.emit('validation_error', issue.message, {
      stage: 'validating',
      metadata: {
        issueId: issue.id,
        code: issue.code,
        domain: issue.domain,
        severity: issue.severity,
        origin: issue.origin,
        autoFixable: issue.autoFixable,
        artifact: issue.target?.artifact ?? 'requirements',
        ...(issue.details ? { details: issue.details } : {}),
        ...(issue.fixHint ? { fixHint: issue.fixHint } : {}),
        ...(issue.target?.componentInstanceId ? { componentInstanceId: issue.target.componentInstanceId } : {}),
        ...(issue.target?.pin ? { pin: issue.target.pin } : {}),
        ...(issue.target?.connectionId ? { connectionId: issue.target.connectionId } : {}),
        ...(issue.target?.filePath ? { filePath: issue.target.filePath } : {}),
      },
    });
  }
  if (errors.length > reportedErrors.length) {
    events?.emit('validation_error', `${errors.length - reportedErrors.length} further blocking issue(s) recorded — see the VALIDATION card.`, {
      stage: 'validating',
      metadata: { truncated: true, totalErrors: errors.length },
    });
  }
  for (const issue of warnings.slice(0, MAX_WARNING_EVENTS)) {
    events?.emit('info', `Warning: ${issue.message}`, {
      stage: 'validating',
      metadata: {
        severity: 'warning',
        issueId: issue.id,
        code: issue.code,
        domain: issue.domain,
        origin: issue.origin,
        artifact: issue.target?.artifact ?? 'requirements',
      },
    });
  }

  const byArtifact = groupIssuesByArtifact(issues);
  const artifactSummary = Array.from(byArtifact.entries())
    .map(([artifact, list]) => `${artifact}:${list.length}`)
    .join(', ');

  if (passed) {
    startHandle?.complete(
      `Validation passed${warnings.length > 0 ? ` with ${warnings.length} warning(s)` : ''} — ${checks.length} check(s) in ${durationMs} ms.`,
      {
        iteration,
        issues: issues.length,
        errors: 0,
        warnings: warnings.length,
        infos: issues.filter((issue) => issue.severity === 'info').length,
        checks: checks.length,
        checksPassed: checks.filter((check) => check.status === 'passed').length,
        durationMs,
      },
    );
  } else {
    startHandle?.fail(
      `Validation failed — ${errors.length} blocking issue(s), ${autoFixable.length} auto-fixable.`,
      errors
        .slice(0, 6)
        .map((issue) => `${issue.code}: ${issue.message}`)
        .join(' | '),
      {
        iteration,
        issues: issues.length,
        errors: errors.length,
        warnings: warnings.length,
        autoFixable: autoFixable.length,
        codes: Array.from(new Set(errors.map((issue) => issue.code))).slice(0, MAX_ERROR_EVENTS),
        artifacts: artifactSummary,
        durationMs,
      },
    );
  }

  logger.info(
    {
      projectId: project.id,
      iteration,
      passed,
      issues: issues.length,
      errors: errors.length,
      warnings: warnings.length,
      autoFixable: autoFixable.length,
      modelReview: modelReviewEnabled,
      durationMs,
    },
    'validation complete',
  );

  return llmCall ? { result, llmCall } : { result };
}

export { AUTO_FIXABLE_CODES, groupIssuesByArtifact, runRuleEngine, summariseIssues } from './rules';
export { issueSignature, runModelReview } from './llm';
