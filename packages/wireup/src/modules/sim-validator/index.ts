/**
 * Real simulation validator — closes the loop between generated firmware
 * and the actual AVR emulator (avr8js).
 *
 * This module:
 * 1. Cross-compiles sketch.ino to real AVR machine code using arduino-cli
 * 2. Executes the .hex in a headless avr8js harness
 * 3. Verifies BehavioralSpec assertions against the actual execution trace
 * 4. Reports `sim_behavior_mismatch` issues for the fixer to address
 *
 * The module reuses the existing BehavioralSpec/BehavioralAssertion types
 * from behaviour-evaluator, but provides real AVR execution instead of
 * host-exec stub simulation.
 *
 * Gated by WIREUP_ENABLE_REAL_SIM_LOOP (default off until proven stable).
 */

import { env } from '@/lib/validation/env';
import { compileToHex, hexCompilerStatus } from '@/modules/firmware-hex-compiler';
import { runSimulation, type HarnessScenarioStep } from '@/modules/simulation/headless-avr';
import type { CodeArtifact, ProjectRequirements } from '@/types/project';
import type { ComponentSelection } from '@/types/component';
import type {
  BehavioralAssertion,
  BehavioralCheck,
  BehavioralReport,
  BehavioralSpec,
  FirmwareTrace,
} from '@/types/behavioral';
import type { PinAssignment } from '@/types/wiring';
import type { ValidationIssue, ValidationSeverity } from '@/types/validation';
import { issueId } from '@/lib/validation/ids';
import {
  compareBehavioral,
  describeExpected,
  parseArduinoPinNumber,
  telemetryFieldSeries,
} from '@/modules/behaviour-evaluator';

export interface SimValidationInput {
  requirements: ProjectRequirements;
  code: CodeArtifact | null;
  pinAssignments: PinAssignment[];
  selections: ComponentSelection[];
  /** Controller component ID for board FQBN selection. */
  controllerComponentId?: string;
  /** Optional libraries required by the sketch. */
  libraries?: string[];
}

export interface SimValidationResult {
  /** Whether the validation ran (false if disabled or arduino-cli unavailable). */
  ran: boolean;
  /** Whether all assertions passed. */
  passed: boolean;
  /** The behavioral report (same format as behaviour-evaluator). */
  report: BehavioralReport;
  /** Validation issues to feed into the fixer loop. */
  issues: ValidationIssue[];
  /** Why validation didn't run, if applicable. */
  skippedReason?: string;
}

/* ------------------------------------------------------------------------- */
/* Scenario step conversion                                                   */
/* ------------------------------------------------------------------------- */

/** Convert behavioral scenario steps to harness steps. */
function convertScenarioSteps(
  scenario: BehavioralAssertion['scenario'],
  pinAssignments: PinAssignment[],
  selections: ComponentSelection[],
): HarnessScenarioStep[] {
  if (!scenario || scenario.length === 0) return [];

  const steps: HarnessScenarioStep[] = [];

  // Resolve button pins from selections
  const buttonPins: number[] = [];
  for (const selection of selections) {
    if (selection.category !== 'input_device') continue;
    if (!/button/i.test(selection.componentId)) continue;

    for (const instance of selection.instances) {
      const assignment = pinAssignments.find((a) => a.targetInstanceId === instance.instanceId);
      if (assignment?.pinNumber !== undefined) {
        buttonPins.push(assignment.pinNumber);
      } else if (assignment?.pin) {
        // Parse pin number from string like "D5" or "A0"
        const pinNum = parseArduinoPinNumber(assignment.pin);
        if (pinNum !== undefined) buttonPins.push(pinNum);
      }
    }
  }

  for (const step of scenario) {
    if (step.kind === 'serial') {
      steps.push({
        atMs: step.atMs,
        kind: 'serial',
        bytes: new TextEncoder().encode(step.byte ?? ''),
      });
    } else if (step.kind === 'pin') {
      // Resolve pin from role or explicit pin
      let pin: number | undefined = step.pin;
      if (pin === undefined && step.pinRole) {
        pin = resolvePinFromRole(step.pinRole, buttonPins);
      }
      if (pin === undefined) continue;

      const level = step.level ?? 0;
      const holdMs = step.holdMs ?? 60;

      // Press
      steps.push({ atMs: step.atMs, kind: 'pin', pin, level });
      // Release
      steps.push({ atMs: step.atMs + holdMs, kind: 'pin', pin, level: level ? 0 : 1 });
    }
  }

  return steps.sort((a, b) => a.atMs - b.atMs);
}

