/**
 * The behavioural evaluator — turns a `BehavioralSpec` into a `BehavioralReport`
 * by checking every assertion two ways:
 *
 *   • statically   — regex/property proofs against the generated source
 *     (PIN lengths, factory default length, reset branch, absence of a press
 *     counter); and
 *   • at runtime   — compile + execute the sketch against the instrumented
 *     host core, drive the scripted inputs, then read the telemetry frames
 *     from the observed serial trace.
 *
 * A failed assertion is reported with a machine-readable `failure`
 * ("expected X, got Y") that the fixer consumes as structured input.
 */

import type { ComponentSelection } from '@/types/component';
import type { CodeArtifact, ProjectRequirements } from '@/types/project';
import type { PinAssignment } from '@/types/wiring';
import type {
  BehavioralAssertion,
  BehavioralCheck,
  BehavioralReport,
  BehavioralSpec,
  FirmwareTrace,
} from '@/types/behavioral';
import type { ValidationSeverity } from '@/types/validation';
import { compareBehavioral, describeExpected, parseArduinoPinNumber, telemetryFieldSeries } from './assertions';
import { compileAndRunFirmware, type RunScenarioStep } from './emitter';

export interface BehavioralEvaluationInput {
  requirements: ProjectRequirements;
  code: CodeArtifact | null;
  pinAssignments: PinAssignment[];
  selections: ComponentSelection[];
}

/* ------------------------------------------------------------------------- */
/* Static proofs                                                              */
/* ------------------------------------------------------------------------- */

function sourceOf(code: CodeArtifact | null): string {
  if (!code) return '';
  return code.files.map((file) => file.content ?? '').join('\n');
}

interface StaticObservation {
  actual: number | string;
  present: boolean;
  presentValue: 'present' | 'absent';
}

/** Run one static (firmware-property) proof against the source. */
function proveStatic(assertion: BehavioralAssertion, source: string): StaticObservation {
  const property = assertion.subject.property;
  switch (property) {
    case 'pin_min_length': {
      const match = /\bPIN_MIN_LENGTH\s*=\s*(\d+)/.exec(source);
      return match
        ? { actual: Number(match[1]), present: true, presentValue: 'present' }
        : { actual: 'PIN_MIN_LENGTH not found', present: false, presentValue: 'absent' };
    }
    case 'pin_max_length': {
      const match = /\bPIN_MAX_LENGTH\s*=\s*(\d+)/.exec(source);
      return match
        ? { actual: Number(match[1]), present: true, presentValue: 'present' }
        : { actual: 'PIN_MAX_LENGTH not found', present: false, presentValue: 'absent' };
    }
    case 'default_pin_covers_min': {
      const match = /const\s+char\s*\*\s*fallback\s*=\s*"([0-9]*)"/.exec(source);
      return match
        ? { actual: match[1].length, present: true, presentValue: 'present' }
        : { actual: 'factory fallback not found', present: false, presentValue: 'absent' };
    }
    case 'counter_has_reset': {
      /*
       * The reset handler is signalled by the `count=0` it prints; the
       * declaration `long pressCount = 0;` is NOT a reset, so matching the
       * assignment alone would give a false pass.
       */
      const hasReset = /"count=0"/.test(source);
      return { actual: hasReset ? 'present' : 'absent', present: hasReset, presentValue: hasReset ? 'present' : 'absent' };
    }
    case 'press_counter_absent': {
      const hasCounter = /\bpressCount\b/.test(source);
      return { actual: hasCounter ? 'present' : 'absent', present: !hasCounter, presentValue: hasCounter ? 'present' : 'absent' };
    }
    default:
      return { actual: 'unknown property', present: false, presentValue: 'absent' };
  }
}

/* ------------------------------------------------------------------------- */
/* Runtime observation                                                        */
/* ------------------------------------------------------------------------- */

function runtimeObservation(assertion: BehavioralAssertion, trace: FirmwareTrace): { actual: number | string; series: number[] } {
  const field = assertion.subject.field ?? 'count';
  const series = telemetryFieldSeries(trace, field);
  if (assertion.operator === 'absent') {
    return { actual: series.length === 0 ? 'absent' : 'present', series };
  }
  const last = series.length > 0 ? series[series.length - 1] : undefined;
  return { actual: last !== undefined ? last : 'no frame observed', series };
}

/* ------------------------------------------------------------------------- */
/* Pin resolution for scripted inputs                                         */
/* ------------------------------------------------------------------------- */

function pinNumberFor(assignment: PinAssignment): number | undefined {
  if (typeof assignment.pinNumber === 'number') return assignment.pinNumber;
  return parseArduinoPinNumber(assignment.pin);
}

function buttonAssignments(selections: ComponentSelection[], pinAssignments: PinAssignment[]): PinAssignment[] {
  const out: PinAssignment[] = [];
  for (const selection of selections) {
    if (selection.category !== 'input_device') continue;
    if (!/button/i.test(selection.componentId)) continue;
    for (const instance of selection.instances) {
      const assignment = pinAssignments.find((candidate) => candidate.targetInstanceId === instance.instanceId);
      if (assignment && pinNumberFor(assignment) !== undefined) out.push(assignment);
    }
  }
  return out;
}

interface ResolvedPins {
  incrementButton?: number;
  resetButton?: number;
  anyButton?: number;
}

function resolvePins(selections: ComponentSelection[], pinAssignments: PinAssignment[]): ResolvedPins {
  const buttons = buttonAssignments(selections, pinAssignments);
  return {
    ...(buttons[0] ? { incrementButton: pinNumberFor(buttons[0]) } : {}),
    ...(buttons.length >= 2 ? { resetButton: pinNumberFor(buttons[buttons.length - 1]) } : {}),
    ...(buttons[0] ? { anyButton: pinNumberFor(buttons[0]) } : {}),
  };
}

