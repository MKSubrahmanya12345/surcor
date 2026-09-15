/**
 * Behavioural assertion types — the executable-spec layer.
 *
 * `ProjectRequirements` already carries intent as prose (`requirements`,
 * `behaviors`), open questions (`ambiguities`) and assumptions. What it lacks
 * is the layer the user's brief can be *tested* against: typed,
 * machine-checkable properties ("the factory PIN covers the minimum length",
 * "a reset button zeroes the count", "a stepper build is not a press counter").
 *
 * A `BehavioralAssertion` is that property. It is populated at the same step
 * that turns the prompt into requirements (deterministically, the model can
 * extend it), then checked two ways:
 *
 *   • statically — against the generated firmware source (cheap, offline);
 *   • at runtime — by compiling and executing the firmware against a host
 *     shim of the Arduino core and observing the pin/telemetry trace.
 *
 * A failed assertion becomes a `behavioral_assertion_failed` validation issue,
 * which the fixer receives as structured input ("expected X, got Z") instead
 * of "the build broke".
 */

import type { ValidationSeverity } from './validation';

/* ------------------------------------------------------------------------- */
/* Assertions                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * A named static property of the firmware source the evaluator can prove
 * without running anything.
 */
export type FirmwareProperty =
  /** `PIN_MIN_LENGTH` vs the value the brief requested. */
  | 'pin_min_length'
  /** `PIN_MAX_LENGTH` vs the value the brief requested. */
  | 'pin_max_length'
  /** The factory default PIN is at least `PIN_MIN_LENGTH` digits long. */
  | 'default_pin_covers_min'
  /** A counter build that names a reset/clear/zero action must zero the count. */
  | 'counter_has_reset'
  /** The firmware must NOT contain a `pressCount` (a drive/stepper build mis-detected as a counter). */
  | 'press_counter_absent';

/** A logical input role a scenario drives; resolved to a physical pin at eval time. */
export type PinRole = 'increment_button' | 'reset_button' | 'any_button';

/** What an assertion observes. */
export interface AssertionSubject {
  kind: 'firmware' | 'telemetry' | 'output';
  /** `kind === 'firmware'`: the named property to prove statically. */
  property?: FirmwareProperty;
  /** `kind === 'telemetry'`: the telemetry key in the `status:{…}` frame. */
  field?: string;
  /** `kind === 'output'`: physical MCU pin number (A0 -> 14, D5 -> 5). */
  pin?: number;
  /** Peripheral instance the subject belongs to (traceability + messages). */
  instanceId?: string;
}

/** A scripted input step the runtime evaluator plays before observing. */
export interface AssertionScenarioStep {
  /** Virtual ms after boot at which to apply the step. */
  atMs: number;
  kind: 'serial' | 'pin';
  /** `serial`: byte written to the control link. */
  byte?: string;
  /** `pin`: logical role, resolved to a pin number at eval time. */
  pinRole?: PinRole;
  /** `pin`: explicit physical pin (overrides `pinRole`). */
  pin?: number;
  /** `pin`: level to hold (`1` HIGH, `0` LOW = pressed for active-low buttons). */
  level?: 0 | 1;
  /** `pin`: how long to hold the level before releasing back to HIGH. */
  holdMs?: number;
}

/**
 * A testable property derived from the prompt. `expected` carries the target;
 * `operator` decides how the observed value is compared against it.
 */
export interface BehavioralAssertion {
  id: string;
  /** Short human-readable title. */
  title: string;
  subject: AssertionSubject;
  operator:
    | 'eq'
    | 'neq'
    | 'gte'
    | 'lte'
    | 'gt'
    | 'lt'
    | 'in_range'
    | 'contains'
    | 'present'
    | 'absent'
    | 'changes';
  /** Expected value(s). `in_range` uses `[min, max]`. */
  expected?: number | string | [number, number];
  /** ± tolerance for numeric comparisons. */
  tolerance?: number;
  /** Scripted inputs played before the subject is observed. */
  scenario?: AssertionScenarioStep[];
  /** Blocking (`error`) vs advisory (`warning`). */
  required: boolean;
  /** Which requirement fragments this assertion was derived from. */
  derivedFrom: string[];
}

/** The full assertion set attached to a project's requirements. */
export interface BehavioralSpec {
  assertions: BehavioralAssertion[];
  /** How the spec was produced (`heuristics` always; `model` when the LLM added). */
  origin: 'heuristics' | 'heuristics+model';
  generatedAt: string;
  notes: string[];
}

/* ------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* ------------------------------------------------------------------------- */

export interface BehavioralCheck {
  assertionId: string;
  title: string;
  status: 'passed' | 'failed' | 'skipped' | 'error';
  severity: ValidationSeverity;
  /** Whether the check ran in the emulator or against the source. */
  mode: 'static' | 'runtime';
  /** What was measured, formatted for a human ("1234" / "6" / "no frame observed"). */
  actual: string;
  expected: string;
  /** Precise, machine-readable failure the fixer can act on. */
  failure?: string;
  /** Why a check was skipped or errored. */
  reason?: string;
}

export interface BehavioralReport {
  spec: BehavioralSpec;
  checks: BehavioralCheck[];
  /** Checks that ran against the emulator rather than the source. */
  runtimeRan: boolean;
  /** Null when the emulator could not run (no compiler / no firmware). */
  runtimeError?: string;
  passed: boolean;
  failures: number;
  warnings: number;
  durationMs: number;
  checkedAt: string;
}

/* ------------------------------------------------------------------------- */
/* Runtime trace (produced by the host shim, consumed by the evaluator)       */
/* ------------------------------------------------------------------------- */

/** A pin level change observed while the firmware ran. */
export interface TracePinEvent {
  pin: number;
  level: 0 | 1;
  atMs: number;
}

/** A servo write observed while the firmware ran. */
export interface TraceServoEvent {
  pin: number;
  angle: number;
  atMs: number;
}

/** A single line the firmware wrote to its serial/control link. */
export interface TraceSerialLine {
  text: string;
  atMs: number;
}

export interface FirmwareTrace {
  /** Pins the firmware drove at least once. */
  drivenPins: number[];
  /** Digital level changes, in order. */
  pinEvents: TracePinEvent[];
  /** Servo writes, in order. */
  servoEvents: TraceServoEvent[];
  /** Everything the firmware printed, in order. */
  serialLines: TraceSerialLine[];
  /** Virtual milliseconds simulated. */
  simulatedMs: number;
  /** How many loop() iterations ran. */
  loopIterations: number;
}
