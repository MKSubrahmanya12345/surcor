/**
 * Forge SQLite persistence sink for the wireup engine.
 *
 * The engine keeps its project workstate + component catalog in an in-process
 * store and flushes every mutation through the pluggable `PersistenceSink`
 * seam. This adapter writes those documents as JSON blobs into the same
 * forge.sqlite file sessions/messages live in, and hydrates the process store
 * once at boot so hardware projects survive a server restart.
 */

import type { Database } from "bun:sqlite";
import type { ComponentDefinition, PersistenceSink } from "@forge/wireup";
import { hydrateIfNeeded, registerPersistenceSink } from "@forge/wireup";

export function initWireupStore(sqlite: Database): void {
  const sink: PersistenceSink = {
    saveProject(id, doc) {
      sqlite.query(
        "INSERT INTO wireup_projects(id, doc, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at",
      ).run(id, JSON.stringify(doc), Date.now());
    },
    deleteProject(id) {
      sqlite.query("DELETE FROM wireup_projects WHERE id = ?").run(id);
    },
    loadProjects() {
      return sqlite.query<{ id: string; doc: string }, []>("SELECT id, doc FROM wireup_projects")
        .all()
        .map((row) => ({ id: row.id, doc: JSON.parse(row.doc) as Record<string, unknown> }));
    },
    saveComponent(def) {
      sqlite.query(
        "INSERT INTO wireup_components(id, doc, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at",
      ).run(def.id, JSON.stringify(def), Date.now());
    },
    deleteComponent(id) {
      sqlite.query("DELETE FROM wireup_components WHERE id = ?").run(id);
    },
    loadComponents() {
      return sqlite.query<{ doc: string }, []>("SELECT doc FROM wireup_components")
        .all()
        .map((row) => JSON.parse(row.doc) as ComponentDefinition);
    },
  };
  registerPersistenceSink(sink);
  hydrateIfNeeded();
}