/**
 * Shared assertion machinery for BOTH runtime evaluators.
 *
 * Two modules execute firmware and check `BehavioralAssertion`s against the
 * observed trace:
 *
 *   • `behaviour-evaluator/evaluate.ts` — the host-exec stub simulator
 *     (scripts/firmware-shim-runtime), and
 *   • `sim-validator` — the real AVR emulator (avr8js + arduino-cli hex).
 *
 * They used to each carry their own copy of the comparison logic, the
 * telemetry parser and the pin-string parser — copies that had already drifted
 * (one matched only `"field":` JSON telemetry, the other matched bare
 * `field:` too, and neither anchored field names, so an assertion on `count`
 * also matched `discount`). One implementation lives here so a fix applies to
 * both feedback paths at once.
 *
 * Everything here is pure and deterministic — no I/O, safe to run offline.
 */

import type { BehavioralAssertion, FirmwareTrace } from '@/types/behavioral';

/** Human-readable rendering of what an assertion expects (messages only). */
export function describeExpected(assertion: BehavioralAssertion): string {
  if (assertion.operator === 'present') return 'present';
  if (assertion.operator === 'absent') return 'absent';
  if (Array.isArray(assertion.expected)) return `${assertion.expected[0]}…${assertion.expected[1]}`;
  return String(assertion.expected ?? '');
}

/**
 * Compare an observed value against the assertion's operator + expectation.
 * Numeric comparisons honour `tolerance`; non-numeric values fall back to
 * strict string equality for eq/neq.
 */
export function compareBehavioral(
  actual: number | string,
  operator: BehavioralAssertion['operator'],
  expected: unknown,
  tolerance: number,
): boolean {
  if (operator === 'present' || operator === 'absent') {
    const value = actual === 'present';
    return operator === 'present' ? value : !value;
  }
  if (operator === 'contains') {
    return String(actual).includes(String(expected ?? ''));
  }

  const expectedNumber = typeof expected === 'number' ? expected : Number(expected);
  if (operator === 'in_range' && Array.isArray(expected)) {
    const actualNumber = Number(actual);
    return (
      Number.isFinite(actualNumber) &&
      actualNumber >= Number(expected[0]) - tolerance &&
      actualNumber <= Number(expected[1]) + tolerance
    );
  }

  const actualNumber = Number(actual);
  if (Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)) {
    switch (operator) {
      case 'eq':
        return Math.abs(actualNumber - expectedNumber) <= tolerance;
      case 'neq':
        return Math.abs(actualNumber - expectedNumber) > tolerance;
      case 'gte':
        return actualNumber >= expectedNumber - tolerance;
      case 'lte':
        return actualNumber <= expectedNumber + tolerance;
      case 'gt':
        return actualNumber > expectedNumber + tolerance;
      case 'lt':
        return actualNumber < expectedNumber - tolerance;
      default:
        return false;
    }
  }

  // Non-numeric fallback: strict equality for eq/neq.
  if (operator === 'eq') return String(actual) === String(expected);
  if (operator === 'neq') return String(actual) !== String(expected);
  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse every numeric value of `field` out of the trace's serial lines, in
 * order of observation.
 *
 * Accepts both telemetry shapes the generators emit — JSON (`"count": 3`) and
 * bare (`count:3`). Field names are regex-escaped and word-anchored so an
 * assertion on `count` can no longer be satisfied by `discount:5`.
 */
export function telemetryFieldSeries(trace: FirmwareTrace, field: string): number[] {
  const series: number[] = [];
  if (field.length === 0) return series;
  const escaped = escapeRegExp(field);
  const pattern = new RegExp(`(?:"${escaped}"|\\b${escaped})\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'gi');

  for (const line of trace.serialLines) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line.text)) !== null) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) series.push(value);
    }
  }
  return series;
}

/**
 * Parse an Arduino pin label into the canonical digital pin number:
 * `A0`→14 … `A7`→21, `D5`/`5`→5. Returns undefined for anything else
 * (e.g. `SCL`, `MOSI` — those are resolved by the planners, not here).
 */
export function parseArduinoPinNumber(pinStr: string): number | undefined {
  const trimmed = pinStr.trim().toUpperCase();
  if (/^A[0-7]$/.test(trimmed)) return 14 + parseInt(trimmed.slice(1), 10);
  if (/^D?\d{1,2}$/.test(trimmed)) return parseInt(trimmed.replace(/^D/, ''), 10);
  return undefined;
}
