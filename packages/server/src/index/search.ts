import type { SearchResult, StoredEmbedding } from "@forge/shared";
import type { FallbackEmbedder } from "./embedder";
import type { IndexStore } from "./store";

/**
 * Cosine-similarity search over the workspace index.
 *
 * v1 does exactly what the scale allows: every vector for the workspace is held
 * in memory (as Float32Array, normalised once at load) and scanned linearly.
 * For the target size — repos under roughly 50k lines, a few thousand chunks —
 * that is single-digit milliseconds and needs no native vector-index dependency.
 */

export interface SearchOptions {
  topK?: number;
  /** Workspace-relative subtree filter, e.g. "packages/server". */
  pathPrefix?: string;
  minScore?: number;
  snippetChars?: number;
  signal?: AbortSignal;
}

const DEFAULT_TOP_K = 6;
const DEFAULT_SNIPPET_CHARS = 1_200;
const DEFAULT_MIN_SCORE = 0.05;

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Unit-length copy, so the hot loop is a plain dot product. */
export function normalizeVector(values: ArrayLike<number>): Float32Array {
  const vector = new Float32Array(values.length);
  let norm = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    vector[index] = value;
    norm += value * value;
  }
  const scale = norm > 0 ? 1 / Math.sqrt(norm) : 0;
  if (scale !== 1) for (let index = 0; index < vector.length; index++) vector[index] *= scale;
  return vector;
}

export function dotProduct(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let index = 0; index < a.length; index++) dot += a[index] * b[index];
  return dot;
}

interface CachedChunk {
  relativePath: string;
  absolutePath: string;
  startLine: number;
  endLine: number;
  language: string;
  snippet: string;
  vector: Float32Array;
}

/** Trim a chunk to whole lines within a character budget. */
export function makeSnippet(content: string, limit: number): string {
  const text = content.trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastNewline = cut.lastIndexOf("\n");
  return `${lastNewline > limit * 0.4 ? cut.slice(0, lastNewline) : cut}\n…`;
}

export function normalizePrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  let value = prefix.trim().replaceAll("\\", "/");
  while (value.startsWith("./")) value = value.slice(2);
  while (value.startsWith("/")) value = value.slice(1);
  while (value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

export class CodebaseSearch {
  private cache: { model: string; chunks: CachedChunk[] } | null = null;

  constructor(
    readonly root: string,
    readonly workspaceId: string,
    private readonly store: IndexStore,
    private readonly embedder: FallbackEmbedder | null,
  ) {}

  /** Drop the in-memory vectors; called after every index write. */
  invalidate(): void { this.cache = null; }

  get loadedChunks(): number { return this.cache?.chunks.length ?? 0; }

  private load(model: string, snippetChars: number): CachedChunk[] {
    if (this.cache && this.cache.model === model) return this.cache.chunks;
    const rows: StoredEmbedding[] = this.store.loadEmbeddings(this.workspaceId);
    const chunks: CachedChunk[] = [];
    for (const row of rows) {
      if (row.model !== model || row.dimensions <= 0) continue;
      let vector: number[];
      try { vector = JSON.parse(row.vectorJson) as number[]; } catch { continue; }
      if (!Array.isArray(vector) || vector.length !== row.dimensions) continue;
      chunks.push({
        relativePath: row.relativePath, absolutePath: row.absolutePath,
        startLine: row.startLine, endLine: row.endLine, language: row.language,
        snippet: makeSnippet(row.content, snippetChars),
        vector: normalizeVector(vector),
      });
    }
    this.cache = { model, chunks };
    return chunks;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const embedder = this.embedder;
    if (!embedder) {
      throw new Error("No embedding provider is available: start Ollama (with the embedding model pulled) or set OPENAI_API_KEY.");
    }
    const topK = options.topK ?? DEFAULT_TOP_K;
    const snippetChars = options.snippetChars ?? DEFAULT_SNIPPET_CHARS;
    const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    const prefix = normalizePrefix(options.pathPrefix);

    const [queryVector] = await embedder.embed({
      texts: [query.slice(0, 8_000)], kind: "query", ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!queryVector?.length) throw new Error("Embedding provider returned no query vector.");
    const normalizedQuery = normalizeVector(queryVector);

    const chunks = this.load(embedder.vectorModel, snippetChars);
    const scored: { chunk: CachedChunk; score: number }[] = [];
    for (const chunk of chunks) {
      if (prefix && chunk.relativePath !== prefix && !chunk.relativePath.startsWith(`${prefix}/`)) continue;
      const score = dotProduct(normalizedQuery, chunk.vector);
      if (score < minScore) continue;
      scored.push({ chunk, score });
    }
    scored.sort((a, b) => b.score - a.score || a.chunk.relativePath.localeCompare(b.chunk.relativePath));
    return scored.slice(0, topK).map(({ chunk, score }) => ({
      score: Number(score.toFixed(4)),
      relativePath: chunk.relativePath,
      absolutePath: chunk.absolutePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      language: chunk.language,
      snippet: chunk.snippet,
    }));
  }
}
