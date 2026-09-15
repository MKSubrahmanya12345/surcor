/**
 * Model layer — Google Gemini direct client (Gemini REST API: generateContent).
 *
 * Used when `GEMINI_API_KEY` is set and routing receives a Gemini model id
 * (e.g. `gemini-2.0-flash-exp`, `gemini-1.5-pro`, `gemini-1.5-flash`). When
 * the key is not set, Gemini model ids fall through to Bedrock (which serves
 * them via Bedrock's own Gemini offering if configured).
 *
 * Implements a one-shot generateContent call with the same shape the other
 * direct providers use, plus plain-text extraction + usage parsing. Safety
 * settings are set to BLOCK_ONLY_HIGH so engineering sketches are not
 * rejected for innocent words.
 */

import { createLogger, describeError } from '@/lib/logging/logger';

import type { ModelCallUsage } from './types';

const logger = createLogger('models:gemini');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface GeminiRequest {
  model: string;
  system: string[];
  userText: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  timeoutMs?: number;
}

export interface GeminiResponse {
  text: string;
  usage: ModelCallUsage;
  stopReason?: string;
}

function apiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export function geminiDirectAvailable(): boolean {
  return apiKey() !== null;
}

/* ------------------------------------------------------------------------- */
/* Response parsing (kept pure so a protocol drift can be caught offline)      */
/* ------------------------------------------------------------------------- */

interface GeminiApiCandidate {
  content?: {
    parts?: Array<{ text?: string }>;
    role?: string;
  };
  finishReason?: string;
  safetyRatings?: unknown[];
}

interface GeminiApiPayload {
  candidates?: GeminiApiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  promptFeedback?: unknown;
  error?: { code?: number; message?: string; status?: string };
}

function textFrom(payload: GeminiApiPayload): string {
  const candidate = payload.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  return parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

function usageFrom(payload: GeminiApiPayload): ModelCallUsage {
  const meta = payload.usageMetadata;
  return {
    ...(meta?.promptTokenCount !== undefined ? { inputTokens: meta.promptTokenCount } : {}),
    ...(meta?.candidatesTokenCount !== undefined ? { outputTokens: meta.candidatesTokenCount } : {}),
    ...(meta?.totalTokenCount !== undefined ? { totalTokens: meta.totalTokenCount } : {}),
  };
}

function stopReasonFrom(payload: GeminiApiPayload): string | undefined {
  const reason = payload.candidates?.[0]?.finishReason;
  if (!reason || reason === 'STOP') return undefined;
  return reason;
}

/** Map Gemini's finish reasons onto the shared vocabulary the rest of Wireup uses. */
function isTruncation(reason: string | undefined): boolean {
  return reason === 'MAX_TOKENS';
}

/* ------------------------------------------------------------------------- */
/* The HTTPS call                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Normalise a user-supplied model id for the Gemini URL path.
 *
 * Gemini REST expects model names like `gemini-2.0-flash-exp` or
 * `models/gemini-2.0-flash-exp`. We strip any leading `models/` prefix the
 * user may have pasted, so both forms work.
 */
function modelPath(model: string): string {
  const cleaned = model.trim().replace(/^models\//, '');
  return encodeURIComponent(cleaned);
}

export async function callGemini(request: GeminiRequest): Promise<GeminiResponse> {
  const key = apiKey();
  if (!key) {
    throw new Error('GEMINI_API_KEY is not set — Gemini direct calls are unavailable (use Bedrock transport).');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 120_000);

  try {
    // Gemini takes a single systemInstruction + contents[]; temperature /
    // topP / maxOutputTokens live in generationConfig.
    const systemInstruction =
      request.system.length > 0
        ? {
            parts: request.system.map((text) => ({ text })),
          }
        : undefined;

    const body: Record<string, unknown> = {
      ...(systemInstruction ? { systemInstruction } : {}),
      contents: [
        {
          role: 'user',
          parts: [{ text: request.userText }],
        },
      ],
      generationConfig: {
        temperature: request.temperature ?? 0.2,
        topP: request.topP ?? 0.9,
        maxOutputTokens: request.maxTokens ?? 8000,
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      ],
    };

    const url = `${GEMINI_BASE}/${modelPath(request.model)}:generateContent?key=${encodeURIComponent(key)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => ({}))) as GeminiApiPayload;

    if (!response.ok) {
      const message = payload.error?.message || `HTTP ${response.status}`;
      throw new Error(`Gemini API returned ${response.status}: ${message.slice(0, 300)}`);
    }

    const text = textFrom(payload);
    if (!text) {
      const reason = stopReasonFrom(payload);
      if (isTruncation(reason)) {
        throw new Error(
          `Gemini response was cut off at the output token budget (finishReason=${reason}). Raise BEDROCK_MAX_TOKENS or shorten the prompt.`,
        );
      }
      if (payload.promptFeedback) {
        throw new Error(`Gemini returned no text (prompt feedback blocked the response: ${JSON.stringify(payload.promptFeedback).slice(0, 200)}).`);
      }
      throw new Error('Gemini returned an empty completion.');
    }

    logger.info('gemini direct call ok', { model: request.model, characters: text.length });

    return {
      text,
      usage: usageFrom(payload),
      ...(isTruncation(stopReasonFrom(payload)) ? { stopReason: 'max_tokens' } : {}),
    };
  } catch (error) {
    const err = error as Error;
    if (err.name === 'AbortError') {
      throw new Error(`Gemini request timed out after ${request.timeoutMs ?? 120_000}ms.`);
    }
    logger.warn('gemini direct call failed', { model: request.model, error: describeError(error).message });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
