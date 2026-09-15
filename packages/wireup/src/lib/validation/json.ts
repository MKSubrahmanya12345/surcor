/**
 * Safe JSON extraction + repair for model output.
 *
 * Models are instructed to return strict JSON, but they still wrap payloads in
 * prose or markdown fences, emit trailing commas, leave comments in, or forget
 * a closing brace. This module tries hard to recover a value before we surface
 * a failure to the user.
 */

export interface JsonParseResult<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
  /** True when the raw text needed repair before it parsed. */
  repaired: boolean;
  strategy: 'direct' | 'fenced' | 'span' | 'repaired';
  raw: string;
}

const FENCE_RE = /```(?:json|jsonc|javascript|js)?\s*([\s\S]*?)```/gi;

/** Strip markdown fences and leading/trailing prose noise. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const matches = [...trimmed.matchAll(FENCE_RE)];
  if (matches.length > 0) {
    // Prefer the largest fenced block — models sometimes show a small example first.
    let best = '';
    for (const match of matches) {
      const body = match[1] ?? '';
      if (body.length > best.length) best = body;
    }
    if (best.trim().length > 0) return best.trim();
  }
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

/**
 * Locate the outermost JSON value in a blob of text using a bracket scanner
 * that respects strings and escapes.
 */
export function findJsonSpan(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start === -1) return null;
  const opener = text[start] as string;
  const closer = opener === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i] as string;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === opener) depth += 1;
    if (char === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  // Unbalanced: return everything from the opener so the repair pass can close it.
  return text.slice(start);
}

function trimTrailingComma(buffer: string): string {
  let end = buffer.length;
  while (end > 0 && /\s/.test(buffer[end - 1] as string)) end -= 1;
  if (end > 0 && buffer[end - 1] === ',') return buffer.slice(0, end - 1) + buffer.slice(end);
  return buffer;
}

/**
 * Single-pass structural repair:
 *  - removes // and /* *\/ comments outside strings
 *  - escapes raw newlines/tabs inside strings
 *  - drops trailing commas before } or ]
 *  - replaces bare NaN/undefined/Infinity with null
 *  - closes unterminated strings and unbalanced brackets
 */
export function repairJson(input: string): string {
  let out = '';
  let i = 0;
  const stack: string[] = [];
  let inString = false;

  while (i < input.length) {
    const char = input[i] as string;
    const next = input[i + 1];

    if (inString) {
      if (char === '\\') {
        out += char + (next ?? '');
        i += 2;
        continue;
      }
      if (char === '"') {
        inString = false;
        out += char;
        i += 1;
        continue;
      }
      if (char === '\n') {
        out += '\\n';
        i += 1;
        continue;
      }
      if (char === '\r') {
        out += '\\r';
        i += 1;
        continue;
      }
      if (char === '\t') {
        out += '\\t';
        i += 1;
        continue;
      }
      out += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      i += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    if (char === '{' || char === '[') {
      stack.push(char);
      out += char;
      i += 1;
      continue;
    }

    if (char === '}' || char === ']') {
      out = trimTrailingComma(out);
      stack.pop();
      out += char;
      i += 1;
      continue;
    }

    out += char;
    i += 1;
  }

  if (inString) out += '"';

  out = out.replace(/\bNaN\b/g, 'null').replace(/\bundefined\b/g, 'null').replace(/\bInfinity\b/g, 'null');
  out = trimTrailingComma(out);

  while (stack.length > 0) {
    const open = stack.pop();
    out = trimTrailingComma(out);
    out += open === '{' ? '}' : ']';
  }

  return out;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Parse arbitrary model output into JSON, escalating through progressively more
 * aggressive recovery strategies.
 */
export function parseJsonLoose<T = unknown>(input: string): JsonParseResult<T> {
  const raw = input ?? '';

  if (raw.trim().length === 0) {
    return { ok: false, error: 'Model returned an empty response.', repaired: false, strategy: 'direct', raw };
  }

  const candidates: { text: string; strategy: JsonParseResult['strategy']; repaired: boolean }[] = [];

  const fenced = stripCodeFences(raw);
  candidates.push({ text: fenced, strategy: fenced === raw.trim() ? 'direct' : 'fenced', repaired: false });

  const span = findJsonSpan(fenced);
  if (span && span !== fenced) candidates.push({ text: span, strategy: 'span', repaired: false });

  for (const candidate of candidates) {
    const attempt = tryParse(candidate.text);
    if (attempt.ok) {
      return {
        ok: true,
        value: attempt.value as T,
        repaired: candidate.repaired,
        strategy: candidate.strategy,
        raw,
      };
    }
    const repairedText = repairJson(candidate.text);
    const repairedAttempt = tryParse(repairedText);
    if (repairedAttempt.ok) {
      return {
        ok: true,
        value: repairedAttempt.value as T,
        repaired: true,
        strategy: 'repaired',
        raw,
      };
    }
  }

  const finalAttempt = tryParse(repairJson(fenced));
  if (finalAttempt.ok) {
    return { ok: true, value: finalAttempt.value as T, repaired: true, strategy: 'repaired', raw };
  }

  const firstError = tryParse(fenced);
  return {
    ok: false,
    error:
      'Unable to parse model output as JSON' +
      ('ok' in firstError && !firstError.ok ? `: ${firstError.error}` : '') +
      `. Received ${raw.length} characters.`,
    repaired: false,
    strategy: 'repaired',
    raw,
  };
}

/** Pretty print JSON for artifact display; never throws. */
export function stringifyJson(value: unknown, indent = 2): string {
  try {
    return JSON.stringify(value, null, indent);
  } catch {
    return String(value);
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

export function truncate(value: string, max = 4000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… [truncated ${value.length - max} characters]`;
}
