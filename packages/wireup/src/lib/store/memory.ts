/**
 * In-memory project/catalog store — the zero-infra fallback.
 *
 * When `MONGODB_URI` is not configured (and `WIREUP_IN_MEMORY_STORE` has not
 * been forced off) Wireup runs entirely inside the process: projects, events
 * and the component catalog live in a `Map` on `globalThis`. This is what lets
 * `pnpm dev` work on a fresh clone with zero credentials and zero services —
 * the same honesty rule as every other fallback in this repo:
 *
 *   • it is NEVER silent — the store reports its mode, and every project
 *     created in memory gets a first event saying data is lost on restart;
 *   • it is NEVER mixed — if a Mongo URI is set, the Mongo path is used;
 *   • it implements the exact contract of the Mongo repository functions
 *     (same inputs, same shapes), so no caller branches on the mode.
 *
 * Data shape note: documents are stored as plain objects and handed through
 * `serializeProject`, which already tolerates string or Date timestamps.
 */

import type { ComponentDefinition } from '@/types/component';
import type { AgentEvent } from '@/types/generation';

import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';

/** Raw project document — mirrors the Mongo document shape loosely enough for `serializeProject`. */
export type MemoryProjectDoc = Record<string, unknown> & {
  _id: string;
  events: AgentEvent[];
  createdAt: Date;
  updatedAt: Date;
};

interface MemoryDb {
  projects: Map<string, MemoryProjectDoc>;
  components: Map<string, ComponentDefinition>;
}

declare global {
  // eslint-disable-next-line no-var
  var __wireupMemoryDb: MemoryDb | undefined;
}

/** The process-wide database (survives dev hot reloads via globalThis). */
export function memoryDb(): MemoryDb {
  if (!globalThis.__wireupMemoryDb) {
    globalThis.__wireupMemoryDb = { projects: new Map(), components: new Map() };
  }
  return globalThis.__wireupMemoryDb;
}

/** Test/diagnostic helper: drop everything (the store has no persistence). */
export function resetMemoryDb(): void {
  globalThis.__wireupMemoryDb = { projects: new Map(), components: new Map() };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/* ------------------------------------------------------------------------- */
/* Projects                                                                   */
/* ------------------------------------------------------------------------- */

export function memoryCreateProject(
  seed: Omit<MemoryProjectDoc, '_id' | 'createdAt' | 'updatedAt'> & { events?: AgentEvent[] },
): MemoryProjectDoc {
  const db = memoryDb();
  const id = createId('memproj');
  const now = new Date();
  const doc: MemoryProjectDoc = { events: [], ...seed, _id: id, createdAt: now, updatedAt: now };
  db.projects.set(id, doc);
  return doc;
}

export function memoryGetProject(id: string): MemoryProjectDoc | null {
  return memoryDb().projects.get(id) ?? null;
}

/** `$set`-style shallow patch, mirroring `findByIdAndUpdate(id, { $set: patch })`. */
export function memorySaveProject(id: string, patch: Record<string, unknown>): MemoryProjectDoc | null {
  const db = memoryDb();
  const current = db.projects.get(id);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: new Date() } as MemoryProjectDoc;
  db.projects.set(id, next);
  return next;
}

export function memoryListProjects(limit: number): MemoryProjectDoc[] {
  return [...memoryDb().projects.values()]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit);
}

export function memoryAppendEvents(id: string, events: AgentEvent[], maxEvents: number): void {
  const current = memoryDb().projects.get(id);
  if (!current) return;
  const merged = [...current.events, ...events].slice(-maxEvents);
  memorySaveProject(id, { events: merged });
}

export function memoryDeleteProject(id: string): boolean {
  return memoryDb().projects.delete(id);
}

/* ------------------------------------------------------------------------- */
/* Components                                                                 */
/* ------------------------------------------------------------------------- */

export function memoryCountComponents(): number {
  return memoryDb().components.size;
}

export function memoryListComponents(): ComponentDefinition[] {
  return [...memoryDb().components.values()].sort((a, b) =>
    a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category),
  );
}

export function memoryGetComponent(id: string): ComponentDefinition | null {
  return memoryDb().components.get(id) ?? null;
}

export function memoryUpsertComponents(definitions: ComponentDefinition[]): { inserted: number; updated: number; total: number } {
  const db = memoryDb();
  let inserted = 0;
  let updated = 0;
  for (const definition of definitions) {
    if (!db.components.has(definition.id)) inserted += 1;
    else updated += 1;
    db.components.set(definition.id, clone(definition));
  }
  return { inserted, updated, total: db.components.size };
}

export function memoryDeleteComponent(id: string): boolean {
  return memoryDb().components.delete(id);
}

export function memoryNowIso(): string {
  return nowIso();
}
