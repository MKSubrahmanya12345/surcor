/**
 * Model layer — shared request/response shapes.
 *
 * Bedrock stays the default transport (both new families are reachable
 * through it by model id). These types describe the *routed* call: the
 * router picks Bedrock Converse vs the direct Responses/Messages clients
 * and normalises the result back into one shape the operations layer
 * already understands.
 */

/** Reasoning depth. Shared vocabulary across Astra + Fable (both min `low`). */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ModelFamily = 'astra' | 'fable' | 'gemini' | 'generic' | 'none';

export type ModelTransport = 'bedrock' | 'openai' | 'anthropic' | 'gemini';

export interface ModelCallUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface RoutedCallOptions {
  op: string;
  /** Fully qualified model id (Bedrock id, `gpt-6-astra`, `claude-fable-5-1`…). */
  model: string;
  system: string[];
  userText: string;
  maxTokens?: number;
  /** Astra/Fable reasoning depth. Generic models ignore it. */
  effort?: EffortLevel;
  /** Generic-model sampling (STRIPPED for Astra/Fable — both reject it). */
  temperature?: number;
  topP?: number;
  timeoutMs?: number;
}

export interface RoutedCallResult {
  text: string;
  usage: ModelCallUsage;
  model: string;
  transport: ModelTransport;
  family: ModelFamily;
  effort: EffortLevel | null;
  stopReason?: string;
  attempts: number;
  durationMs: number;
}

export class ModelRouteError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly model: string;

  constructor(message: string, options: { code?: string; retryable?: boolean; model?: string } = {}) {
    super(message);
    this.name = 'ModelRouteError';
    this.code = options.code ?? 'model_route_error';
    this.retryable = options.retryable ?? false;
    this.model = options.model ?? 'unknown';
  }
}
