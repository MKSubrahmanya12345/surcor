import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import type { CodeChunk, IndexConfig, IndexStats } from "@forge/shared";
import { readTextFile } from "../tools/paths";
import { chunkFile } from "./chunker";
import { IgnoreStack, isSkippedFile, looksMinified, parseIgnoreRules, type IgnoreRule } from "./ignore";
import { workspaceIdFor, type ChunkRecord, type IndexStore } from "./store";
import type { FallbackEmbedder } from "./embedder";

/**
 * Workspace indexer: walks the tree, chunks each text file, embeds the chunks
 * and stores them in SQLite.
 *
 * It builds once when a workspace is opened and then updates incrementally:
 * `refresh()` re-fingerprints the tree (size + mtime) and re-embeds only what
 * changed. That is what keeps the index honest when a file is edited in Monaco
 * or written by an accepted diff — both go through the Electron client's
 * `fs:writeFile` handler and never pass through this server. `indexFile()`
 * additionally re-embeds a single file the moment the server's own `write_file`
 * tool writes it.
 */

export interface WalkEntry {
  relativePath: string;   // workspace-relative, "/" separated
  absolutePath: string;
  size: number;
  mtimeMs: number;
}

export interface IndexTotals {
  files: number;
  chunks: number;
}

const IGNORE_FILE_NAMES = [".gitignore", ".forgeignore"];
const PROGRESS_EVERY_FILES = 100;
const PROGRESS_EVERY_MS = 2_000;
const FAILURE_RETRY_MS = 30_000;

const shortRoot = (root: string): string => basename(root) || root;
const toRelativeKey = (path: string): string => (sep === "/" ? path : path.replaceAll(sep, "/"));

interface PendingFile {
  entry: WalkEntry;
  chunks: CodeChunk[];
  records: ChunkRecord[];
  missing: number;
}

/** `stat` without the throw: files vanishing mid-walk is normal, not an error. */
async function probeStat(absolutePath: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(absolutePath);
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch { return null; }
}

export class WorkspaceIndexer {
  readonly id: string;
  private queue: Promise<unknown> = Promise.resolve();
  private skipped = 0;
  private lastFailureAt = 0;
  private lastUpToDateLog = 0;
  private rootIgnore: IgnoreStack | null = null;

  constructor(
    readonly root: string,
    private readonly store: IndexStore,
    private readonly embedder: FallbackEmbedder | null,
    private readonly config: IndexConfig,
  ) {
    this.id = workspaceIdFor(root);
  }

  get stats(): IndexStats {
    return this.store.stats(this.root, this.id, this.skipped);
  }

  /** Serialize every mutation: one build/refresh/single-file update at a time. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Build if there is no usable index yet, otherwise bring it up to date. */
  ready(signal?: AbortSignal): Promise<IndexStats> {
    return this.enqueue(async () => {
      const workspace = this.store.loadWorkspace(this.id);
      if (workspace && workspace.status === "ready" && workspace.files > 0) return this.refreshNow(signal);
      return this.buildNow(signal);
    });
  }

  build(signal?: AbortSignal): Promise<IndexStats> {
    return this.enqueue(() => this.buildNow(signal));
  }

  refresh(signal?: AbortSignal): Promise<IndexStats> {
    return this.enqueue(() => this.refreshNow(signal));
  }

  /** Re-embed one file, immediately after the write_file tool wrote it. */
  indexFile(absolutePath: string, signal?: AbortSignal): Promise<void> {
    return this.enqueue(async () => {
      if (!this.config.enabled || !this.embedder) return;
      const workspace = this.store.loadWorkspace(this.id);
      if (!workspace?.model || !workspace.dimensions || workspace.status === "indexing") return;
      const entry = await this.entryFor(absolutePath);
      if (!entry) { return; }
      const ignore = await this.rootIgnoreStack();
      if (ignore.isIgnored(entry.relativePath, false) || isSkippedFile(entry.relativePath)) {
        this.store.removeFile(this.id, entry.relativePath);
        return;
      }
      const totals = await this.indexEntries([entry], { model: workspace.model, dimensions: workspace.dimensions }, signal, "file");
      if (workspace.status === "ready") {
        this.store.setCounts(this.id, this.store.listFiles(this.id).length, this.store.countChunks(this.id), Date.now());
      }
      if (totals.chunks) {
        console.info(`[index] ${shortRoot(this.root)}: re-indexed ${entry.relativePath} (${totals.chunks} chunks)`);
      }
    });
  }

