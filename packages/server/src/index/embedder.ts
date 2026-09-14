import type { EmbeddingProvider, EmbeddingRequest, IndexConfig } from "@forge/shared";
import { linkAbortSignal } from "../providers/http";

/**
 * Embedding providers for the codebase index.
 *
 * Same shape as the Prompt 3 chat providers, different job: turn text into
 * vectors. Ollama is the default so indexing works offline with zero API cost;
 * OpenAI is the fallback when Ollama is not running. No SDKs — plain fetch.
 */

const MAX_VECTOR_DECIMALS = 6;

export class EmbeddingError extends Error {}

/** Round before serialising: cosine similarity does not need float64 precision
 *  and this keeps the SQLite `embeddings` table ~2.5x smaller. */
export function roundVector(vector: number[]): number[] {
  return vector.map((value) => Number(value.toFixed(MAX_VECTOR_DECIMALS)));
}

function validate(vectors: number[][], expected: number, label: string): number[][] {
  if (vectors.length !== expected) {
    throw new EmbeddingError(`${label} returned ${vectors.length} embeddings for ${expected} inputs.`);
  }
  let dimensions = 0;
  for (const vector of vectors) {
    if (!Array.isArray(vector) || !vector.length) throw new EmbeddingError(`${label} returned an empty embedding.`);
    if (vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new EmbeddingError(`${label} returned a non-numeric embedding.`);
    }
    if (!dimensions) dimensions = vector.length;
    else if (vector.length !== dimensions) throw new EmbeddingError(`${label} returned mixed embedding dimensions.`);
  }
  return vectors.map(roundVector);
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, signal: AbortSignal, label: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body), signal, redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new EmbeddingError(`${label} returned HTTP ${response.status}.`);
  }
  const parsed: unknown = await response.json();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EmbeddingError(`${label} returned an invalid response.`);
  }
  return parsed as Record<string, unknown>;
}

export interface OllamaEmbedderOptions {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

/**
 * nomic/bge/e5/gte style models are trained with task prefixes; sending them
 * measurably improves retrieval, and omitting them is a common cause of
 * "semantic search returns nonsense".
 */
export function taskPrefix(model: string, kind: EmbeddingRequest["kind"]): string {
  if (!/nomic|bge|^e5|gte|minilm|all-minilm/i.test(model)) return "";
  return kind === "query" ? "search_query: " : "search_document: ";
}

export class OllamaEmbedder implements EmbeddingProvider {
  readonly name = "ollama" as const;
  readonly model: string;
  /** Older Ollama builds only expose /api/embeddings (one prompt at a time). */
  private legacy = false;

  constructor(private readonly options: OllamaEmbedderOptions) {
    this.model = options.model;
  }

  private get baseUrl(): string { return this.options.baseUrl.replace(/\/$/, ""); }

  async embed(request: EmbeddingRequest): Promise<number[][]> {
    if (!request.texts.length) return [];
    const prefix = taskPrefix(this.model, request.kind);
    const inputs = request.texts.map((text) => `${prefix}${text}`.slice(0, 32_000));
    const linked = linkAbortSignal(request.signal, this.options.timeoutMs, "Ollama embeddings");
    try {
      if (!this.legacy) {
        try {
          const payload = await postJson(`${this.baseUrl}/api/embed`, { model: this.model, input: inputs }, {}, linked.signal, "Ollama /api/embed");
          if (payload.error) throw new EmbeddingError(`Ollama /api/embed failed: ${String(payload.error).slice(0, 200)}`);
          const vectors = payload.embeddings;
          if (!Array.isArray(vectors)) throw new EmbeddingError("Ollama /api/embed returned no embeddings array.");
          return validate(vectors as number[][], inputs.length, "Ollama");
        } catch (error) {
          // 404 => pre-0.5 Ollama without the batch endpoint. Retry the legacy
          // route once, then remember the choice for the rest of the run.
          const message = error instanceof Error ? error.message : "";
          if (!message.includes("HTTP 404")) throw error;
          this.legacy = true;
        }
      }
      const vectors: number[][] = [];
      for (const input of inputs) {
        linked.signal.throwIfAborted();
        const payload = await postJson(`${this.baseUrl}/api/embeddings`, { model: this.model, prompt: input }, {}, linked.signal, "Ollama /api/embeddings");
        if (payload.error) throw new EmbeddingError(`Ollama /api/embeddings failed: ${String(payload.error).slice(0, 200)}`);
        const vector = payload.embedding;
        if (!Array.isArray(vector)) throw new EmbeddingError("Ollama /api/embeddings returned no embedding.");
        vectors.push(vector as number[]);
      }
      return validate(vectors, inputs.length, "Ollama");
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      throw new EmbeddingError(`Could not reach Ollama at ${this.baseUrl} (is it running, and is "${this.model}" pulled?).`);
    } finally {
      linked.dispose();
    }
  }
}

export interface OpenAIEmbedderOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}

