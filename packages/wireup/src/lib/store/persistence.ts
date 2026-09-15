/**
 * Persistence sink — the pluggable seam that lets Forge back Wireup's
 * in-process store with SQLite (or anything else) WITHOUT the engine knowing
 * what the backing store is.
 *
 * The engine's repository layer (`lib/mongodb/*`, memory-mode) calls the
 * registered sink after every mutation and hydrates from it once on first
 * access, so project state and the component catalog survive a restart while
 * every Wireup component keeps working with zero changes.
 */

import { memoryDb, type MemoryProjectDoc } from '@/lib/store/memory';
import type { ComponentDefinition } from '@/types/component';

export interface ProjectRow {
  id: string;
  doc: Record<string, unknown>;
}

export interface PersistenceSink {
  saveProject(id: string, doc: Record<string, unknown>): void;
  deleteProject(id: string): void;
  loadProjects(): ProjectRow[];
  saveComponent(def: ComponentDefinition): void;
  deleteComponent(id: string): void;
  loadComponents(): ComponentDefinition[];
}

let active: PersistenceSink | null = null;
let hydrated = false;

/** Forge calls this once at boot with its SQLite-backed sink. */
export function registerPersistenceSink(sink: PersistenceSink): void {
  active = sink;
  hydrated = false;
}

export function getPersistenceSink(): PersistenceSink | null {
  return active;
}

/** True when a sink is registered (used to phrase survival notices honestly). */
export function hasPersistenceSink(): boolean {
  return active !== null;
}

/** Seed the in-process store from the sink exactly once per registration. */
export function hydrateIfNeeded(): void {
  if (hydrated) return;
  hydrated = true;
  const sink = getPersistenceSink();
  if (!sink) return;
  const db = memoryDb();
  for (const row of sink.loadProjects()) {
    db.projects.set(row.id, row.doc as unknown as MemoryProjectDoc);
  }
  for (const def of sink.loadComponents()) {
    db.components.set(def.id, db.components.get(def.id) ?? cloneComponent(def));
  }
}

function cloneComponent(def: ComponentDefinition): ComponentDefinition {
  return JSON.parse(JSON.stringify(def)) as ComponentDefinition;
}

/** Test/diagnostic helper: forget the registered sink (store stays in-process). */
export function resetPersistenceSink(): void {
  active = null;
  hydrated = false;
}