  forgetFile(absolutePath: string): Promise<void> {
    return this.enqueue(async () => {
      const relativePath = this.relativeKey(absolutePath);
      if (relativePath) this.store.removeFile(this.id, relativePath);
    });
  }

  /** A build failed recently; do not pay its timeout again on every search. */
  inFailureCooldown(now = Date.now()): boolean {
    return this.lastFailureAt > 0 && now - this.lastFailureAt < FAILURE_RETRY_MS;
  }

  private noEmbedderMessage(): string {
    return "No embedding provider is available: start Ollama and pull the embedding model " +
      `(\`ollama pull ${this.config.ollama.model}\`), or set OPENAI_API_KEY to embed with ${this.config.openai.model}.`;
  }

  private assertReadyToRun(): FallbackEmbedder {
    if (!this.config.enabled) throw new Error("Codebase indexing is disabled (INDEX_ENABLED=false).");
    if (!this.embedder) throw new Error(this.noEmbedderMessage());
    return this.embedder;
  }

  /** Workspace-relative key for an absolute path, or null when outside/dot-equal. */
  private relativeKey(absolutePath: string): string | null {
    const value = toRelativeKey(relative(this.root, absolutePath));
    if (!value || value === "." || value.startsWith("../") || value.startsWith("/")) return null;
    return value;
  }

  private async entryFor(absolutePath: string): Promise<WalkEntry | null> {
    const relativePath = this.relativeKey(absolutePath);
    if (!relativePath) return null;
    const info = await probeStat(absolutePath);
    if (!info || info.size > this.config.maxFileBytes) return null;
    return { relativePath, absolutePath, size: info.size, mtimeMs: info.mtimeMs };
  }

  private async rootIgnoreStack(): Promise<IgnoreStack> {
    if (this.rootIgnore) return this.rootIgnore;
    this.rootIgnore = IgnoreStack.from(await this.readIgnoreRules(this.root));
    return this.rootIgnore;
  }

  private async readIgnoreRules(directory: string): Promise<IgnoreRule[]> {
    const rules: IgnoreRule[] = [];
    for (const name of IGNORE_FILE_NAMES) {
      try {
        rules.push(...parseIgnoreRules(await readFile(join(directory, name), "utf8")));
      } catch { /* absent or unreadable: nothing to honour */ }
    }
    return rules;
  }

  // -------------------------------------------------------------------------
  // Build / refresh
  // -------------------------------------------------------------------------

