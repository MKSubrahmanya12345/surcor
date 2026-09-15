/**
 * Everflow — intake (the doubt session).
 *
 * Phase 0 between the prompt and the pipeline. The agent's first job is not
 * to build but to (a) sketch the smallest useful graph and (b) list the
 * doubts that matter, each with a decider:
 *
 *   `human`        — context only the user has (budget, environment, owned
 *                    hardware, who this is for). These get asked.
 *   `ai`           — technical calls the agent makes on its own; recorded as
 *                    decisions, appealable in the graph.
 *   `ai_with_veto` — the agent decides and moves on; a "flag if wrong" banner
 *                    appears on the graph node.
 *
 * Every skipped doubt becomes a recorded ASSUMPTION — a first-class claim
 * node with `human_confirmed` as its goal, so a guess can never silently
 * become a fact.
 *
 * The LLM adds doubts it sees in the prompt; the deterministic layer below
 * always runs, so the session works with no model configured at all.
 */

import type { ProjectDoubt } from '@/types/everflow';
import type { ProjectState } from '@/types/project';

import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import { analyzePrompt } from '@/modules/project-understanding/heuristics';

export interface IntakeDoubtSeed {
  question: string;
  consequence: string;
  decider: ProjectDoubt['decider'];
  blocking: boolean;
  options: string[];
  allowMultiple?: boolean;
  proposedDefault: string | null;
  confidence: number;
}

const YOU_CHOOSE = 'You choose (recommended)';

function makeDoubt(seed: IntakeDoubtSeed, at: string): ProjectDoubt {
  return {
    id: createId('doubt'),
    question: seed.question,
    consequence: seed.consequence,
    decider: seed.decider,
    blocking: seed.blocking,
    options: seed.options,
    ...(seed.allowMultiple ? { allowMultiple: true } : {}),
    proposedDefault: seed.proposedDefault,
    confidence: Math.min(1, Math.max(0, seed.confidence)),
    status: 'open',
    answer: null,
    createdAt: at,
  };
}

/**
 * Resolve a natural-language multi-choice answer against this doubt's actual
 * options. The intake UI historically accepted only one string, so answers
 * such as "both" were persisted literally and downstream had to guess which
 * option the user meant. Keep the original answer field, but also preserve the
 * concrete choices whenever they can be identified unambiguously.
 */
export function selectedOptionsForDoubt(
  doubt: Pick<ProjectDoubt, 'options'>,
  value?: string,
  selectedOptions?: string[],
): string[] {
  const available = doubt.options.filter((option) => option.trim().length > 0);
  const allowed = new Set(available);
  const explicit = (selectedOptions ?? []).filter((option) => allowed.has(option));
  if (explicit.length > 0) return [...new Set(explicit)];

  const text = value?.trim().toLowerCase() ?? '';
  if (!text) return [];

  // "both" is only expanded when there are exactly two concrete options.
  // With three or four options it is ambiguous and must remain human prose.
  const concrete = available.filter((option) => !/^you choose\b|^agent decides\b/i.test(option));
  if (/^(both|both of them|both options)$/i.test(text) && concrete.length === 2) {
    return concrete;
  }

  // Also understand a typed answer that repeats two option labels, e.g.
  // "internal pull-up and external pull-up".
  const matched = concrete.filter((option) => text.includes(option.toLowerCase()));
  return matched.length > 1 ? matched : [];
}

/** Canonical context text for an answer, explicit enough for the planner. */
export function answerValueForDoubt(
  doubt: Pick<ProjectDoubt, 'options'>,
  value?: string,
  selectedOptions?: string[],
): { value: string; selectedOptions?: string[] } {
  const selected = selectedOptionsForDoubt(doubt, value, selectedOptions);
  if (selected.length > 1) {
    return {
      value: `Selected options: ${selected.join(' + ')}`,
      selectedOptions: selected,
    };
  }
  if (selected.length === 1) return { value: selected[0] as string };
  return { value: value?.trim() ?? '' };
}

/**
 * The deterministic doubt list, derived from the same prompt heuristics the
 * pipeline already trusts. Always at most 5 doubts, at most 2 blocking.
 */
