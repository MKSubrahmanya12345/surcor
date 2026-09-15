/**
 * Smoke tests for @forge/wireup.
 *
 * These prove the ported engine is alive in Forge:
 *   1. the bundled component catalog seeds itself;
 *   2. a full project run completes OFFLINE (no Bedrock) with real artifacts;
 *   3. the persistence sink round-trips a project through a "restart".
 *
 * Runtime deps that touch external processes are turned off so the tests are
 * deterministic on any machine.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  countComponents,
  createProjectRecord,
  getCatalog,
  getComponentById,
  getProjectState,
  hydrateIfNeeded,
  listComponents,
  listProjectStates,
  registerPersistenceSink,
  resetMemoryDb,
  resetPersistenceSink,
  runGeneration,
  type ComponentDefinition,
  type PersistenceSink,
  type ProjectState,
  type ProjectRow,
} from '../src/index';

const ORIGINAL_ENV: Record<string, string | undefined> = { ...process.env };

const NO_AWS = { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_REGION: 'us-east-1', AWS_SESSION_TOKEN: '' };

beforeAll(() => {
  process.env.WIREUP_LOG_LEVEL = 'warn';
  process.env.WIREUP_MAX_FIX_ITERATIONS = '1';
  process.env.WIREUP_ENABLE_LLM_VALIDATION = 'false';
  process.env.WIREUP_ENABLE_LLM_FIXER = 'false';
  process.env.WIREUP_ENABLE_LLM_CODEGEN = 'false';
  process.env.WIREUP_ENABLE_FIRMWARE_COMPILE = 'false';
  process.env.WIREUP_ENABLE_REAL_SIM_LOOP = 'false';
  process.env.WIREUP_ENABLE_EVERFLOW_ACTIONS = 'false';
  // Guarantee the deterministic path even if the host machine has AWS creds.
  for (const [key, value] of Object.entries(NO_AWS)) process.env[key] = value;
  resetMemoryDb();
  resetPersistenceSink();
});

afterAll(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetMemoryDb();
  resetPersistenceSink();
});

describe('component catalog', () => {
  test('seeds the bundled registry on first access', async () => {
    const state = await getCatalog();
    expect(state.components.length).toBeGreaterThan(50);
    expect(state.components.length).toBeGreaterThanOrEqual(await countComponents());
  }, 30_000);

  test('catalog entries are complete and queryable', async () => {
    const all: ComponentDefinition[] = await listComponents();
    expect(all.length).toBeGreaterThan(50);
    const microcontroller = all.find((c) => c.category === 'microcontroller');
    expect(microcontroller).toBeDefined();
    const byId = await getComponentById(microcontroller!.id);
    expect(byId).toBeDefined();
    expect(byId!.name).toBe(microcontroller!.name);
  }, 30_000);
});

describe('offline deterministic project run', () => {
  test(
    'prompt → complete project with artifacts, revisions and a final status',
    async () => {
      const created = await createProjectRecord({
        prompt: 'A servo-based distance sensor that rotates an SG90 when an ultrasonic sensor detects something closer than 30cm.',
      });
      expect(created.id).toBeTruthy();

      const final: ProjectState = await runGeneration(created.id, {
        onProgress: () => {},
      });

      expect(['completed', 'completed_with_warnings', 'completed_with_errors', 'failed']).toContain(final.status);
      expect(final.components.length).toBeGreaterThan(0);
      expect(final.hardwarePlan).not.toBeNull();
      expect(final.wiring).not.toBeNull();
      expect(final.wiring!.connections.length).toBeGreaterThan(0);
      expect(final.artifacts.code).not.toBeNull();
      expect(final.artifacts.code!.files.length).toBeGreaterThan(0);
      expect(final.revisions.length).toBeGreaterThanOrEqual(1);
      expect(final.validation).not.toBeNull();

      const persisted = await getProjectState(created.id);
      expect(persisted).not.toBeNull();
      expect(persisted!.artifacts.code!.files.length).toBe(final.artifacts.code!.files.length);
    },
    120_000,
  );
});

describe('persistence sink (Forge SQLite workstate)', () => {
  function fakeSink(): PersistenceSink & { docs: Map<string, Record<string, unknown>> } {
    const docs = new Map<string, Record<string, unknown>>();
    return {
      docs,
      saveProject: (id, doc) => void docs.set(id, doc),
      deleteProject: (id) => void docs.delete(id),
      loadProjects: () => [...docs.entries()].map(([id, doc]): ProjectRow => ({ id, doc })),
      saveComponent: (def) => void docs.set(`c:${def.id}`, def as unknown as Record<string, unknown>),
      deleteComponent: (id) => void docs.delete(`c:${id}`),
      loadComponents: () =>
        [...docs.entries()]
          .filter(([key]) => key.startsWith('c:'))
          .map(([, val]) => val as unknown as ComponentDefinition),
    };
  }

  test('a project survives a simulated restart through the sink', async () => {
    const sink = fakeSink();
    registerPersistenceSink(sink);
    hydrateIfNeeded();

    const created = await createProjectRecord({ prompt: 'Blink two LEDs at different rates using one Arduino Uno.' });
    expect(sink.docs.has(created.id)).toBe(true);

    // "Restart": wipe the process store, re-register the same sink, re-run the run.
    const run = await runGeneration(created.id, { onProgress: () => {} });
    expect(run.artifacts.code).not.toBeNull();

    resetMemoryDb();
    registerPersistenceSink(sink);
    hydrateIfNeeded();

    const restored = await getProjectState(created.id);
    expect(restored).not.toBeNull();
    expect(restored!.components.length).toBe(run.components.length);
  }, 120_000);

  test('listProjectStates reaches the sink-restored store', async () => {
    const states = await listProjectStates(10);
    expect(states.length).toBeGreaterThan(0);
  }, 15_000);
});