  private async buildNow(signal?: AbortSignal): Promise<IndexStats> {
    const embedder = this.assertReadyToRun();
    const label = shortRoot(this.root);
    const started = Date.now();
    try {
      this.store.setStatus(this.id, "indexing", null);
      // One probe request resolves which provider is actually alive and how wide
      // its vectors are, before ten thousand chunks are queued behind it.
      const probe = await embedder.probe(signal);
      const { reset } = this.store.ensureWorkspace(this.id, this.root, probe.model, probe.dimensions);
      if (reset) console.info(`[index] ${label}: embedding model is now ${probe.model}; discarding previous vectors.`);
      console.info(`[index] ${label}: indexing workspace with ${probe.model} (${probe.dimensions} dimensions)`);
      const entries = await this.walk(signal);
      this.store.clear(this.id);
      const totals = await this.indexEntries(entries, probe, signal, "build");
      // Counts come from the database so a build and a refresh always agree:
      // `files` includes files that were fingerprinted but contributed no
      // chunks (empty, binary, minified), which is what stops refresh() from
      // re-reading them forever.
      const files = this.store.listFiles(this.id).length;
      const chunks = this.store.countChunks(this.id);
      this.store.setCounts(this.id, files, chunks, Date.now());
      this.lastFailureAt = 0;
      console.info(`[index] ${label}: ready — ${files} files (${totals.chunks} embedded chunks), ${this.skipped} skipped in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return this.stats;
    } catch (error) {
      this.lastFailureAt = Date.now();
      const message = error instanceof Error ? error.message : String(error);
      if (!signal?.aborted) {
        this.store.setStatus(this.id, "error", message);
        console.error(`[index] ${label}: build failed — ${message}`);
      }
      throw error;
    }
  }

  private async refreshNow(signal?: AbortSignal): Promise<IndexStats> {
    const embedder = this.assertReadyToRun();
    const label = shortRoot(this.root);
    const started = Date.now();
    const workspace = this.store.loadWorkspace(this.id);
    if (!workspace?.model || !workspace.dimensions || workspace.status === "idle") return this.buildNow(signal);
    try {
      const entries = await this.walk(signal);
      // A provider swap since the last build (Ollama died, OpenAI took over)
      // invalidates every stored vector, so rebuild from scratch instead.
      if (embedder.vectorModel !== workspace.model) {
        console.info(`[index] ${label}: embedding model changed (${workspace.model} -> ${embedder.vectorModel}); rebuilding.`);
        return this.buildNow(signal);
      }
      const vectorModel = { model: workspace.model, dimensions: workspace.dimensions };
      const stored = new Map(this.store.listFiles(this.id).map((file) => [file.relativePath, file]));
      const changed: WalkEntry[] = [];
      for (const entry of entries) {
        const previous = stored.get(entry.relativePath);
        if (!previous || previous.size !== entry.size || Math.round(previous.mtimeMs) !== Math.round(entry.mtimeMs)) {
          changed.push(entry);
        }
        stored.delete(entry.relativePath);
      }
      const removed = [...stored.keys()];
      if (removed.length) this.store.removeFiles(this.id, removed);
      let totals: IndexTotals = { files: 0, chunks: 0 };
      if (changed.length) {
        this.store.setStatus(this.id, "indexing", null);
        totals = await this.indexEntries(changed, vectorModel, signal, "refresh");
      }
      const files = this.store.listFiles(this.id).length;
      const chunks = this.store.countChunks(this.id);
      this.store.setCounts(this.id, files, chunks, Date.now());
      this.lastFailureAt = 0;
      if (changed.length || removed.length) {
        this.lastUpToDateLog = Date.now();
        console.info(`[index] ${label}: refreshed — ${changed.length} changed, ${removed.length} removed, ${totals.chunks} new chunks in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      } else if (Date.now() - this.lastUpToDateLog > 60_000) {
        // Refreshes run before every search; only report "nothing to do" once a
        // minute so the console stays readable.
        this.lastUpToDateLog = Date.now();
        console.info(`[index] ${label}: up to date (${files} files, ${chunks} chunks)`);
      }
      return this.stats;
    } catch (error) {
      this.lastFailureAt = Date.now();
      const message = error instanceof Error ? error.message : String(error);
      if (!signal?.aborted) {
        this.store.setStatus(this.id, "error", message);
        console.error(`[index] ${label}: refresh failed — ${message}`);
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Walking
  // -------------------------------------------------------------------------

  private async walk(signal?: AbortSignal): Promise<WalkEntry[]> {
    signal?.throwIfAborted();
    this.skipped = 0; // per-walk counter, so refreshes never accumulate it
    const stack = await this.rootIgnoreStack();
    const entries: WalkEntry[] = [];
    let truncated = false;

    const walkInto = async (directory: string, prefix: string, layers: IgnoreStack, depth: number): Promise<void> => {
      if (truncated) return;
      signal?.throwIfAborted();
      let dirents;
      try {
        dirents = await readdir(directory, { withFileTypes: true });
      } catch { return; } // unreadable directory: skip it, keep indexing the rest
      dirents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

      let layer = layers;
      if (depth > 0) {
        const nested = await this.readIgnoreRules(directory);
        if (nested.length) layer = layers.withLayer(prefix, nested);
      }

      for (const dirent of dirents) {
        if (truncated) return;
        // Never follow symlinks: they can loop or escape the workspace.
        if (dirent.isSymbolicLink() || dirent.name === ".DS_Store") continue;
        const relativePath = prefix ? `${prefix}/${dirent.name}` : dirent.name;
        const absolutePath = join(directory, dirent.name);
        if (dirent.isDirectory()) {
          if (depth + 1 > this.config.maxDepth || layer.isIgnored(relativePath, true)) continue;
          await walkInto(absolutePath, relativePath, layer, depth + 1);
          continue;
        }
        if (!dirent.isFile()) continue;
        if (layer.isIgnored(relativePath, false) || isSkippedFile(relativePath)) { this.skipped++; continue; }
        if (entries.length >= this.config.maxFiles) { truncated = true; return; }
        const info = await probeStat(absolutePath);
        if (!info) continue;
        if (info.size > this.config.maxFileBytes) { this.skipped++; continue; }
        entries.push({ relativePath, absolutePath, size: info.size, mtimeMs: info.mtimeMs });
      }
    };

    await walkInto(this.root, "", stack, 0);
    if (truncated) {
      console.warn(`[index] ${shortRoot(this.root)}: hit INDEX_MAX_FILES (${this.config.maxFiles}); the index is partial.`);
    }
    return entries;
  }

  // -------------------------------------------------------------------------
  // Chunk + embed + store
  // -------------------------------------------------------------------------

  private async indexEntries(
    entries: WalkEntry[],
    vectorModel: { model: string; dimensions: number },
    signal?: AbortSignal,
    phase: "build" | "refresh" | "file" = "build",
  ): Promise<IndexTotals> {
    const embedder = this.assertReadyToRun();
    const label = shortRoot(this.root);
    const total = entries.length;
    let done = 0;
    let storedFiles = 0;
    let storedChunks = 0;
    let lastLog = Date.now();

    const pending: PendingFile[] = [];
    let buffer: { file: PendingFile; index: number; text: string }[] = [];

    const recordEmpty = (entry: WalkEntry): void => {
      // Remember the fingerprint even when a file contributes no chunks, so
      // refresh() does not re-read binary/minified files on every search.
      this.store.replaceFile(this.id, {
        relativePath: entry.relativePath, absolutePath: entry.absolutePath,
        size: entry.size, mtimeMs: entry.mtimeMs, chunks: 0, indexedAt: Date.now(),
      }, [], vectorModel.model, vectorModel.dimensions);
    };

    const storeFile = (file: PendingFile): void => {
      this.store.replaceFile(this.id, {
        relativePath: file.entry.relativePath, absolutePath: file.entry.absolutePath,
        size: file.entry.size, mtimeMs: file.entry.mtimeMs,
        chunks: file.records.length, indexedAt: Date.now(),
      }, file.records, vectorModel.model, vectorModel.dimensions);
      storedFiles++;
      storedChunks += file.records.length;
    };

    /** Persist every file whose chunks have all come back from the embedder. */
    const drainCompleted = (): void => {
      for (let index = pending.length - 1; index >= 0; index--) {
        const file = pending[index];
        if (file.missing === 0 && file.records.length === file.chunks.length) {
          pending.splice(index, 1);
          storeFile(file);
        }
      }
    };

    const flush = async (count = buffer.length): Promise<void> => {
      if (!count) return;
      const items = buffer.splice(0, count);
      if (!items.length) return;
      signal?.throwIfAborted();
      const vectors = await embedder.embed({ texts: items.map((item) => item.text), kind: "document", signal });
      if (embedder.vectorModel !== vectorModel.model) {
        throw new Error(`Embedding provider changed mid-${phase} (${vectorModel.model} -> ${embedder.vectorModel}); refusing to mix vector spaces.`);
      }
      for (const [position, item] of items.entries()) {
        const vector = vectors[position];
        if (!vector) throw new Error("Embedding provider returned fewer vectors than inputs.");
        if (vector.length !== vectorModel.dimensions) {
          throw new Error(`Embedding dimension changed mid-${phase} (${vectorModel.dimensions} -> ${vector.length}).`);
        }
        item.file.records.push({ chunk: item.file.chunks[item.index], vector });
        item.file.missing--;
      }
      drainCompleted();
    };

    for (const entry of entries) {
      signal?.throwIfAborted();
      done++;
      let content: string;
      try {
        content = await readTextFile(entry.absolutePath, this.config.maxFileBytes);
      } catch {
        this.skipped++;
        recordEmpty(entry);
        continue;
      }
      const minified = looksMinified(content);
      if (minified) this.skipped++;
      const chunks = minified
        ? []
        : chunkFile(entry.relativePath, entry.absolutePath, content, {
          workspaceId: this.id, maxTokens: this.config.maxChunkTokens,
        });
      if (!chunks.length) { recordEmpty(entry); continue; }

      const file: PendingFile = { entry, chunks, records: [], missing: chunks.length };
      pending.push(file);
      // The path is part of the embedded text, so "where is agentSocket.ts" can
      // match on the file name and not only on its contents.
      for (const [index, chunk] of chunks.entries()) buffer.push({ file, index, text: `${chunk.relativePath}\n${chunk.content}` });
      while (buffer.length >= this.config.batchSize) await flush(this.config.batchSize);

      if (done % PROGRESS_EVERY_FILES === 0 || Date.now() - lastLog > PROGRESS_EVERY_MS) {
        lastLog = Date.now();
        console.info(`[index] ${label}: ${done}/${total} files, ${storedChunks} chunks stored`);
      }
    }
    await flush();
    for (const file of pending.splice(0)) if (file.missing === 0) storeFile(file);
    return { files: storedFiles, chunks: storedChunks };
  }
}
