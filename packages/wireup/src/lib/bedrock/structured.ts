/**
 * Structured (JSON) Bedrock calls.
 *
 * Wraps `converse()` with strict JSON extraction, repair, and one automatic
 * "your output was not valid JSON" retry before giving up. Nothing here knows
 * about hardware — modules own their own schemas.
 */

import { BedrockError, resolveModel, type BedrockOp, type TokenUsage } from '@/lib/bedrock/client';
import { createLogger } from '@/lib/logging/logger';
import { converseRouted, ModelRouteError, type EffortLevel } from '@/lib/models';
import { env } from '@/lib/validation/env';
import { parseJsonLoose, truncate } from '@/lib/validation/json';

const logger = createLogger('bedrock:structured');

/**
 * Bedrock reports a completion cut short by the output budget as
 * `stopReason: "max_tokens"`. The text that comes back is a valid *prefix* of
 * the answer, so it can never parse: the JSON simply has no ending. Retrying
 * the identical request with the identical budget reproduces it exactly.
 *
 * Treated as its own failure mode: the budget is raised for the next round
 * (up to `BEDROCK_MAX_TOKENS_CEILING`) and the retry prompt says the response
 * was cut off rather than malformed.
 */
const TRUNCATION_STOP_REASONS = new Set(['max_tokens', 'max_token', 'length']);

function wasTruncated(stopReason: string | undefined): boolean {
  return stopReason !== undefined && TRUNCATION_STOP_REASONS.has(stopReason.toLowerCase());
}

export interface StructuredCallOptions {
  op: BedrockOp;
  /** System prompt blocks (persona + JSON contract). */
  system: string[];
  /** User turn content. */
  user: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Astra/Fable reasoning depth (generic models ignore it; the router strips sampling params for the new families). */
  effort?: EffortLevel;
  timeoutMs?: number;
  /** How many extra calls to make when the payload cannot be parsed. */
  parseRetries?: number;
}

export interface StructuredCallResult {
  ok: boolean;
  payload?: unknown;
  raw: string;
  error?: string;
  /** Machine-readable failure class (e.g. `EAI_AGAIN`) when Bedrock errored. */
  code?: string;
  /** True when JSON repair was needed to recover the payload. */
  repaired: boolean;
  model: string;
  durationMs: number;
  usage: TokenUsage;
  /** Total Bedrock round trips (including parse retries). */
  attempts: number;
  stopReason?: string;
}

