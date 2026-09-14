import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import type { AgentServerConfig, IndexConfig, IndexStats, SearchCodebaseArgs, SearchResult } from "@forge/shared";
import { createEmbedder, type FallbackEmbedder } from "./embedder";
import { WorkspaceIndexer } from "./indexer";
import { CodebaseSearch, type SearchOptions } from "./search";
import { IndexStore, workspaceIdFor } from "./store";

/**
 * Process-wide index service.
 *
 * Tools reach the index through this module rather than through
 * `AgentToolContext`, so Prompt 3's shared context type and the agent loop stay
 * untouched: `server.ts` calls `initIndexService()` once at boot and
 * `startIndexing()` when a client sends `init`, and `search_codebase` /
 * `write_file` look the workspace up by root.
 */

export interface WorkspaceIndex {
  root: string;
  id: string;
  indexer: WorkspaceIndexer;
  search: CodebaseSearch;
  /** Initial build kicked off when the workspace was opened, if still running. */
  building: Promise<IndexStats> | null;
  openedAt: number;
}

const MAX_TRACKED_WORKSPACES = 8;

let store: IndexStore | null = null;
let embedder: FallbackEmbedder | null = null;
let config: IndexConfig | null = null;
const indexes = new Map<string, WorkspaceIndex>();

export function initIndexService(sqlite: Database, serverConfig: AgentServerConfig): void {
  config = serverConfig.index;
  store = new IndexStore(sqlite);
  embedder = createEmbedder(config);
  indexes.clear();
  if (!config.enabled) console.info("[index] disabled (INDEX_ENABLED=false).");
  else if (!embedder) console.warn("[index] no embedding provider configured; search_codebase will report how to enable one.");
  else console.info(`[index] embeddings via ${config.embeddingOrder.join(" -> ")} (${config.ollama.model} / ${config.openai.model})`);
}

export function indexServiceConfigured(): boolean {
  return Boolean(store && config?.enabled);
}

function requireServices(): { store: IndexStore; config: IndexConfig } {
  if (!store || !config) {
    throw new Error("The index service was not initialised; the agent server did not finish starting.");
  }
  return { store, config };
}

function evictIfNeeded(): void {
  if (indexes.size <= MAX_TRACKED_WORKSPACES) return;
  const oldest = [...indexes.values()].sort((a, b) => a.openedAt - b.openedAt)[0];
  if (oldest) indexes.delete(oldest.root);
}

function entryFor(root: string): WorkspaceIndex {
  const existing = indexes.get(root);
  if (existing) { existing.openedAt = Date.now(); return existing; }
  const services = requireServices();
  const indexer = new WorkspaceIndexer(root, services.store, embedder, services.config);
  const entry: WorkspaceIndex = {
    root, id: workspaceIdFor(root), indexer,
    search: new CodebaseSearch(root, indexer.id, services.store, embedder),
    building: null, openedAt: Date.now(),
  };
  indexes.set(root, entry);
  evictIfNeeded();
  return entry;
}

/** Current stats for a workspace, without triggering any work. */
export function indexStats(root: string): IndexStats | undefined {
  const entry = indexes.get(root);
  return entry ? entry.indexer.stats : undefined;
}

/**
 * Kick off the background build when a workspace is opened. Fire and forget:
 * progress goes to the server console, and a failure never breaks the session.
 */
export function startIndexing(root: string): void {
  if (!config?.enabled || !store) return;
  const entry = entryFor(root);
  if (entry.building) return;
  const build = entry.indexer.ready();
  entry.building = build;
  build
    .then((stats) => {
      console.info(`[index] ${basename(root)}: ${stats.files} files / ${stats.chunks} chunks available to search_codebase.`);
    })
    .catch((error: unknown) => {
      console.warn(`[index] ${basename(root)}: ${error instanceof Error ? error.message : "index build failed"}`);
    })
    .finally(() => {
      if (entry.building === build) entry.building = null;
      entry.search.invalidate();
    });
}

/** Re-embed one file after the server's write_file tool wrote it. */
export async function reindexFile(root: string, absolutePath: string, signal?: AbortSignal): Promise<void> {
  if (!config?.enabled || !store || !embedder) return;
  const entry = indexes.get(root) ?? entryFor(root);
  try {
    await entry.indexer.indexFile(absolutePath, signal);
    entry.search.invalidate();
  } catch (error) {
    // A stale index is a degraded answer, never a failed write.
    console.warn(`[index] could not re-index ${absolutePath}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

/** Forget a file the server deleted (currently unused; kept for delete tooling). */
export async function forgetFile(root: string, absolutePath: string): Promise<void> {
  const entry = indexes.get(root);
  if (!entry) return;
  await entry.indexer.forgetFile(absolutePath);
  entry.search.invalidate();
}

async function ensureFresh(entry: WorkspaceIndex, signal?: AbortSignal): Promise<void> {
  const building = entry.building;
  if (building) {
    await building.catch(() => undefined);
    entry.building = null;
    entry.search.invalidate();
    if (entry.indexer.stats.status === "ready") return;
  }
  const stats = entry.indexer.stats;
  if (entry.indexer.inFailureCooldown()) {
    if (stats.chunks > 0) return; // serve what a previous build produced
    throw new Error(stats.lastError ?? "The codebase index failed to build and is retrying in the background.");
  }
  try {
    await entry.indexer.ready(signal);
  } finally {
    entry.search.invalidate();
  }
}

export interface CodebaseSearchOutcome {
  results: SearchResult[];
  stats: IndexStats;
}

/** What the `search_codebase` tool calls: refresh if needed, then search. */
export async function searchWorkspace(
  root: string,
  args: SearchCodebaseArgs,
  options: Omit<SearchOptions, "topK" | "pathPrefix" | "signal"> & { signal?: AbortSignal } = {},
): Promise<CodebaseSearchOutcome> {
  if (!config?.enabled) throw new Error("Codebase indexing is disabled (INDEX_ENABLED=false).");
  const entry = entryFor(root);
  await ensureFresh(entry, options.signal);
  const results = await entry.search.search(args.query, {
    topK: args.topK, pathPrefix: args.pathPrefix, signal: options.signal,
    ...(options.minScore !== undefined ? { minScore: options.minScore } : {}),
    ...(options.snippetChars !== undefined ? { snippetChars: options.snippetChars } : {}),
  });
  return { results, stats: entry.indexer.stats };
}
