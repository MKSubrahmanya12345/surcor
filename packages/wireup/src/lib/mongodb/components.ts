/**
 * Component catalog repository — in-process store backed by the pluggable
 * persistence sink (Forge's SQLite), replacing the MongoDB variant.
 *
 * Same exported surface as the original `@/lib/mongodb/components`.
 */

import type { ComponentDefinition } from '@/types/component';

import { createLogger, describeError } from '@/lib/logging/logger';
import {
  memoryCountComponents,
  memoryDeleteComponent,
  memoryGetComponent,
  memoryListComponents,
  memoryUpsertComponents,
} from '@/lib/store/memory';
import { getPersistenceSink, hydrateIfNeeded } from '@/lib/store/persistence';

const logger = createLogger('wireup:store:components');

function flushComponent(def: ComponentDefinition): void {
  const sink = getPersistenceSink();
  sink?.saveComponent(def);
}

export async function countComponents(): Promise<number> {
  hydrateIfNeeded();
  return memoryCountComponents();
}

export async function listComponents(): Promise<ComponentDefinition[]> {
  hydrateIfNeeded();
  return memoryListComponents();
}

export async function getComponentById(id: string): Promise<ComponentDefinition | null> {
  hydrateIfNeeded();
  return memoryGetComponent(id);
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  total: number;
}

/** Idempotent upsert keyed on the catalog `id`. */
export async function upsertComponents(definitions: ComponentDefinition[]): Promise<UpsertResult> {
  hydrateIfNeeded();
  const result = memoryUpsertComponents(definitions);
  for (const definition of definitions) flushComponent(definition);
  logger.info('upserted catalog (wireup store)', result);
  return result;
}

export async function deleteComponent(id: string): Promise<boolean> {
  hydrateIfNeeded();
  const deleted = memoryDeleteComponent(id);
  if (deleted) getPersistenceSink()?.deleteComponent(id);
  return deleted;
}

/** Wrap catalog reads so an unavailable store degrades to the bundled seed. */
export async function tryListComponents(): Promise<{ components: ComponentDefinition[]; source: 'mongodb' | 'error'; error?: string }> {
  try {
    const components = await listComponents();
    return { components, source: 'mongodb' };
  } catch (error) {
    const described = describeError(error);
    logger.warn('catalog read failed, falling back to bundled seed', { error: described.message });
    return { components: [], source: 'error', error: described.message };
  }
}