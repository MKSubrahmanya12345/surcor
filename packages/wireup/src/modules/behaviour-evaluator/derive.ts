/**
 * Deterministic assertion derivation — the same tier as `spec` /
 * `known_uncertainty` on the requirements node.
 *
 * Turning the prompt into checkable properties happens at the same step that
 * turns it into prose requirements (buildRequirementsDraft). The heuristics
 * here reuse the exact shared detectors the code generator uses
 * (`pinLengthFromText`, `wantsCountingBrief`, `wantsResetBrief`) so the spec
 * and the firmware can never drift apart — the spec is the contract the
 * generated sketch must keep.
 */

import type { PromptAnalysis } from '@/modules/project-understanding/heuristics';
import type { BehavioralAssertion, BehavioralSpec, AssertionScenarioStep } from '@/types/behavioral';
import { pinLengthFromText } from '@/modules/code-generator/behaviours/access-control';
import { wantsCountingBrief, wantsResetBrief } from '@/modules/code-generator/templates';

const PIN_WORD = /\b(pin|passcode|pass[\s-]?code|password|access[\s-]?code)\b/i;
const PIN_DIGITS = /\d{1,2}\s*(?:-|–|to)?\s*\d{0,2}\s*digits?/;
const MOTOR_WORD = /\b(stepper|nema|28byj|a4988|drv8825|l293|dc\s*motor|motor)\b/i;

/** "Press a button to count, press another to reset" scripted for the emulator. */
function counterResetScenario(): AssertionScenarioStep[] {
  return [
    { atMs: 400, kind: 'pin', pinRole: 'increment_button', level: 0, holdMs: 60 },
    { atMs: 900, kind: 'pin', pinRole: 'increment_button', level: 0, holdMs: 60 },
    { atMs: 1400, kind: 'pin', pinRole: 'reset_button', level: 0, holdMs: 60 },
  ];
}