function mergeUsage(total: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    inputTokens: (total.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (total.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens: (total.totalTokens ?? 0) + (next.totalTokens ?? 0),
  };
}

export async function runStructuredCall(options: StructuredCallOptions): Promise<StructuredCallResult> {
  // Two extra rounds by default: one to recover from malformed JSON, one more
  // so a budget raised after a truncated response is actually spent.
  const parseRetries = options.parseRetries ?? 2;
  const startedAt = Date.now();

  let usage: TokenUsage = {};
  let attempts = 0;
  let model = options.model ?? 'unknown';
  let lastRaw = '';
  let lastError = 'Unknown parse failure.';
  let stopReason: string | undefined;
  let repairedOverall = false;
  let truncatedRound = false;

  const config = env().bedrock;
  const ceiling = Math.max(config.maxTokens, config.maxTokensCeiling);
  let budget = options.maxTokens ?? config.maxTokens;

  for (let round = 0; round <= parseRetries; round += 1) {
    const userText =
      round === 0
        ? options.user
        : truncatedRound
        ? `${options.user}

---
YOUR PREVIOUS RESPONSE WAS CUT OFF because it exceeded the output token budget.
It was not malformed - it simply had no ending, so it could not be parsed.

You now have a larger budget (${budget} tokens). Return the COMPLETE JSON object,
and keep it compact: no markdown fences, no commentary, minimal whitespace, and
no prose inside string fields beyond what the schema requires.`
        : `${options.user}

---
YOUR PREVIOUS RESPONSE COULD NOT BE PARSED AS JSON.

Parser error: ${lastError}

Previous response (truncated):
${truncate(lastRaw, 2500)}

Respond again with the COMPLETE corrected JSON object only. No markdown fences, no commentary, no trailing text.`;

    try {
      // Resolved here (not in the router) so a missing model id fails with
      // the same `missing_model_configuration` the Bedrock path always had.
      const modelName = options.model ?? resolveModel(options.op);
      const call = await converseRouted({
        op: options.op,
        model: modelName,
        system: options.system,
        userText,
        maxTokens: budget,
        ...(options.effort ? { effort: options.effort } : {}),
        temperature: options.temperature,
        timeoutMs: options.timeoutMs,
      });

      attempts += call.attempts;
      usage = mergeUsage(usage, call.usage);
      model = call.model;
      lastRaw = call.text;
      stopReason = call.stopReason;

      const parsed = parseJsonLoose(call.text);
      if (parsed.ok) {
        logger.info('structured call ok', {
          op: options.op,
          model,
          rounds: round + 1,
          repaired: parsed.repaired,
          strategy: parsed.strategy,
          characters: call.text.length,
        });
        return {
          ok: true,
          payload: parsed.value,
          raw: call.text,
          repaired: parsed.repaired,
          model,
          durationMs: Date.now() - startedAt,
          usage,
          attempts,
          stopReason,
        };
      }

      truncatedRound = wasTruncated(call.stopReason);
      if (truncatedRound) {
        const previous = budget;
        budget = Math.min(ceiling, Math.max(budget * 2, budget + 1024));
        lastError =
          `The response was cut off at the ${previous}-token output budget ` +
          `(stopReason "${call.stopReason}"), so the JSON has no ending.`;
        logger.warn('structured call hit the output token budget', {
          op: options.op,
          model,
          round: round + 1,
          stopReason: call.stopReason,
          characters: call.text.length,
          outputTokens: call.usage.outputTokens,
          previousBudget: previous,
          nextBudget: budget,
          raisedBudget: budget > previous,
        });
        if (budget === previous) {
          // Already at the ceiling: another identical round would waste a call.
          lastError =
            `The response was cut off at the ${previous}-token output budget (stopReason "${call.stopReason}") ` +
            `and BEDROCK_MAX_TOKENS_CEILING (${ceiling}) leaves no room to retry. ` +
            'Raise BEDROCK_MAX_TOKENS_CEILING for this model, or reduce the size of the request.';
          break;
        }
      } else {
        lastError = parsed.error ?? 'Unable to parse JSON.';
        logger.warn('structured call produced unparseable JSON', {
          op: options.op,
          model,
          round: round + 1,
          stopReason: call.stopReason,
          characters: call.text.length,
          error: lastError,
        });
      }
    } catch (error) {
      // Transport / model level failure: not retryable here (client already retried).
      const message = error instanceof Error ? error.message : String(error);
      // The router resolved the model even though the call failed — report it
      // instead of the pre-call 'unknown' placeholder.
      const routed = error instanceof BedrockError || error instanceof ModelRouteError ? error : null;
      if (routed && routed.model && routed.model !== 'unknown') {
        model = routed.model;
      }
      const code = routed ? routed.code : undefined;
      if (error instanceof BedrockError && error.attempts > 0) {
        attempts = error.attempts;
      }
      logger.error('structured call failed', {
        op: options.op,
        model,
        ...(code ? { code } : {}),
        attempts,
        error: message,
      });
      return {
        ok: false,
        raw: lastRaw,
        error: message,
        ...(code ? { code } : {}),
        repaired: false,
        model,
        durationMs: Date.now() - startedAt,
        usage,
        attempts,
        stopReason,
      };
    }
  }

  return {
    ok: false,
    raw: lastRaw,
    error: `Model output could not be parsed as JSON after ${attempts} Bedrock call(s). ${lastError}`,
    ...(stopReason ? { code: wasTruncated(stopReason) ? 'output_truncated' : 'unparseable_output' } : {}),
    repaired: repairedOverall,
    model,
    durationMs: Date.now() - startedAt,
    usage,
    attempts,
    stopReason,
  };
}
