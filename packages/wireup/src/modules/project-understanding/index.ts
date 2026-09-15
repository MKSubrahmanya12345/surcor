/**
 * Project understanding module.
 *
 * Responsibility: turn a natural-language prompt into a structured project
 * specification. It runs a deterministic pre-analysis first, then normalises
 * the model's requirements slice into the canonical `ProjectRequirements`,
 * merging the deterministic facts back in so nothing gets lost.
 *
 * It deliberately does NOT generate code, wiring or components.
 */

import { z } from 'zod';

import type { ProjectRequirements } from '@/types/project';
import type { AgentEventLog } from '@/lib/logging/events';

import { analyzePrompt, FEATURE_RULES, formatAnalysisForPrompt, type PromptAnalysis } from './heuristics';
import { deriveBehavioralSpec, mergeBehavioralSpecs, normalizeAssertionPayload } from '@/modules/behaviour-evaluator/derive';

const FlexibleStringArray = z
  .array(z.union([z.string(), z.number(), z.boolean()]))
  .transform((values) => values.map((value) => String(value).trim()).filter((value) => value.length > 0))
  .catch([]);

const FlexibleQuantityRecord = z
  .record(z.string(), z.union([z.number(), z.string()]))
  .transform((record) => {
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(record)) {
      const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
      if (Number.isFinite(parsed) && parsed > 0) out[key.trim()] = parsed;
    }
    return out;
  })
  .catch({});

const RequirementsRawSchema = z
  .object({
    goal: z.string().optional().catch(undefined),
    summary: z.string().optional().catch(undefined),
    requirements: FlexibleStringArray.optional(),
    inputs: FlexibleStringArray.optional(),
    outputs: FlexibleStringArray.optional(),
    behaviors: FlexibleStringArray.optional(),
    constraints: FlexibleStringArray.optional(),
    platformRequirements: FlexibleStringArray.optional(),
    communicationRequirements: FlexibleStringArray.optional(),
    powerRequirements: FlexibleStringArray.optional(),
    quantities: FlexibleQuantityRecord.optional(),
    features: FlexibleStringArray.optional(),
    assumptions: FlexibleStringArray.optional(),
    ambiguities: FlexibleStringArray.optional(),
    detectedPlatform: z.string().optional().catch(undefined),
    behavioralSpec: z.unknown().optional(),
  })
  .passthrough();

export interface UnderstandingResult {
  analysis: PromptAnalysis;
  requirementsDraft: ProjectRequirements;
  promptContext: string;
}

const MAX_ITEMS = 24;

function uniqueStrings(values: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim().replace(/\s+/g, ' ');
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

function mergeQuantities(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    out[key] = Math.max(out[key] ?? 0, value);
  }
  return out;
}

export function deriveGoal(prompt: string): string {
  const cleaned = (prompt ?? '').trim().replace(/\s+/g, ' ');
  const firstSentence = cleaned.split(/(?<=[.!?])\s/)[0] ?? cleaned;
  return firstSentence.length > 220 ? `${firstSentence.slice(0, 217)}...` : firstSentence;
}

/** Deterministic draft built purely from the prompt text. */
export function buildRequirementsDraft(prompt: string, analysis: PromptAnalysis): ProjectRequirements {
  return {
    goal: deriveGoal(prompt),
    summary: analysis.notes.length > 0 ? analysis.notes[0] ?? deriveGoal(prompt) : deriveGoal(prompt),
    requirements: uniqueStrings(analysis.behaviourPhrases),
    inputs: uniqueStrings(
      analysis.features.filter((feature) => /sensor|input|motion|distance|gas|soil|light|imu|temperature/.test(feature)),
    ),
    outputs: uniqueStrings(
      analysis.features.filter((feature) => /motor|servo|stepper|display|lighting|sound|high_current/.test(feature)),
    ),
    behaviors: uniqueStrings(analysis.behaviourPhrases),
    constraints: uniqueStrings(analysis.powerHints),
    platformRequirements: uniqueStrings(
      analysis.platformHints.map((hint) => `${hint.platform} platform requested ("${hint.matched}")`),
    ),
    communicationRequirements: uniqueStrings(analysis.communicationHints),
    powerRequirements: uniqueStrings(analysis.powerHints),
    quantities: { ...analysis.quantities },
    features: uniqueStrings(analysis.features),
    assumptions: [],
    ambiguities: uniqueStrings(analysis.notes),
    ...(analysis.detectedPlatform ? { detectedPlatform: analysis.detectedPlatform } : {}),
    behavioralSpec: deriveBehavioralSpec(prompt, analysis),
  };
}

/** Stage 1 of the pipeline: analyse the prompt (no model call). */
export function understandPrompt(prompt: string, events?: AgentEventLog): UnderstandingResult {
  const handle = events?.start('requirements_started', 'Understanding project requirements...', {
    stage: 'understanding',
    metadata: { promptLength: prompt.length },
  });

  const analysis = analyzePrompt(prompt);
  const requirementsDraft = buildRequirementsDraft(prompt, analysis);
  const promptContext = formatAnalysisForPrompt(analysis);

  handle?.complete(
    `Requirements draft ready — ${analysis.features.length} feature signal(s), platform: ${analysis.detectedPlatform ?? 'not specified'}`,
    {
      features: analysis.features,
      quantities: analysis.quantities,
      detectedPlatform: analysis.detectedPlatform ?? null,
      explicitParts: analysis.explicitParts,
    },
  );

  return { analysis, requirementsDraft, promptContext };
}

