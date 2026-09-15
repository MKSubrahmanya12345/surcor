/**
 * Model layer — Claude Fable 5.1 direct client (Anthropic Messages API).
 *
 * Used ONLY when `ANTHROPIC_API_KEY` is set and the routed model id is a
 * Fable id; otherwise Fable ids go through Bedrock Converse (Claude on
 * Bedrock is the same model family without the direct-only knobs).
 *
 * Implemented per the Fable 5.1 platform docs:
 *   - adaptive thinking is always on: we OMIT the `thinking` param entirely
 *     (sending `disabled` or `budget_tokens` is a 400);
 *   - depth via `output_config.effort` (`low…max`, default `high`);
 *   - per-message effort is supported by just sending a different effort on
 *     the next turn (the cache survives — `effortForTurn` documents that);
 *   - `max_tokens` covers thinking + response COMBINED, so high-effort calls
 *     get generous headroom (floor 8 K, raised automatically with effort).
 */

import { createLogger } from '@/lib/logging/logger';

import { compareEffort } from './detect';
import type { EffortLevel, ModelCallUsage } from './types';

const logger = createLogger('models:fable');

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export interface FableRequest {
  model: string;
  system: string[];
  userText: string;
  maxTokens?: number;
  effort?: EffortLevel;
  timeoutMs?: number;
}

export interface FableResponse {
  text: string;
  usage: ModelCallUsage;
  stopReason?: string;
}

/** Headroom floor per effort (thinking + response share the budget). */
export function headroomFor(effort: EffortLevel, requested: number): number {
  const floor = compareEffort(effort, 'high') >= 0 ? 16_000 : 8_000;
  return Math.max(requested, floor);
}

/**
 * Per-message effort: call the next turn with a different effort and the
 * SAME prefix — the prompt cache survives (beta behaviour, documented by
 * Anthropic). This helper just names the pattern so call sites read aloud.
 */
export function effortForTurn(next: EffortLevel): EffortLevel {
  return next;
}

function apiKey(): string | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export function fableDirectAvailable(): boolean {
  return apiKey() !== null;
}

export async function callFable(request: FableRequest): Promise<FableResponse> {
  const key = apiKey();
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set — Fable direct calls are unavailable (use Bedrock transport).');

  const effort = request.effort ?? 'high';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 120_000);
  try {
    const response = await fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: headroomFor(effort, request.maxTokens ?? 8000),
        output_config: { effort },
        system: request.system.map((text) => ({ type: 'text' as const, text })),
        messages: [{ role: 'user', content: [{ type: 'text', text: request.userText }] }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Anthropic Messages API returned HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    const payload = (await response.json()) as {
      content?: { type?: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
    };
    const text = (payload.content ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('')
      .trim();
    if (!text) throw new Error('Fable returned an empty completion.');
    logger.info('fable direct call ok', { model: request.model, effort, characters: text.length });
    return {
      text,
      usage: {
        ...(payload.usage?.input_tokens !== undefined ? { inputTokens: payload.usage.input_tokens } : {}),
        ...(payload.usage?.output_tokens !== undefined ? { outputTokens: payload.usage.output_tokens } : {}),
      },
      ...(payload.stop_reason ? { stopReason: payload.stop_reason } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