export function deriveDeterministicDoubts(prompt: string): ProjectDoubt[] {
  const at = nowIso();
  const analysis = analyzePrompt(prompt);
  const seeds: IntakeDoubtSeed[] = [];

  const platform = analysis.detectedPlatform;
  const platformStrong = (analysis.platformHints[0]?.confidence ?? 0) >= 0.8;
  if (!platformStrong) {
    seeds.push({
      question: platform
        ? `You mentioned ${platform} — is that the controller you want, or should the agent pick the best fit?`
        : 'Which microcontroller should run this?',
      consequence: 'The controller decides every pin map, power rail and library in the build.',
      decider: platform ? 'ai_with_veto' : 'human',
      blocking: !platform,
      options: ['esp32-devkit-v1', 'arduino-uno-r3', 'arduino-nano', YOU_CHOOSE],
      proposedDefault: platform ?? 'You choose (recommended)',
      confidence: platform ? 0.7 : 0.3,
    });
  }

  // The motor-loads hint is derived from the feature, not a power answer from
  // the user — it must not suppress the "what powers it?" doubt.
  const userAnsweredPower = analysis.powerHints.some((hint) => !hint.startsWith('Motor loads present'));
  if (analysis.features.includes('motor_control') && !userAnsweredPower) {
    seeds.push({
      question: 'What will power the build?',
      consequence: 'Motor loads stall well above their running current — the supply choice drives the whole power budget.',
      decider: 'human',
      blocking: false,
      options: ['2S LiPo (≈7.4 V)', '9 V battery', 'Bench supply / USB', YOU_CHOOSE],
      proposedDefault: '2S LiPo (≈7.4 V)',
      confidence: 0.4,
    });
  }

  if (analysis.features.includes('bluetooth') || analysis.features.includes('wifi') || analysis.communicationHints.length > 0) {
    seeds.push({
      question: 'How will you drive the device?',
      consequence: 'Phone app, laptop keyboard and serial console all change the firmware command set and the docs.',
      decider: 'human',
      blocking: false,
      options: ['Phone over Bluetooth/serial', 'Laptop keyboard', 'Web dashboard', YOU_CHOOSE],
      proposedDefault: 'Phone over Bluetooth/serial',
      confidence: 0.35,
    });
  }

  // ---- single-board computer + vision projects (the "software on a box" class) ----
  if (analysis.detectedPlatform === 'raspberry-pi') {
    seeds.push({
      question: 'Which Raspberry Pi — 5, 4 or 3?',
      consequence: 'Camera count and frame rate differ a lot: the Pi 5 runs two CSI cameras and a higher FPS; the Pi 3 is the budget option.',
      decider: 'ai_with_veto',
      blocking: false,
      options: ['Raspberry Pi 5 (recommended)', 'Raspberry Pi 4', 'Raspberry Pi 3'],
      proposedDefault: 'Raspberry Pi 5 (recommended)',
      confidence: 0.65,
    });
  }

  const wantsCamera = analysis.features.includes('camera_vision');
  if (wantsCamera) {
    const multi = /\b(multiple|several|more than one|a pair|2|two|3|three|four|4|five|5)\b/i.test(prompt);
    if (multi && analysis.quantities.cameras === undefined) {
      seeds.push({
        question: 'How many cameras exactly? (the brief says more than one)',
        consequence: 'The Pi 5 takes two CSI cameras; beyond that the design switches to USB webcams and changes the whole I/O plan.',
        decider: 'human',
        blocking: false,
        options: ['2', '3', '4 or more', YOU_CHOOSE],
        proposedDefault: '2',
        confidence: 0.3,
      });
    }
    seeds.push({
      question: 'Which cameras — Pi cameras (CSI ribbon) or USB webcams?',
      consequence: 'CSI cameras need no wiring and more power headroom; USB webcams are easier to add and move but slower and less consistent.',
      decider: 'ai_with_veto',
      blocking: false,
      options: ['Pi Camera Modules (CSI)', 'USB webcams', 'Mix of both'],
      proposedDefault: 'Pi Camera Modules (CSI)',
      confidence: 0.6,
    });
  }

  if (wantsCamera && /\b(security|alarm|surveillance|lock|door|entry|unknown face|unauthorized)\b/i.test(prompt)) {
    seeds.push({
      question: 'What should happen when an UNKNOWN face is detected?',
      consequence: 'This is the security policy itself — alarm, log-only, or blocking — and it drives the whole event system.',
      decider: 'human',
      blocking: false,
      options: ['Raise an alarm + log', 'Log + notify on the website', 'Block/deny and log', YOU_CHOOSE],
      proposedDefault: 'Raise an alarm + log',
      confidence: 0.3,
    });
  }

  if (analysis.features.includes('web_app')) {
    seeds.push({
      question: 'Who may use the website, and from where?',
      consequence: 'Face data is personal data: local-network-only versus publicly reachable changes authentication, storage and what we document.',
      decider: 'human',
      blocking: false,
      options: ['My home network only', 'Password-protected, anywhere', 'Invite-only accounts'],
      proposedDefault: 'My home network only',
      confidence: 0.3,
    });
  }

  return seeds.slice(0, 6).map((seed) => makeDoubt(seed, at));
}