export class OpenAIEmbedder implements EmbeddingProvider {
  readonly name = "openai" as const;
  readonly model: string;

  constructor(private readonly options: OpenAIEmbedderOptions) {
    this.model = options.model;
  }

  async embed(request: EmbeddingRequest): Promise<number[][]> {
    if (!request.texts.length) return [];
    const inputs = request.texts.map((text) => text.slice(0, 32_000));
    const linked = linkAbortSignal(request.signal, this.options.timeoutMs, "OpenAI embeddings");
    try {
      const payload = await postJson(
        `${this.options.baseUrl.replace(/\/$/, "")}/embeddings`,
        { model: this.model, input: inputs },
        { authorization: `Bearer ${this.options.apiKey}` },
        linked.signal,
        "OpenAI embeddings",
      );
      const data = payload.data;
      if (!Array.isArray(data)) throw new EmbeddingError("OpenAI embeddings returned no data array.");
      const ordered = (data as { index?: number; embedding?: number[] }[])
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((item) => item.embedding ?? []);
      return validate(ordered, inputs.length, "OpenAI");
    } catch (error) {
      if (error instanceof EmbeddingError) throw error;
      throw new EmbeddingError(`OpenAI embeddings request failed (${error instanceof Error ? error.message : "unknown error"}).`);
    } finally {
      linked.dispose();
    }
  }
}

/**
 * Tries embedding providers in configured order and uses the first that works,
 * exactly like the Prompt 3 chat router — an offline machine falls through
 * Ollama to OpenAI, and a machine with no OpenAI key uses Ollama only.
 */
export class FallbackEmbedder implements EmbeddingProvider {
  name: "ollama" | "openai";
  /** Mutated when a provider takes over; identifies the stored vectors. */
  model: string;

  constructor(private readonly providers: EmbeddingProvider[]) {
    if (!providers.length) throw new EmbeddingError("No embedding providers configured.");
    this.name = providers[0].name;
    this.model = `${providers[0].name}:${providers[0].model}`;
  }

  /** Identifies the stored vectors; changing model or provider invalidates them. */
  get vectorModel(): string { return this.model; }

  /**
   * Resolve which provider is actually usable before a build starts, and
   * discover the vector dimension. One throwaway request beats embedding ten
   * thousand chunks against a provider that is not there.
   */
  async probe(signal?: AbortSignal): Promise<{ model: string; dimensions: number }> {
    const [vector] = await this.embed({ texts: ["forge index probe"], kind: "query", ...(signal ? { signal } : {}) });
    return { model: this.model, dimensions: vector.length };
  }

  async embed(request: EmbeddingRequest): Promise<number[][]> {
    const failures: string[] = [];
    for (const provider of this.providers) {
      request.signal?.throwIfAborted();
      try {
        const vectors = await provider.embed(request);
        this.name = provider.name;
        this.model = `${provider.name}:${provider.model}`;
        return vectors;
      } catch (error) {
        failures.push(`${provider.name}: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    throw new EmbeddingError(`All embedding providers failed (${failures.join(" | ")}). Start Ollama with the embedding model pulled, or set OPENAI_API_KEY.`);
  }
}

export function createEmbedder(config: IndexConfig): FallbackEmbedder | null {
  const providers: EmbeddingProvider[] = [];
  for (const name of config.embeddingOrder) {
    if (name === "ollama") {
      providers.push(new OllamaEmbedder({
        baseUrl: config.ollama.baseUrl, model: config.ollama.model, timeoutMs: config.requestTimeoutMs,
      }));
    } else if (name === "openai" && config.openai.apiKey) {
      providers.push(new OpenAIEmbedder({
        baseUrl: config.openai.baseUrl, model: config.openai.model,
        apiKey: config.openai.apiKey, timeoutMs: config.requestTimeoutMs,
      }));
    }
  }
  return providers.length ? new FallbackEmbedder(providers) : null;
}