/* ------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* ------------------------------------------------------------------------- */

export function evaluateBehavioral(input: BehavioralEvaluationInput): BehavioralReport {
  const startedAt = Date.now();
  const spec: BehavioralSpec = input.requirements.behavioralSpec ?? {
    assertions: [],
    origin: 'heuristics',
    generatedAt: new Date().toISOString(),
    notes: ['No behavioural spec on this project.'],
  };

  const checks: BehavioralCheck[] = [];
  const source = sourceOf(input.code);
  const pins = resolvePins(input.selections, input.pinAssignments);

  let runtimeRan = false;
  let runtimeError: string | undefined;

  /* Static checks always run (they only need the source). */
  for (const assertion of spec.assertions) {
    if (assertion.subject.kind !== 'firmware') continue;
    const severity: ValidationSeverity = assertion.required ? 'error' : 'warning';
    if (source.length === 0) {
      checks.push({
        assertionId: assertion.id,
        title: assertion.title,
        status: 'skipped',
        severity,
        mode: 'static',
        actual: 'no firmware source',
        expected: describeExpected(assertion),
        reason: 'No firmware artifact to inspect.',
      });
      continue;
    }
    const observation = proveStatic(assertion, source);
    const pass = compareBehavioral(observation.actual, assertion.operator, assertion.expected, assertion.tolerance ?? 0);
    checks.push({
      assertionId: assertion.id,
      title: assertion.title,
      status: pass ? 'passed' : 'failed',
      severity,
      mode: 'static',
      actual: String(observation.actual),
      expected: describeExpected(assertion),
      ...(pass ? {} : { failure: `assertion ${assertion.id} failed: expected ${describeExpected(assertion)}, got ${observation.actual}` }),
    });
  }

  /* Runtime checks — group by scenario so each distinct stimulus runs once. */
  const runtime = spec.assertions.filter((assertion) => assertion.subject.kind !== 'firmware');
  const scenarioGroups = new Map<string, BehavioralAssertion[]>();
  for (const assertion of runtime) {
    const key = JSON.stringify(assertion.scenario ?? []);
    const group = scenarioGroups.get(key) ?? [];
    group.push(assertion);
    scenarioGroups.set(key, group);
  }

  for (const [scenarioKey, assertions] of scenarioGroups) {
    const scenario = JSON.parse(scenarioKey) as BehavioralAssertion['scenario'];
    const steps = resolveScenarioSteps(scenario, pins);
    const unresolved = scenario && scenario.length > 0 && steps.length === 0;
    const run = compileAndRunFirmware({ code: input.code as CodeArtifact, steps });
    if (run.error) {
      runtimeError = run.error;
      for (const assertion of assertions) {
        checks.push({
          assertionId: assertion.id,
          title: assertion.title,
          status: 'skipped',
          severity: assertion.required ? 'error' : 'warning',
          mode: 'runtime',
          actual: '—',
          expected: describeExpected(assertion),
          reason: `The emulator could not run this sketch (${run.error}); falling back to structural validation.`,
        });
      }
      continue;
    }
    runtimeRan = true;
    for (const assertion of assertions) {
      if (unresolved) {
        checks.push({
          assertionId: assertion.id,
          title: assertion.title,
          status: 'skipped',
          severity: assertion.required ? 'error' : 'warning',
          mode: 'runtime',
          actual: '—',
          expected: describeExpected(assertion),
          reason: 'The scenario needs a button pin, but none was assigned.',
        });
        continue;
      }
      const observation = runtimeObservation(assertion, run.trace);
      const pass = compareBehavioral(observation.actual, assertion.operator, assertion.expected, assertion.tolerance ?? 0);
      checks.push({
        assertionId: assertion.id,
        title: assertion.title,
        status: pass ? 'passed' : 'failed',
        severity: assertion.required ? 'error' : 'warning',
        mode: 'runtime',
        actual: String(observation.actual),
        expected: describeExpected(assertion),
        ...(pass ? {} : { failure: `assertion ${assertion.id} failed: expected ${describeExpected(assertion)}, got ${observation.actual}` }),
      });
    }
  }

  const failures = checks.filter((check) => check.status === 'failed' && check.severity === 'error').length;
  const warnings = checks.filter((check) => check.status === 'failed' && check.severity === 'warning').length;
  const passed = failures === 0;

  return {
    spec,
    checks,
    runtimeRan,
    ...(runtimeError ? { runtimeError } : {}),
    passed,
    failures,
    warnings,
    durationMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
  };
}

function resolveScenarioSteps(
  scenario: BehavioralAssertion['scenario'],
  pins: ResolvedPins,
): RunScenarioStep[] {
  const steps: RunScenarioStep[] = [];
  for (const step of scenario ?? []) {
    if (step.kind === 'serial') {
      steps.push({ atMs: step.atMs, kind: 'serial', byte: step.byte ?? '' });
      continue;
    }
    const rolePin = step.pinRole ? pins[step.pinRole === 'increment_button' ? 'incrementButton' : step.pinRole === 'reset_button' ? 'resetButton' : 'anyButton'] : undefined;
    const pin = step.pin ?? rolePin;
    if (pin === undefined) continue;
    const level = step.level ?? 0;
    const holdMs = step.holdMs ?? 60;
    steps.push({ atMs: step.atMs, kind: 'pin', pin, level });
    steps.push({ atMs: step.atMs + holdMs, kind: 'pin', pin, level: level ? 0 : 1 });
  }
  return steps.sort((a, b) => a.atMs - b.atMs);
}
