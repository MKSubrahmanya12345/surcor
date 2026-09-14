import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  CodeChunk, IndexStats, IndexStatus, StoredEmbedding, StoredIndexFile, StoredIndexWorkspace,
} from "@forge/shared";

/**
 * SQLite persistence for the codebase index.
 *
 * Same database file as Prompt 3 (`bun:sqlite`, opened once by ForgeDatabase);
 * this module only adds queries over the three tables appended to schema.sql.
 * Everything is scoped by `workspace_id`, because one server indexes every
 * workspace it is ever pointed at and vectors must never leak across them.
 */

export function workspaceIdFor(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 32);
}

export interface ChunkRecord {
  chunk: CodeChunk;
  vector: number[];
}

export class IndexStore {
  constructor(private readonly sqlite: Database) {}

  loadWorkspace(id: string): StoredIndexWorkspace | null {
    const row = this.sqlite.query<StoredIndexWorkspace, [string]>(`
      SELECT id, workspace_root AS workspaceRoot, model, dimensions, status, files, chunks,
             last_build_at AS lastBuildAt, last_error AS lastError
      FROM index_workspaces WHERE id = ?
    `).get(id);
    return row ?? null;
  }

  /**
   * Create (or adopt) the index row for a workspace. Changing embedding model
   * or dimension makes every stored vector incomparable, so the index is wiped
   * and `reset` tells the caller to do a full rebuild.
   */
  ensureWorkspace(id: string, root: string, model: string, dimensions: number): { workspace: StoredIndexWorkspace; reset: boolean } {
    const existing = this.loadWorkspace(id);
    if (!existing) {
      this.sqlite.query(`
        INSERT INTO index_workspaces(id, workspace_root, model, dimensions, status, files, chunks)
        VALUES (?, ?, ?, ?, 'idle', 0, 0)
      `).run(id, root, model, dimensions);
      return { workspace: this.loadWorkspace(id)!, reset: false };
    }
    if (existing.model !== model || existing.dimensions !== dimensions) {
      this.sqlite.transaction(() => {
        this.sqlite.query("DELETE FROM embeddings WHERE workspace_id = ?").run(id);
        this.sqlite.query("DELETE FROM index_files WHERE workspace_id = ?").run(id);
        this.sqlite.query(`
          UPDATE index_workspaces SET model = ?, dimensions = ?, files = 0, chunks = 0, last_error = NULL WHERE id = ?
        `).run(model, dimensions, id);
      })();
      return { workspace: this.loadWorkspace(id)!, reset: true };
    }
    if (root !== existing.workspaceRoot) {
      // Same content hash but a moved folder (symlinked or restored path).
      this.sqlite.query("UPDATE index_workspaces SET workspace_root = ? WHERE id = ?").run(root, id);
    }
    return { workspace: this.loadWorkspace(id)!, reset: false };
  }

  setStatus(id: string, status: IndexStatus, error: string | null = null): void {
    this.sqlite.query("UPDATE index_workspaces SET status = ?, last_error = ? WHERE id = ?")
      .run(status, error, id);
  }

  setCounts(id: string, files: number, chunks: number, lastBuildAt: number): void {
    this.sqlite.query("UPDATE index_workspaces SET files = ?, chunks = ?, last_build_at = ?, status = 'ready', last_error = NULL WHERE id = ?")
      .run(files, chunks, lastBuildAt, id);
  }

  listFiles(id: string): StoredIndexFile[] {
    return this.sqlite.query<StoredIndexFile, [string]>(`
      SELECT relative_path AS relativePath, absolute_path AS absolutePath, size,
             mtime_ms AS mtimeMs, chunks, indexed_at AS indexedAt
      FROM index_files WHERE workspace_id = ?
    `).all(id);
  }

  /** Replace every chunk of one file, atomically, and record its fingerprint. */
  replaceFile(id: string, file: StoredIndexFile, records: ChunkRecord[], model: string, dimensions: number): void {
    this.sqlite.transaction(() => {
      this.sqlite.query("DELETE FROM embeddings WHERE workspace_id = ? AND relative_path = ?").run(id, file.relativePath);
      const insertChunk = this.sqlite.query(`
        INSERT INTO embeddings(id, workspace_id, relative_path, absolute_path, start_line, end_line,
                               language, content, vector, model, dimensions, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const record of records) {
        insertChunk.run(record.chunk.id, id, record.chunk.relativePath, record.chunk.absolutePath,
          record.chunk.startLine, record.chunk.endLine, record.chunk.language, record.chunk.content,
          JSON.stringify(record.vector), model, dimensions, file.indexedAt);
      }
      this.sqlite.query(`
        INSERT INTO index_files(workspace_id, relative_path, absolute_path, size, mtime_ms, chunks, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, relative_path) DO UPDATE SET
          absolute_path = excluded.absolute_path, size = excluded.size, mtime_ms = excluded.mtime_ms,
          chunks = excluded.chunks, indexed_at = excluded.indexed_at
      `).run(id, file.relativePath, file.absolutePath, file.size, file.mtimeMs, records.length, file.indexedAt);
    })();
  }

  removeFile(id: string, relativePath: string): void {
    this.sqlite.transaction(() => {
      this.sqlite.query("DELETE FROM embeddings WHERE workspace_id = ? AND relative_path = ?").run(id, relativePath);
      this.sqlite.query("DELETE FROM index_files WHERE workspace_id = ? AND relative_path = ?").run(id, relativePath);
    })();
  }

  removeFiles(id: string, relativePaths: Iterable<string>): number {
    const paths = [...relativePaths];
    if (!paths.length) return 0;
    // Deletes are inlined rather than calling removeFile() so this stays a
    // single transaction instead of relying on nested-transaction savepoints.
    this.sqlite.transaction(() => {
      for (const relativePath of paths) {
        this.sqlite.query("DELETE FROM embeddings WHERE workspace_id = ? AND relative_path = ?").run(id, relativePath);
        this.sqlite.query("DELETE FROM index_files WHERE workspace_id = ? AND relative_path = ?").run(id, relativePath);
      }
    })();
    return paths.length;
  }

  clear(id: string): void {
    this.sqlite.transaction(() => {
      this.sqlite.query("DELETE FROM embeddings WHERE workspace_id = ?").run(id);
      this.sqlite.query("DELETE FROM index_files WHERE workspace_id = ?").run(id);
    })();
  }

  loadEmbeddings(id: string): StoredEmbedding[] {
    return this.sqlite.query<StoredEmbedding, [string]>(`
      SELECT id, relative_path AS relativePath, absolute_path AS absolutePath,
             start_line AS startLine, end_line AS endLine, language, content,
             vector AS vectorJson, model, dimensions, indexed_at AS indexedAt
      FROM embeddings WHERE workspace_id = ?
    `).all(id);
  }

  /** Chunk count for one file, used to keep `index_workspaces.chunks` honest. */
  countChunks(id: string): number {
    const row = this.sqlite.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM embeddings WHERE workspace_id = ?",
    ).get(id);
    return row?.count ?? 0;
  }

  stats(root: string, id: string, skipped = 0): IndexStats {
    const workspace = this.loadWorkspace(id);
    return {
      workspaceRoot: root,
      status: workspace?.status ?? "idle",
      files: workspace?.files ?? 0,
      chunks: workspace?.chunks ?? 0,
      skipped,
      model: workspace?.model ?? null,
      dimensions: workspace?.dimensions ?? null,
      provider: workspace?.model ? workspace.model.split(":")[0] ?? null : null,
      lastBuildAt: workspace?.lastBuildAt ?? null,
      lastError: workspace?.lastError ?? null,
    };
  }
}
