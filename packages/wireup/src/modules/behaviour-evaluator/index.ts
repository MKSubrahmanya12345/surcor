/**
 * Behaviour evaluator — the assertion layer that turns the prompt's promises
 * into checks run against the generated firmware (statically) and the emulated
 * firmware (at runtime).
 *
 * Public surface:
 *   • `deriveBehavioralSpec`        — build the spec at decomposition time.
 *   • `normalizeAssertionPayload`   — shape-check model-supplied assertions.
 *   • `mergeBehavioralSpecs`        — dedupe/merge deterministic + model specs.
 *   • `evaluateBehavioral`          — run the spec against a project and report.
 */

export { deriveBehavioralSpec, mergeBehavioralSpecs, normalizeAssertionPayload } from './derive';
export { compareBehavioral, describeExpected, parseArduinoPinNumber, telemetryFieldSeries } from './assertions';
export { evaluateBehavioral } from './evaluate';
export type { BehavioralEvaluationInput } from './evaluate';
export { compileAndRunFirmware } from './emitter';
export type { RunFirmwareOptions, RunFirmwareResult, RunScenarioStep } from './emitter';
export { behavioralFindings } from './findings';
export type { BehavioralFindings } from './findings';
