/**
 * Model layer — GPT-6 Astra direct client (OpenAI Responses API).
 *
 * Used when `OPENAI_API_KEY` is set and routing receives a direct Astra model
 * id (`gpt-6-astra…`). Bedrock inference-profile ids may contain the same
 * family name but stay on Bedrock Converse — they are not OpenAI model ids.
 *
 * Implemented primitives (per the Sep 2026 API guidance):
 *   - `reasoning.effort` (min `low`; `none` is rejected — we never send it)
 *   - no `temperature` / `top_p` (removed for Astra tool calling)
 *   - function-tool continuations: `registerAsyncTool` tracks a pending call
 *     by `call_id`; `callAstraToolTurn` returns the result with that original
 *     id on the next Responses turn. Hardware actions are intentionally
 *     serialized by the agent because they mutate one circuit blackboard.
 *   - `configuration_update`: change effort mid-conversation without
 *     rewriting the prefix (the `updateEffort` helper returns the patch the
 *     caller sends over its Responses session; over plain HTTPS each call
 *     just carries the new effort and the same prefix).
 *
 * What is NOT implemented: the WebSocket transport for true mid-token
 * steering. `foldSteerAtBoundary` is the honest seam — steers fold at tool
 * boundaries (Tier-1.5), and the event log says exactly that.
 */

import { createLogger } from '@/lib/logging/logger';

import type { EffortLevel, ModelCallUsage } from './types';

const logger = createLogger('models:astra');

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

export interface AstraRequest {
  model: string;
  system: string[];
  userText: string;
  maxTokens?: number;
  effort?: EffortLevel;
  timeoutMs?: number;
}

export interface AstraResponse {
  text: string;
  usage: ModelCallUsage;
  stopReason?: string;
}

/** One function exposed to an Astra Responses tool turn. */
export interface AstraFunctionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A model-issued function call. Arguments intentionally remain raw until the
 * agent validates them against its local tool schema. */
export interface AstraFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface AstraFunctionOutput {
  callId: string;
  output: string;
}

/** One continuation-capable Responses API turn for a stateful tool agent. */
export interface AstraToolTurnRequest {
  model: string;
  system: string[];
  /** Required for the first turn; may also send bounded repair feedback on a later continuation. */
  userText?: string;
  previousResponseId?: string;
  tools: AstraFunctionTool[];
  toolOutputs?: AstraFunctionOutput[];
  maxTokens?: number;
  effort?: EffortLevel;
  timeoutMs?: number;
}

export interface AstraToolTurn {
  responseId: string;
  text: string;
  toolCalls: AstraFunctionCall[];
  usage: ModelCallUsage;
  stopReason?: string;
}

/* ------------------------------------------------------------------------- */
/* Async tools — the application half                                         */
/* ------------------------------------------------------------------------- */

export interface PendingToolCall {
  callId: string;
  name: string;
  arguments: string;
  issuedAt: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __wireupAstraTools: Map<string, PendingToolCall> | undefined;
}

function pendingTools(): Map<string, PendingToolCall> {
  if (!globalThis.__wireupAstraTools) globalThis.__wireupAstraTools = new Map();
  return globalThis.__wireupAstraTools;
}

/** Track a tool call the model issued while it keeps working elsewhere. */
export function registerAsyncTool(call: PendingToolCall): void {
  pendingTools().set(call.callId, call);
}

/** Resolve a tracked call with its result (matched by the original call id). */
export function attachToolResult(callId: string): PendingToolCall | null {
  const table = pendingTools();
  const found = table.get(callId) ?? null;
  if (found) table.delete(callId);
  return found;
}

export function pendingToolCount(): number {
  return pendingTools().size;
}

/* ------------------------------------------------------------------------- */
/* Effort updates without cache resets                                        */
/* ------------------------------------------------------------------------- */

/**
 * The `configuration_update` patch: same conversation prefix, new effort.
 * Over the WebSocket session this object is sent as-is; over HTTPS the
 * caller just issues the next call with `effort` set to `next`.
 */
export function updateEffort(next: EffortLevel): { type: 'configuration_update'; reasoning: { effort: EffortLevel } } {
  return { type: 'configuration_update', reasoning: { effort: next } };
}

/* ------------------------------------------------------------------------- */
/* The HTTPS call                                                             */
/* ------------------------------------------------------------------------- */