/** Everything the derivation has to read the intent from. */
function intentText(prompt: string, analysis: PromptAnalysis): string {
  return [prompt, ...analysis.features, ...analysis.behaviourPhrases].join(' ');
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Derive the executable spec from the prompt. `analysis` is the same
 * deterministic pre-analysis used to build the requirements draft.
 */
export function deriveBehavioralSpec(prompt: string, analysis: PromptAnalysis): BehavioralSpec {
  const assertions: BehavioralAssertion[] = [];
  const text = intentText(prompt, analysis);
  const lower = text.toLowerCase();

  /* ---- PIN length + factory default (the "dead PIN" class of bug) -------- */
  if (PIN_WORD.test(text)) {
    const { min, max } = pinLengthFromText(text);
    const explicit = PIN_DIGITS.test(text);
    const derivedFrom = `PIN length requirement (min ${min}, max ${max} digits)`;

    assertions.push({
      id: 'pin-min-length',
      title: `PIN_MIN_LENGTH is ${min} (as requested)`,
      subject: { kind: 'firmware', property: 'pin_min_length' },
      operator: 'eq',
      expected: min,
      required: explicit,
      derivedFrom: [derivedFrom],
    });
    assertions.push({
      id: 'pin-max-length',
      title: `PIN_MAX_LENGTH is ${max} (as requested)`,
      subject: { kind: 'firmware', property: 'pin_max_length' },
      operator: 'eq',
      expected: max,
      required: explicit,
      derivedFrom: [derivedFrom],
    });
    assertions.push({
      id: 'default-pin-covers-min',
      title: `Factory default PIN is at least ${min} digits long`,
      subject: { kind: 'firmware', property: 'default_pin_covers_min' },
      operator: 'gte',
      expected: min,
      required: explicit,
      derivedFrom: [derivedFrom],
    });
  }

  const counting = wantsCountingBrief(text);
  const reset = wantsResetBrief(text);
  const hasMotor = MOTOR_WORD.test(text) || lower.includes('motor') || lower.includes('stepper');

  /* ---- counter + reset (the "inverted reset button" class of bug) -------- */
  if (counting && reset) {
    assertions.push({
      id: 'counter-has-reset',
      title: 'The reset button zeroes the count (not another increment)',
      subject: { kind: 'firmware', property: 'counter_has_reset' },
      operator: 'present',
      required: true,
      derivedFrom: ['counting behaviour', 'reset/clear/zero requirement'],
    });
    assertions.push({
      id: 'counter-resets-to-zero',
      title: 'After pressing increment twice then reset, the count is back to 0',
      subject: { kind: 'telemetry', field: 'count' },
      operator: 'eq',
      expected: 0,
      required: true,
      scenario: counterResetScenario(),
      derivedFrom: ['counting behaviour', 'reset/clear/zero requirement'],
    });
  }

  /* ---- stepper/motor that is NOT a counter (the "miscounted stepper" bug) - */
  if (hasMotor && !counting) {
    assertions.push({
      id: 'press-counter-absent',
      title: 'A stepper/motor build has no press counter',
      subject: { kind: 'firmware', property: 'press_counter_absent' },
      operator: 'absent',
      required: true,
      derivedFrom: ['stepper/motor actuation is not a tally counter'],
    });
    assertions.push({
      id: 'telemetry-count-absent',
      title: 'Telemetry reports no press count field',
      subject: { kind: 'telemetry', field: 'count' },
      operator: 'absent',
      required: true,
      derivedFrom: ['stepper/motor actuation is not a tally counter'],
    });
  }

  return {
    assertions,
    origin: 'heuristics',
    generatedAt: nowIso(),
    notes:
      assertions.length === 0
        ? ['No checkable behaviours were recognised in this brief; only structural validation applies.']
        : [`Derived ${assertions.length} checkable behaviour(s) from the brief.`],
  };
}

/* ------------------------------------------------------------------------- */
/* Model payload merging                                                      */
/* ------------------------------------------------------------------------- */

function assertionKey(assertion: BehavioralAssertion): string {
  const subject = `${assertion.subject.kind}:${assertion.subject.property ?? assertion.subject.field ?? assertion.subject.pin ?? ''}`;
  return `${subject}|${assertion.operator}`;
}

/** Shape-check a model-supplied assertion payload, returning only valid ones. */
export function normalizeAssertionPayload(raw: unknown): BehavioralAssertion[] {
  if (!Array.isArray(raw)) return [];
  const out: BehavioralAssertion[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Partial<BehavioralAssertion>;
    if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string') continue;
    if (!candidate.subject || typeof candidate.subject.kind !== 'string') continue;
    if (typeof candidate.operator !== 'string') continue;
    out.push({
      id: candidate.id,
      title: candidate.title,
      subject: {
        kind: candidate.subject.kind,
        ...(candidate.subject.property ? { property: candidate.subject.property } : {}),
        ...(candidate.subject.field ? { field: candidate.subject.field } : {}),
        ...(candidate.subject.pin !== undefined ? { pin: candidate.subject.pin } : {}),
        ...(candidate.subject.instanceId ? { instanceId: candidate.subject.instanceId } : {}),
      },
      operator: candidate.operator,
      ...(candidate.expected !== undefined ? { expected: candidate.expected } : {}),
      ...(candidate.tolerance !== undefined ? { tolerance: candidate.tolerance } : {}),
      ...(candidate.scenario ? { scenario: candidate.scenario } : {}),
      required: candidate.required !== false,
      derivedFrom: Array.isArray(candidate.derivedFrom) ? candidate.derivedFrom : [],
    });
  }
  return out;
}

/** Merge the deterministic spec with model-provided assertions (deduped). */
export function mergeBehavioralSpecs(base: BehavioralSpec, extraAssertions: BehavioralAssertion[]): BehavioralSpec {
  if (extraAssertions.length === 0) return base;
  const existing = new Set(base.assertions.map(assertionKey));
  const added = extraAssertions.filter((assertion) => !existing.has(assertionKey(assertion)));
  if (added.length === 0) return base;
  return {
    assertions: [...base.assertions, ...added],
    origin: 'heuristics+model',
    generatedAt: nowIso(),
    notes: [...base.notes, `Model added ${added.length} additional behaviour(s).`],
  };
}
