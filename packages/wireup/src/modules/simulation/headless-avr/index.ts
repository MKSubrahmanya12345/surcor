/**
 * Headless AVR simulation module.
 *
 * Provides real AVR8 instruction-level emulation using avr8js without a browser.
 * This enables the validation pipeline to execute compiled firmware and verify
 * behavioral assertions against actual peripheral behavior.
 *
 * Extracted and generalized from external/velxio/test/test_circuit/src/avr/AVRHarness.js
 * to support dynamic pin assignments and wiring graphs from the project's wiring plan.
 */

export { HeadlessAVRHarness, runSimulation } from './harness';
export { parseIntelHex, bytesToProgramWords } from './intel-hex';
export type {
  HarnessOptions,
  HarnessResult,
  HarnessPeripheral,
  HarnessScenarioStep,
} from './harness';