function apiKey(): string | null {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export function astraDirectAvailable(): boolean {
  return apiKey() !== null;
}

export interface AstraResponseItem {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: { type?: string; text?: string }[];
};

export interface AstraResponsesPayload {
  id?: string;
  output?: AstraResponseItem[];
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  incomplete_details?: { reason?: string };
};

function usageFrom(payload: AstraResponsesPayload): ModelCallUsage {
  return {
    ...(payload.usage?.input_tokens !== undefined ? { inputTokens: payload.usage.input_tokens } : {}),
    ...(payload.usage?.output_tokens !== undefined ? { outputTokens: payload.usage.output_tokens } : {}),
    ...(payload.usage?.total_tokens !== undefined ? { totalTokens: payload.usage.total_tokens } : {}),
  };
}

function textFrom(payload: AstraResponsesPayload): string {
  return (
    payload.output_text ??
    (payload.output ?? [])
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('')
  ).trim();
}

/**
 * Parse the stable, provider-neutral subset of a Responses payload used by the
 * hardware agent. Kept pure so protocol changes can be caught without making
 * a network call.
 */
export function parseAstraToolTurn(payload: AstraResponsesPayload): AstraToolTurn {
  const responseId = typeof payload.id === 'string' ? payload.id.trim() : '';
  const toolCalls = (payload.output ?? [])
    .filter((item) => item.type === 'function_call')
    .flatMap((item): AstraFunctionCall[] => {
      const callId = typeof item.call_id === 'string' ? item.call_id.trim() : '';
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!callId || !name) return [];
      return [{ callId, name, arguments: typeof item.arguments === 'string' ? item.arguments : '' }];
    });

  if (!responseId) throw new Error('Astra Responses API returned a tool turn without a response id.');
  return {
    responseId,
    text: textFrom(payload),
    toolCalls,
    usage: usageFrom(payload),
    ...(payload.incomplete_details?.reason ? { stopReason: payload.incomplete_details.reason } : {}),
  };
}

/**
 * Continue an Astra function-calling session.
 *
 * We use `previous_response_id` rather than replaying prior turns, which keeps
 * model-owned reasoning state intact and avoids duplicating tool output in the
 * context window. The Responses API needs stored response state for that
 * continuation, so `store: true` is deliberate and limited to this tool-loop
 * endpoint; ordinary one-shot `callAstra` calls remain `store: false`.
 */
export async function callAstraToolTurn(request: AstraToolTurnRequest): Promise<AstraToolTurn> {
  const key = apiKey();
  if (!key) throw new Error('OPENAI_API_KEY is not set — Astra direct tool calls are unavailable (use Bedrock transport).');
  const hasToolOutputs = (request.toolOutputs?.length ?? 0) > 0;
  const hasUserText = Boolean(request.userText?.trim());
  if (!request.previousResponseId && !hasUserText) {
    throw new Error('An Astra tool session needs userText on its first turn.');
  }
  if (request.previousResponseId && !hasToolOutputs && !hasUserText) {
    throw new Error('An Astra tool continuation needs function_call_output or bounded user feedback.');
  }
  if (hasToolOutputs && hasUserText) {
    throw new Error('An Astra tool continuation accepts either function_call_output or user feedback, not both.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 120_000);
  try {
    const input = hasToolOutputs
      ? (request.toolOutputs ?? []).map((result) => ({
          type: 'function_call_output' as const,
          call_id: result.callId,
          output: result.output,
        }))
      : [{ role: 'user' as const, content: request.userText!.trim() }];
    const response = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: request.model,
        instructions: request.system.join('\n\n'),
        input,
        ...(request.previousResponseId ? { previous_response_id: request.previousResponseId } : {}),
        tools: request.tools.map((tool) => ({
          type: 'function' as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
        tool_choice: 'auto',
        // Blackboard tools mutate shared state, so concurrent model calls
        // would make ordering non-deterministic. One call at a time is a
        // correctness requirement, not a performance trade-off.
        parallel_tool_calls: false,
        reasoning: { effort: request.effort ?? 'medium' },
        max_output_tokens: request.maxTokens ?? 4096,
        store: true,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenAI Responses API returned HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    const turn = parseAstraToolTurn((await response.json()) as AstraResponsesPayload);
    if (!turn.text && turn.toolCalls.length === 0) {
      throw new Error('Astra returned neither an operational status nor a tool call.');
    }
    logger.info('astra tool turn ok', {
      model: request.model,
      responseId: turn.responseId,
      toolCalls: turn.toolCalls.length,
      characters: turn.text.length,
    });
    return turn;
  } finally {
    clearTimeout(timer);
  }
}

export async function callAstra(request: AstraRequest): Promise<AstraResponse> {
  const key = apiKey();
  if (!key) throw new Error('OPENAI_API_KEY is not set — Astra direct calls are unavailable (use Bedrock transport).');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 120_000);
  try {
    const input = [...request.system.map((text) => ({ role: 'system' as const, content: text })), { role: 'user' as const, content: request.userText }];
    const response = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: request.model,
        input,
        reasoning: { effort: request.effort ?? 'medium' },
        max_output_tokens: request.maxTokens ?? 8000,
        store: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenAI Responses API returned HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    const payload = (await response.json()) as AstraResponsesPayload;
    const text = textFrom(payload);
    if (!text) throw new Error('Astra returned an empty completion.');
    logger.info('astra direct call ok', { model: request.model, characters: text.length });
    return {
      text,
      usage: usageFrom(payload),
      ...(payload.incomplete_details?.reason ? { stopReason: payload.incomplete_details.reason } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