/**
 * Merge the model's requirements slice with the deterministic draft.
 * Deterministic findings are never dropped; the model can only add detail.
 */
export function normalizeRequirements(
  raw: unknown,
  context: { prompt: string; analysis: PromptAnalysis; draft: ProjectRequirements },
): ProjectRequirements {
  const parsed = RequirementsRawSchema.safeParse(raw ?? {});
  const value = parsed.success ? parsed.data : {};

  const merged: ProjectRequirements = {
    goal: uniqueStrings([value.goal, context.draft.goal])[0] ?? deriveGoal(context.prompt),
    summary: uniqueStrings([value.summary, context.draft.summary])[0] ?? deriveGoal(context.prompt),
    requirements: uniqueStrings([...(value.requirements ?? []), ...context.draft.requirements]),
    inputs: uniqueStrings([...(value.inputs ?? []), ...context.draft.inputs]),
    outputs: uniqueStrings([...(value.outputs ?? []), ...context.draft.outputs]),
    behaviors: uniqueStrings([...(value.behaviors ?? []), ...context.draft.behaviors]),
    constraints: uniqueStrings([...(value.constraints ?? []), ...context.draft.constraints]),
    platformRequirements: uniqueStrings([
      ...(value.platformRequirements ?? []),
      ...context.draft.platformRequirements,
    ]),
    communicationRequirements: uniqueStrings([
      ...(value.communicationRequirements ?? []),
      ...context.draft.communicationRequirements,
    ]),
    powerRequirements: uniqueStrings([...(value.powerRequirements ?? []), ...context.draft.powerRequirements]),
    quantities: mergeQuantities(context.draft.quantities, value.quantities ?? {}),
    features: uniqueStrings([...(value.features ?? []), ...context.draft.features]).map((feature) =>
      feature.toLowerCase().replace(/\s+/g, '_'),
    ),
    assumptions: uniqueStrings(value.assumptions ?? []),
    ambiguities: uniqueStrings([...(value.ambiguities ?? []), ...context.draft.ambiguities]),
    detectedPlatform: context.analysis.detectedPlatform ?? value.detectedPlatform ?? context.draft.detectedPlatform,
    behavioralSpec: mergeBehavioralSpecs(
      context.draft.behavioralSpec ?? deriveBehavioralSpec(context.prompt, context.analysis),
      normalizeAssertionPayload(value.behavioralSpec),
    ),
  };

  if (!parsed.success) {
    merged.assumptions = uniqueStrings([
      ...merged.assumptions,
      'Model requirements payload was malformed; the deterministic pre-analysis was used instead.',
    ]);
  }

  return merged;
}

/* ------------------------------------------------------------------------- */
/* Coverage analysis (used by the validator)                                  */
/* ------------------------------------------------------------------------- */

const STOPWORDS = new Set([
  'with','that','this','from','into','should','must','will','have','been','when','while','using','used','the','and','for','are','its','it','of','to','in','on','a','an','be','is','at','by','or','as','no','not','can','my','i','we','you','also','then','than','more','some','any','all','each','per','via','onto','upon','make','makes','show','needs','need',
]);

function significantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

export interface CoverageInput {
  requirements: ProjectRequirements;
  searchCorpus: string;
  /** Below this ratio of matched tokens a requirement counts as uncovered. */
  threshold?: number;
}

export interface CoverageReport {
  covered: string[];
  uncovered: string[];
  details: { requirement: string; matched: number; total: number; ratio: number }[];
}

/** Token-overlap coverage check between stated requirements and the design. */
export function analyzeCoverage(input: CoverageInput): CoverageReport {
  const threshold = input.threshold ?? 0.34;
  const corpus = significantTokens(input.searchCorpus).join(' ');
  const covered: string[] = [];
  const uncovered: string[] = [];
  const details: CoverageReport['details'] = [];

  const statements = uniqueStrings([
    ...input.requirements.requirements,
    ...input.requirements.behaviors,
    ...input.requirements.outputs,
    ...input.requirements.communicationRequirements,
  ]);

  /*
   * A requirement token also counts as covered when the design matches the
   * feature pattern that produced it: the word "sound" never appears in a bill
   * of materials, but a buzzer does — and both halves of this heuristic share
   * the FEATURE_RULES lexicon, so they should agree.
   */
  const featureEvidence = new Map(FEATURE_RULES.map((rule) => [rule.feature.toLowerCase(), rule.pattern]));
  const tokenCovered = (token: string): boolean => {
    if (corpus.includes(token)) return true;
    const pattern = featureEvidence.get(token);
    return pattern !== undefined && pattern.test(input.searchCorpus);
  };

  for (const statement of statements) {
    const tokens = significantTokens(statement);
    if (tokens.length === 0) continue;
    const matched = tokens.filter(tokenCovered).length;
    const ratio = matched / tokens.length;
    details.push({ requirement: statement, matched, total: tokens.length, ratio });
    if (ratio >= threshold) covered.push(statement);
    else uncovered.push(statement);
  }

  return { covered, uncovered, details };
}