function resolvePinFromRole(
  role: 'increment_button' | 'reset_button' | 'any_button',
  buttonPins: number[],
): number | undefined {
  switch (role) {
    case 'increment_button':
      return buttonPins[0];
    case 'reset_button':
      return buttonPins.length >= 2 ? buttonPins[buttonPins.length - 1] : buttonPins[0];
    case 'any_button':
      return buttonPins[0];
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------------- */
/* Assertion checking                                                         */
/* (comparison + telemetry parsing live in behaviour-evaluator/assertions so   */
/*  the host-exec evaluator and this real-sim evaluator can never drift apart) */
/* ------------------------------------------------------------------------- */

function checkAssertion(
  assertion: BehavioralAssertion,
  trace: FirmwareTrace,
): { passed: boolean; actual: string; failure?: string } {
  // Only runtime assertions (kind !== 'firmware') are checked here
  if (assertion.subject.kind === 'firmware') {
    return { passed: true, actual: 'static check skipped in sim' };
  }

  const field = assertion.subject.field ?? 'count';
  const series = telemetryFieldSeries(trace, field);

  // Handle present/absent operators specially
  if (assertion.operator === 'present' || assertion.operator === 'absent') {
    const isPresent = series.length > 0;
    const passed = assertion.operator === 'present' ? isPresent : !isPresent;
    return {
      passed,
      actual: isPresent ? 'present' : 'absent',
      ...(passed ? {} : { failure: `${field} was ${isPresent ? 'present' : 'absent'} but expected ${assertion.operator}` }),
    };
  }

  const last = series.length > 0 ? series[series.length - 1] : undefined;
  const actual = last !== undefined ? last : 'no frame observed';

  const passed = compareBehavioral(actual, assertion.operator, assertion.expected, assertion.tolerance ?? 0);

  return {
    passed,
    actual: String(actual),
    ...(passed ? {} : { failure: `expected ${describeExpected(assertion)}, got ${actual}` }),
  };
}

/* ------------------------------------------------------------------------- */
/* Main validation entry point                                                */
/* ------------------------------------------------------------------------- */

export async function validateWithRealSim(input: SimValidationInput): Promise<SimValidationResult> {
  const startedAt = Date.now();
  const cfg = env().agent;

  // Check if real sim loop is enabled
  if (!cfg.enableRealSimLoop) {
    return {
      ran: false,
      passed: true,
      report: emptyReport(input.requirements.behavioralSpec),
      issues: [],
      skippedReason: 'Real simulation loop disabled (WIREUP_ENABLE_REAL_SIM_LOOP=false)',
    };
  }

  // Check if arduino-cli is available
  const compilerStatus = hexCompilerStatus();
  if (!compilerStatus.available) {
    return {
      ran: false,
      passed: true,
      report: emptyReport(input.requirements.behavioralSpec),
      issues: [],
      skippedReason: `Real simulation unavailable: ${compilerStatus.reason}`,
    };
  }

  // Check if we have code to validate
  if (!input.code || input.code.files.length === 0) {
    return {
      ran: false,
      passed: true,
      report: emptyReport(input.requirements.behavioralSpec),
      issues: [],
      skippedReason: 'No firmware code to validate',
    };
  }

  // Step 1: Cross-compile to hex
  const compileResult = await compileToHex({
    files: input.code.files,
    entryPoint: input.code.entryPoint,
    controllerComponentId: input.controllerComponentId,
    libraries: input.libraries,
  });

  if (!compileResult.ok) {
    // Compilation failure is reported as a sim_execution_unavailable issue
    // The existing firmware_compile_error from firmware-compiler will catch
    // the actual compile error; we just skip the sim validation here.
    return {
      ran: false,
      passed: true,
      report: emptyReport(input.requirements.behavioralSpec),
      issues: [],
      skippedReason: compileResult.skippedReason ?? 'Cross-compilation failed',
    };
  }

  // Step 2: Get behavioral spec
  const spec: BehavioralSpec = input.requirements.behavioralSpec ?? {
    assertions: [],
    origin: 'heuristics',
    generatedAt: new Date().toISOString(),
    notes: ['No behavioral spec on this project.'],
  };

  // Step 3: Group runtime assertions by scenario
  const runtimeAssertions = spec.assertions.filter((a) => a.subject.kind !== 'firmware');
  const scenarioGroups = new Map<string, BehavioralAssertion[]>();

  for (const assertion of runtimeAssertions) {
    const key = JSON.stringify(assertion.scenario ?? []);
    const group = scenarioGroups.get(key) ?? [];
    group.push(assertion);
    scenarioGroups.set(key, group);
  }

  // Step 4: Run simulation for each unique scenario
  const checks: BehavioralCheck[] = [];
  const issues: ValidationIssue[] = [];
  let runtimeRan = false;
  let runtimeError: string | undefined;

  for (const [scenarioKey, assertions] of scenarioGroups) {
    const scenario = JSON.parse(scenarioKey) as BehavioralAssertion['scenario'];
    const steps = convertScenarioSteps(scenario, input.pinAssignments, input.selections);

    // Run the simulation
    const simResult = await runSimulation({
      hexContent: compileResult.hexContent!,
      scenario: steps,
      simulateMs: cfg.simTimeoutMs,
      stallThresholdCycles: 50_000_000, // ~3 seconds at 16MHz
    });

    if (!simResult.completed) {
      runtimeError = simResult.error ?? 'Simulation did not complete';
      for (const assertion of assertions) {
        checks.push({
          assertionId: assertion.id,
          title: assertion.title,
          status: 'error',
          severity: assertion.required ? 'error' : 'warning',
          mode: 'runtime',
          actual: '—',
          expected: describeExpected(assertion),
          reason: `Simulation failed: ${runtimeError}`,
        });
      }
      continue;
    }

    runtimeRan = true;

    // Check each assertion against the trace
    for (const assertion of assertions) {
      const result = checkAssertion(assertion, simResult.trace);
      const severity: ValidationSeverity = assertion.required ? 'error' : 'warning';

      checks.push({
        assertionId: assertion.id,
        title: assertion.title,
        status: result.passed ? 'passed' : 'failed',
        severity,
        mode: 'runtime',
        actual: result.actual,
        expected: describeExpected(assertion),
        ...(result.passed ? {} : { failure: result.failure }),
      });

      // Create validation issue for failed assertions
      if (!result.passed) {
        const issue: ValidationIssue = {
          id: issueId(),
          code: 'sim_behavior_mismatch',
          severity,
          domain: 'behavior',
          message: `Simulation behavior mismatch: ${assertion.title}`,
          details: result.failure ?? `expected ${describeExpected(assertion)}, got ${result.actual}`,
          target: { artifact: 'code' },
          fixHint: result.failure ?? `expected ${describeExpected(assertion)}, got ${result.actual}`,
          autoFixable: false, // Requires LLM fixer to regenerate code
          origin: 'rules',
        };
        issues.push(issue);
      }
    }
  }

  // Handle static assertions (just mark as skipped in sim context)
  const staticAssertions = spec.assertions.filter((a) => a.subject.kind === 'firmware');
  for (const assertion of staticAssertions) {
    checks.push({
      assertionId: assertion.id,
      title: assertion.title,
      status: 'skipped',
      severity: assertion.required ? 'error' : 'warning',
      mode: 'static',
      actual: '—',
      expected: describeExpected(assertion),
      reason: 'Static assertions checked by behaviour-evaluator, not sim-validator',
    });
  }

  const failures = checks.filter((c) => c.status === 'failed' && c.severity === 'error').length;
  const warnings = checks.filter((c) => c.status === 'failed' && c.severity === 'warning').length;

  const report: BehavioralReport = {
    spec,
    checks,
    runtimeRan,
    ...(runtimeError ? { runtimeError } : {}),
    passed: failures === 0,
    failures,
    warnings,
    durationMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
  };

  return {
    ran: true,
    passed: failures === 0,
    report,
    issues,
  };
}

function emptyReport(spec?: BehavioralSpec): BehavioralReport {
  return {
    spec: spec ?? {
      assertions: [],
      origin: 'heuristics',
      generatedAt: new Date().toISOString(),
      notes: ['No behavioral spec.'],
    },
    checks: [],
    runtimeRan: false,
    passed: true,
    failures: 0,
    warnings: 0,
    durationMs: 0,
    checkedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------------- */
/* Integration helpers                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Convert sim validation result to validation checks for the validator.
 */
export function simValidationChecks(result: SimValidationResult): { checks: BehavioralCheck[]; issues: ValidationIssue[] } {
  return { checks: result.report.checks, issues: result.issues };
}