/* ------------------------------------------------------------------------- */
/* LLM merge                                                                  */
/* ------------------------------------------------------------------------- */

export interface IntakeLlmPayload {
  name?: string;
  summary?: string;
  doubts?: IntakeDoubtSeed[];
  claims?: { label: string; content: string }[];
  /** The messy brief, expanded into the global project document. */
  expanded?: {
    goal?: string;
    platform?: string | null;
    components?: { name?: string; quantity?: number; role?: string }[];
    behaviours?: string[];
    assumptions?: string[];
    openQuestions?: string[];
  };
}

function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/\?+$/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function sharesTopic(a: string, b: string): boolean {
  const wordsA = new Set(normalizeQuestion(a).split(' ').filter((word) => word.length > 3));
  const wordsB = normalizeQuestion(b).split(' ').filter((word) => word.length > 3);
  const overlap = wordsB.filter((word) => wordsA.has(word)).length;
  return overlap >= 2 && overlap / Math.max(1, Math.min(wordsA.size, wordsB.length)) > 0.4;
}

/** Merge LLM-proposed doubts into the deterministic set without duplication. */
export function mergeIntakeDoubts(base: ProjectDoubt[], fromLlm: IntakeLlmPayload, at: string): ProjectDoubt[] {
  const merged = [...base];
  for (const seed of fromLlm.doubts ?? []) {
    if (!seed.question || merged.some((existing) => sharesTopic(existing.question, seed.question))) continue;
    const decider = seed.decider === 'ai' || seed.decider === 'ai_with_veto' ? seed.decider : 'human';
    merged.push(
      makeDoubt(
        {
          question: seed.question.trim().slice(0, 300),
          consequence: (seed.consequence ?? 'It shapes the build.').trim().slice(0, 300),
          decider,
          blocking: Boolean(seed.blocking),
          options: (seed.options ?? []).slice(0, 4).map((option) => String(option).slice(0, 80)),
          ...(seed.allowMultiple ? { allowMultiple: true } : {}),
          proposedDefault: seed.proposedDefault ? String(seed.proposedDefault).slice(0, 80) : null,
          confidence: typeof seed.confidence === 'number' ? seed.confidence : 0.5,
        },
        at,
      ),
    );
  }
  // Hard caps: at most 6 doubts reach the session, 3 of them blocking
  // (extra blocking doubts degrade to non-blocking, in order).
  let blockingCount = 0;
  return merged
    .slice(0, 6)
    .map((doubt) => {
      if (doubt.blocking) {
        blockingCount += 1;
        if (blockingCount > 3) return { ...doubt, blocking: false };
      }
      return doubt;
    });
}

/**
 * Render the answers as the context block folded into the prompt the
 * pipeline's understanding stage sees. Skipped doubts are labelled as
 * assumptions, so the model knows they are guesses, not facts.
 */
export function buildIntakeContext(doubts: ProjectDoubt[]): string | null {
  const lines: string[] = [];
  for (const doubt of doubts) {
    if (doubt.status === 'answered' && doubt.answer) {
      const answer = doubt.answer.selectedOptions?.length
        ? `Selected options: ${doubt.answer.selectedOptions.join(' + ')}`
        : doubt.answer.value;
      lines.push(`Q: ${doubt.question}\nA (user): ${answer}`);
    } else if (doubt.status === 'assumed' || doubt.status === 'resolved_ai') {
      const value = doubt.answer?.value ?? doubt.proposedDefault ?? 'agent decides';
      lines.push(`Q: ${doubt.question}\nA (ASSUMPTION — user did not answer): ${value}`);
    }
  }
  if (lines.length === 0) return null;
  return `RESOLVED CONTEXT FROM THE DOUBT SESSION (treat "user" answers as facts and ASSUMPTION lines as guesses the user may later correct):\n${lines.join('\n\n')}`;
}

export interface RunIntakeResult {
  doubts: ProjectDoubt[];
  name: string | null;
  summary: string | null;
}

/** Pure core of the intake run (the LLM payload is injected, so tests need no Bedrock). */
export function composeIntake(state: ProjectState, llm: IntakeLlmPayload | null): RunIntakeResult {
  const doubts = llm ? mergeIntakeDoubts(deriveDeterministicDoubts(state.prompt), llm, nowIso()) : deriveDeterministicDoubts(state.prompt);
  const name =
    llm?.name && llm.name.trim().length >= 3
      ? llm.name.trim().slice(0, 120)
      : (state.prompt.split('\n')[0] ?? 'Wireup project').trim().slice(0, 80);
  return { doubts, name: name || null, summary: llm?.summary ?? null };
}

