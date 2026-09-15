/**
 * Model layer — family detection + effort policy.
 *
 * Detection is by model-id substring so it works identically for Bedrock
 * ids (`…gpt-6-astra…`, `…claude-fable-5…`), direct ids (`gpt-6-astra`,
 * `claude-fable-5-1`) and inference-profile ARNs. Effort defaults follow
 * the vendors' guidance: start at Fable's default (`high`) only for the
 * reviewer; expansion proposes at `medium`; the R2 probe runs at `low`;
 * nothing ever requests `none` (Astra rejects it).
 */

import type { EffortLevel, ModelFamily } from './types';

export function detectModelFamily(modelId: string | undefined | null): ModelFamily {
  if (!modelId || modelId.trim().length === 0) return 'none';
  const haystack = modelId.toLowerCase();
  if (haystack.includes('gpt-6-astra') || haystack.includes('astra')) return 'astra';
  if (haystack.includes('fable')) return 'fable';
  if (haystack.includes('opus-5') || haystack.includes('sonnet-5')) return 'fable'; // Mythos-era Claude shares the effort API
  if (/\bgemini\b/.test(haystack)) return 'gemini';
  return 'generic';
}

export function isAstraModel(modelId: string | undefined | null): boolean {
  return detectModelFamily(modelId) === 'astra';
}

export function isGeminiModel(modelId: string | undefined | null): boolean {
  return detectModelFamily(modelId) === 'gemini';
}

/**
 * A family match is not enough to send an id to the Gemini endpoint. Bedrock
 * inference-profile ids/ARNs may also reference Gemini providers; those stay
 * on Bedrock. A direct Gemini id starts with `gemini-` (with optional
 * `models/` prefix) and contains no ARN-like `:` or `/` separators beyond
 * that.
 */
export function isDirectGeminiModelId(modelId: string | undefined | null): boolean {
  const id = modelId?.trim().toLowerCase().replace(/^models\//, '') ?? '';
  if (!id.startsWith('gemini-')) return false;
  // ARNs / Bedrock profile ids always contain colons or `arn:`; reject them.
  if (id.includes('arn:') || id.includes(':')) return false;
  return true;
}

/**
 * A family match is not enough to send an id to the OpenAI endpoint. Bedrock
 * inference-profile ids also contain `gpt-6-astra`, but are not valid direct
 * Responses model ids. Keep those on Bedrock even when an OpenAI key exists.
 */
export function isDirectAstraModelId(modelId: string | undefined | null): boolean {
  const id = modelId?.trim().toLowerCase() ?? '';
  return /^gpt-6-astra(?:[-.][a-z0-9]+)*$/.test(id);
}

export function isFableModel(modelId: string | undefined | null): boolean {
  return detectModelFamily(modelId) === 'fable';
}

export type EffortOp = 'intake' | 'generation' | 'validation' | 'fix' | 'codegen' | 'idea_expansion' | 'idea_r2' | 'idea_review' | 'assembly';

/**
 * Default effort per operation. Env overrides (`WIREUP_MODEL_EFFORT_*`)
 * win; both families clamp to their own range (Astra/Fable min `low`).
 */
export function defaultEffort(op: EffortOp): EffortLevel {
  switch (op) {
    case 'idea_r2':
      return 'low'; // one cheap boolean probe
    case 'intake':
    case 'idea_expansion':
    case 'assembly':
      return 'medium'; // structured proposals, bounded schema
    case 'generation':
    case 'codegen':
      return 'medium';
    case 'validation':
    case 'fix':
    case 'idea_review':
      return 'high'; // the reviewer earns the ceiling
  }
}

const EFFORT_ORDER: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Clamp an effort override into range (unknown values fall back). */
export function parseEffort(value: string | undefined, fallback: EffortLevel): EffortLevel {
  const normalised = value?.trim().toLowerCase();
  if (normalised === 'low' || normalised === 'medium' || normalised === 'high' || normalised === 'xhigh' || normalised === 'max') return normalised;
  return fallback;
}

export function compareEffort(a: EffortLevel, b: EffortLevel): number {
  return EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b);
}