/* -------------------------------------------------------------------------
 * Brief expansion — the messy prompt becomes the global project document
 * ---------------------------------------------------------------------- */

import type { ExpandedBrief } from '@/types/everflow';

function renderExpandedBrief(expanded: ExpandedBrief['structured']): string {
  const lines: string[] = ['PROJECT BRIEF (expanded by Wireup)'];
  lines.push(`Goal: ${expanded.goal}`);
  lines.push(`Platform: ${expanded.platform ?? 'unknown — see the doubt session'}`);
  if (expanded.components.length > 0) {
    lines.push(`Components: ${expanded.components.map((component) => `${component.name} ×${component.quantity} (${component.role})`).join('; ')}`);
  }
  if (expanded.behaviours.length > 0) lines.push(`Must behave: ${expanded.behaviours.join(' | ')}`);
  if (expanded.assumptions.length > 0) lines.push(`Assumed (until the human says otherwise): ${expanded.assumptions.join('; ')}`);
  if (expanded.openQuestions.length > 0) lines.push(`Still open: ${expanded.openQuestions.join(' | ')}`);
  return lines.join('\n');
}

/**
 * Deterministic fallback expansion — works with no model at all. It renders
 * what the analyzer factually saw and lists what it could NOT resolve, so the
 * "global project document" always exists from the very first poll.
 */
export function deterministicExpansion(state: ProjectState): ExpandedBrief {
  const analysis = analyzePrompt(state.prompt);
  const text = state.prompt.trim();
  const firstSentence = text.split(/(?<=[.!?])\s+|\n/)[0] ?? text;
  const goal = firstSentence.length > 160 ? `${firstSentence.slice(0, 159)}…` : firstSentence;

  const components: ExpandedBrief['structured']['components'] = [];
  if (analysis.detectedPlatformComponentId || analysis.detectedPlatform) {
    components.push({ name: analysis.detectedPlatform ?? 'platform', quantity: 1, role: 'runs the build' });
  }
  for (const part of analysis.explicitParts) {
    components.push({ name: part, quantity: 1, role: 'named in the brief' });
  }
  for (const [key, value] of Object.entries(analysis.quantities)) {
    components.push({ name: key.replace(/_/g, ' '), quantity: value, role: 'counted in the brief' });
  }

  const openQuestions: string[] = [];
  if (!analysis.detectedPlatform) openQuestions.push('which hardware runs this');
  if (analysis.features.includes('camera_vision') && analysis.quantities.cameras === undefined) {
    openQuestions.push('how many cameras');
  }
  openQuestions.push(...analysis.notes.map((note) => note.replace(/^No known feature signals matched — /, '')));

  const structured: ExpandedBrief['structured'] = {
    goal,
    platform: analysis.detectedPlatform ?? null,
    components,
    behaviours: analysis.behaviourPhrases.slice(0, 6),
    assumptions: [],
    openQuestions: [...new Set(openQuestions)].slice(0, 6),
  };

  return { text: renderExpandedBrief(structured), structured, source: 'deterministic', at: nowIso() };
}

/** Fold an LLM expansion payload into the canonical shape. */
export function expandedBriefFromLlm(payload: NonNullable<IntakeLlmPayload['expanded']>, state: ProjectState): ExpandedBrief {
  const base = deterministicExpansion(state);
  const structured: ExpandedBrief['structured'] = {
    goal: (payload.goal ?? '').trim() || base.structured.goal,
    platform: payload.platform ?? base.structured.platform,
    components: (payload.components ?? [])
      .map((component) => ({
        name: String(component.name ?? '').trim(),
        quantity: Number.isFinite(component.quantity as number) ? Math.max(1, Math.floor((component.quantity as number) ?? 1)) : 1,
        role: String(component.role ?? '').trim() || 'from the brief',
      }))
      .filter((component) => component.name.length > 0)
      .slice(0, 12),
    behaviours: (payload.behaviours ?? []).map((behaviour) => String(behaviour).trim()).filter(Boolean).slice(0, 8),
    assumptions: (payload.assumptions ?? []).map((assumption) => String(assumption).trim()).filter(Boolean).slice(0, 8),
    openQuestions: (payload.openQuestions ?? []).map((question) => String(question).trim()).filter(Boolean).slice(0, 6),
  };
  if (structured.components.length === 0) structured.components = base.structured.components;
  if (structured.behaviours.length === 0) structured.behaviours = base.structured.behaviours;
  if (structured.openQuestions.length === 0) structured.openQuestions = base.structured.openQuestions;
  return { text: renderExpandedBrief(structured), structured, source: 'llm', at: nowIso() };
}
