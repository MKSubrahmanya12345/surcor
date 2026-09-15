/**
 * The firmware workbench brain — chat turns and manual editor saves.
 *
 * This module is deliberately persistence-free: it takes a `ProjectState` and
 * returns the NEXT `ProjectState` (with the new chat messages, code artifact
 * and revision) plus the reply for the UI. The API route owns Mongo. That
 * keeps the whole Cursor loop runnable offline in harnesses.
 *
 * Every code-producing path is gated by the same stack as generation:
 *
 *   model plan → rooting gate (pins/includes owned by Wireup) → deterministic
 *   sync passes → host compile gate → diff → revision
 *
 * A rejected or failing change never touches the project's firmware: the user
 * gets the diagnostics and the previous code stays authoritative. Nothing is
 * applied silently.
 */

import type { ChatDiff, ChatMessage, LlmCallRecord, ProjectState } from '@/types/project';
import type { ComponentDefinition } from '@/types/component';
import type { AgentEventLog } from '@/lib/logging/events';

import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import { diffLines, type DiffLine } from '@/lib/diff/lines';

import { assessCodeQuality, braceBalance } from '@/modules/code-generator/quality';
import {
  ensureIncludesBlock,
  ensureLibraryIncludes,
  ensurePinMap,
  syncPinConstants,
} from '@/modules/code-generator';
import { applyFirmwareHygiene } from '@/modules/code-generator/hygiene';
import { buildPinMapBlock } from '@/modules/code-generator/managed-blocks';
import { rootLlmSketch, type LlmSketchPlan, type RootingContext } from '@/modules/code-generator/rooting';
import type { LlmEditTurn } from '@/modules/code-generator/llm';
import { compileFirmware, formatDiagnostic, firmwareCompilerStatus } from '@/modules/firmware-compiler';
import { appendRevision, createRevision } from '@/modules/orchestrator/revisions';

/* ------------------------------------------------------------------------- */
/* Shared shapes                                                              */
/* ------------------------------------------------------------------------- */

/** Provider metadata the chat records with each call. */
export interface FirmwareEditMeta {
  model?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** The workbench provider: a conversational edit turn. */
export type FirmwareEditProvider = (request: {
  projectName: string;
  currentSketch: string;
  grounding: string;
  instruction: string;
  recentMessages: { role: 'user' | 'assistant'; text: string }[];
  diagnostics?: string[];
}) => Promise<{ ok: boolean; turn?: LlmEditTurn; error?: string; code?: string; meta?: FirmwareEditMeta }>;

export interface FirmwareTurnResult {
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  /** The next project state (chat + code + revision already folded in). */
  project: ProjectState;
  /** LLM call records for the project's `llm.calls` log. */
  llmCalls: LlmCallRecord[];
  /** True when the firmware was actually changed. */
  applied: boolean;
}

const MAX_CHAT_MESSAGES = 100;
const MAX_DIFF_LINES = 600;
const MAX_RECENT_MESSAGES = 6;
const MAX_SKETCH_CHARS = 14_000;

/* ------------------------------------------------------------------------- */
/* Grounding                                                                  */
/* ------------------------------------------------------------------------- */

/** The fixed hardware context, in the model's terms — same facts as generation. */
export function buildGrounding(project: ProjectState): string {
  const parts: string[] = [];
  const requirements = project.requirements;

  if (requirements) {
    parts.push('=== FIXED CONTEXT (planners own this — fixed unless the plan changes) ===');
    parts.push(
      [
        requirements.goal ? `Goal: ${requirements.goal}` : '',
        requirements.requirements.length > 0 ? `Requirements: ${requirements.requirements.join(' | ')}` : '',
        requirements.behaviors.length > 0 ? `Behaviours: ${requirements.behaviors.join(' | ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }

  if (project.pinAssignments.length > 0) {
    const controller = project.components.find((selection) => selection.category === 'microcontroller');
    parts.push(`Controller: ${controller?.name ?? 'the selected board'}`);
    parts.push('=== PIN MAP (fixed — reference the PIN_* constants, never declare pins) ===');
    parts.push(buildPinMapBlock(project.pinAssignments));
  }

  const peripherals = project.components.filter((selection) => selection.category !== 'microcontroller');
  if (peripherals.length > 0) {
    parts.push('=== BILL OF MATERIALS (only these peripherals exist) ===');
    for (const selection of peripherals) {
      const instances = selection.instances.map((instance) => instance.instanceId).join(', ');
      parts.push(`- ${selection.name} [${selection.category}] instances: ${instances}`);
    }
  }

  return parts.join('\n\n');
}

function rootingContextOf(project: ProjectState): RootingContext {
  const controller = project.components.find((selection) => selection.category === 'microcontroller');
  const controllerName = controller?.name ?? 'the selected board';
  return {
    projectName: project.name,
    projectSummary: project.requirements?.summary ?? '',
    controllerName,
    assignments: project.pinAssignments,
    libraries: project.artifacts.libraries?.libraries ?? project.softwarePlan?.libraries ?? [],
    platformIsEsp32: /esp32/i.test(controllerName) || /esp32/i.test(controller?.componentId ?? ''),
  };
}

function entryOf(project: ProjectState): { path: string; content: string } | null {
  const code = project.artifacts.code;
  if (!code) return null;
  const entry = code.files.find((file) => file.path === code.entryPoint) ?? code.files[0];
  return entry ? { path: entry.path, content: entry.content } : null;
}

function cappedDiff(oldContent: string, newContent: string, path: string): ChatDiff {
  const result = diffLines(oldContent, newContent);
  const truncated = result.lines.length > MAX_DIFF_LINES;
  const lines: DiffLine[] = truncated ? result.lines.slice(0, MAX_DIFF_LINES) : result.lines;
  return {
    path,
    added: result.added,
    removed: result.removed,
    truncated,
    lines: lines.map((line) =>
      line.kind === 'same'
        ? { kind: 'same', text: line.text, oldLine: line.oldLine, newLine: line.newLine }
        : line.kind === 'add'
          ? { kind: 'add', text: line.text, newLine: line.newLine }
          : { kind: 'del', text: line.text, oldLine: line.oldLine },
    ),
  };
}

function withChat(project: ProjectState, messages: ChatMessage[]): ProjectState {
  return { ...project, chat: [...project.chat, ...messages].slice(-MAX_CHAT_MESSAGES) };
}

/** Fold new entry-file content into the code artifact. */
function withEntryContent(project: ProjectState, path: string, content: string, note: string): ProjectState {
  const code = project.artifacts.code;
  if (!code) return project;
  const files = code.files.map((file) =>
    file.path === path
      ? {
          ...file,
          content,
          generatedBy: 'model' as const,
          purpose: `${file.purpose.split(' — edited ')[0]} — edited in the workbench (${note})`,
        }
      : file,
  );
  return { ...project, artifacts: { ...project.artifacts, code: { ...code, files, pinsSynchronised: true } } };
}

/**
 * Deterministic post-rooting passes — the same belt-and-braces the generator
 * runs. On rooted content they are almost always no-ops; on user-pasted or
 * hand-mangled content they repair pin drift and includes.
 */
function deterministicSync(content: string, project: ProjectState): { content: string; notes: string[] } {
  const ctx = rootingContextOf(project);
  const notes: string[] = [];

  const withIncludes = ensureIncludesBlock(content, ctx.libraries, ctx.platformIsEsp32);
  const includeResult = ensureLibraryIncludes(withIncludes, ctx.libraries, ctx.platformIsEsp32);
  if (includeResult.added.length > 0) notes.push(`restored include(s): ${includeResult.added.join(', ')}`);

  const withPinMap = ensurePinMap(includeResult.content, project.pinAssignments);
  if (withPinMap !== includeResult.content) {
    notes.push('the managed pin map was re-derived from the pin plan — a hand-edited pin value cannot override the plan');
  }
  const sync = syncPinConstants(withPinMap, project.pinAssignments);
  if (sync.synced.length > 0) {
    notes.push(`re-synchronised pin constant(s): ${sync.synced.map((entry) => `${entry.name} ${entry.from} → ${entry.to}`).join(', ')}`);
  }

  const hygiene = applyFirmwareHygiene(sync.content, {
    selections: project.components,
    catalog: HYGIENE_CATALOG_FALLBACK,
    libraries: ctx.libraries,
  });
  notes.push(...hygiene.notes);

  return { content: hygiene.content, notes };
}

/** Hygiene only reads selections for I2C address lookup; empty is safe. */
const HYGIENE_CATALOG_FALLBACK: ComponentDefinition[] = [];

interface CompileOutcome {
  ok: boolean;
  errors: string[];
  warnings: string[];
  ran: boolean;
}

function outcomeOf(result: ReturnType<typeof compileFirmware>): CompileOutcome {
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').map(formatDiagnostic);
  // The compiler rejected the sketch without a diagnostic we could attribute
  // (timeout, shim failure): quote the honest reason instead of showing an
  // empty error list under "it does not compile".
  if (result.ran && !result.ok && errors.length === 0 && result.skippedReason) {
    errors.push(result.skippedReason);
  }
  return {
    ok: result.ok,
    ran: result.ran,
    errors,
    warnings: result.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').map(formatDiagnostic),
  };
}

function compileProject(project: ProjectState): CompileOutcome {
  const code = project.artifacts.code;
  if (!code) return { ok: false, errors: ['no code artifact'], warnings: [], ran: false };
  return outcomeOf(compileFirmware({ files: code.files, entryPoint: code.entryPoint }));
}

function freezeRevision(project: ProjectState, summary: string, outcome: CompileOutcome): ProjectState {
  const version = project.revision + 1;
  const revision = createRevision({
    project,
    version,
    reason: 'firmware_edit',
    summary,
    // A compile-scope result: the workbench freezes the compile verdict, not a
    // full validation pass (which runs with the pipeline's catalog context).
    validation: {
      passed: outcome.errors.length === 0,
      iteration: 0,
      checkedAt: nowIso(),
      durationMs: 0,
      issues: [],
      checks: [],
      summary: { errors: outcome.errors.length, warnings: outcome.warnings.length, info: 0, checksRun: 0, checksPassed: 0 },
    },
    stage: project.stage,
  });
  return { ...project, revision: version, revisions: appendRevision(project, revision) };
}

/* ------------------------------------------------------------------------- */
/* Chat turn                                                                  */
/* ------------------------------------------------------------------------- */

export async function runFirmwareChatTurn(input: {
  project: ProjectState;
  message: string;
  provider?: FirmwareEditProvider;
  events?: AgentEventLog;
}): Promise<FirmwareTurnResult> {
  const { project, message, provider } = input;
  const llmCalls: LlmCallRecord[] = [];
  const entry = entryOf(project);

  const userMessage: ChatMessage = { id: createId('msg'), role: 'user', text: message, at: nowIso() };
  const reply = (text: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
    id: createId('msg'),
    role: 'assistant',
    text,
    at: nowIso(),
    ...patch,
  });

  if (!entry) {
    const assistantMessage = reply('This project has no firmware yet, so there is nothing to edit. Generate the project first.');
    return { userMessage, assistantMessage, project: withChat(project, [userMessage, assistantMessage]), llmCalls, applied: false };
  }

  if (!provider) {
    const assistantMessage = reply(
      'The firmware chat needs a configured model (set the Bedrock environment). You can still edit the code by hand — the editor checks your changes against the pin plan and the compiler before saving.',
      { outcome: 'failed' },
    );
    return { userMessage, assistantMessage, project: withChat(project, [userMessage, assistantMessage]), llmCalls, applied: false };
  }

  const grounding = buildGrounding(project);
  const recent = project.chat.slice(-MAX_RECENT_MESSAGES).map((entry) => ({ role: entry.role, text: entry.text }));
  const request = {
    projectName: project.name,
    currentSketch: entry.content.slice(0, MAX_SKETCH_CHARS),
    grounding,
    instruction: message,
    recentMessages: recent,
  };

  const callFor = (result: { ok: boolean; error?: string; meta?: FirmwareEditMeta }, ok: boolean, error?: string): void => {
    llmCalls.push({
      id: createId('llm'),
      op: 'codegen',
      model: result.meta?.model ?? 'unknown',
      startedAt: nowIso(),
      finishedAt: nowIso(),
      durationMs: result.meta?.durationMs,
      status: ok ? 'ok' : 'failed',
      ...(error ? { error } : {}),
      ...(result.meta?.inputTokens !== undefined ? { inputTokens: result.meta.inputTokens } : {}),
      ...(result.meta?.outputTokens !== undefined ? { outputTokens: result.meta.outputTokens } : {}),
    });
  };

  /* --- turn 1: decide + (maybe) plan ------------------------------------- */
  const outcome = await provider(request);
  callFor(outcome, outcome.ok, outcome.ok ? undefined : outcome.error);

  if (!outcome.ok || !outcome.turn) {
    const assistantMessage = reply(`The model could not be reached for this turn (${outcome.error ?? 'unknown error'}). Your firmware is unchanged — try again, or edit by hand.`, {
      outcome: 'failed',
    });
    return { userMessage, assistantMessage, project: withChat(project, [userMessage, assistantMessage]), llmCalls, applied: false };
  }

  const turn = outcome.turn;

  if (turn.decision !== 'revise' || !turn.plan) {
    const assistantMessage = reply(turn.reply || 'Nothing to change in the firmware for that.', { outcome: 'answer' });
    return { userMessage, assistantMessage, project: withChat(project, [userMessage, assistantMessage]), llmCalls, applied: false };
  }

  /* --- gate 1: rooting ---------------------------------------------------- */
  const rooted = rootLlmSketch(turn.plan as LlmSketchPlan, rootingContextOf(project));
  if (rooted.verdict !== 'rooted') {
    const assistantMessage = reply(
      `${turn.reply || 'I drafted a change, but'} — the change was **refused by the rooting gate** before touching your firmware: ${rooted.issues.join('; ')}. The pin map and includes are fixed unless the plan changes; ask for a parts or wiring change instead if that is what you want.`,
      { outcome: 'rejected', diagnostics: rooted.issues },
    );
    return { userMessage, assistantMessage, project: withChat(project, [userMessage, assistantMessage]), llmCalls, applied: false };
  }

  /* --- gate 2: compile, with one diagnostics-informed repair round -------- */
  let candidate = rooted.content;
  let compile = compileSketchText(candidate, project);
  let repaired = false;

  if (compile.ran && !compile.ok) {
    const repair = await provider({ ...request, diagnostics: compile.errors });
    callFor(repair, repair.ok, repair.ok ? undefined : repair.error);
    if (repair.ok && repair.turn?.plan && repair.turn.decision === 'revise') {
      const repairedRoot = rootLlmSketch(repair.turn.plan as LlmSketchPlan, rootingContextOf(project));
      if (repairedRoot.verdict === 'rooted') {
        const repairedCompile = compileSketchText(repairedRoot.content, project);
        if (!repairedCompile.ran || repairedCompile.ok) {
          candidate = repairedRoot.content;
          compile = repairedCompile;
          repaired = true;
        }
      }
    }
  }

  if (compile.ran && !compile.ok) {
    const assistantMessage = reply(
      `${turn.reply || 'I drafted a change'} — but it does not compile, so nothing was applied. The compiler said:\n\n${compile.errors.map((error) => `\`${error}\``).join('\n')}\n\nRephrase the request or edit the marked lines by hand.`,
      { outcome: 'rejected', diagnostics: compile.errors },
    );
    return { userMessage, assistantMessage, project: withChat(project, [userMessage, assistantMessage]), llmCalls, applied: false };
  }

  /* --- apply: sync passes, diff, revision --------------------------------- */
  const synced = deterministicSync(candidate, project);
  const finalContent = synced.content;
  const diff = cappedDiff(entry.content, finalContent, entry.path);
  const notes: string[] = [];
  if (repaired) notes.push('one compile-repair round was needed');
  notes.push(...synced.notes);

  const compilerStatus = firmwareCompilerStatus();
  const freezeOutcome: CompileOutcome = { ok: compile.ok, ran: compile.ran, errors: compile.errors, warnings: compile.warnings };
  let next = withEntryContent(project, entry.path, finalContent, `chat: ${truncateForSummary(message)}`);
  next = freezeRevision(next, `Firmware edited via workbench chat: ${truncateForSummary(message)}`, freezeOutcome);

  const assistantMessage = reply(
    `${turn.reply || 'Done.'}${repaired ? ' (one compile-repair round was needed.)' : ''}${
      compile.ran
        ? ` The result type-checks against the host shim (${compilerStatus.compiler ?? 'compiler'}), ${diff.added} line(s) added, ${diff.removed} removed.`
        : ` ${diff.added} line(s) added, ${diff.removed} removed.${compilerStatus.available ? '' : ` Compile check not run: ${compilerStatus.reason}`}`
    }${synced.notes.length > 0 ? ` Deterministic passes: ${synced.notes.join('; ')}.` : ''}`,
    {
      outcome: 'applied',
      revision: next.revision,
      files: [entry.path],
      diff,
      ...(compile.warnings.length > 0 ? { diagnostics: compile.warnings } : {}),
    },
  );

  return { userMessage, assistantMessage, project: withChat(next, [userMessage, assistantMessage]), llmCalls, applied: true };
}

function compileSketchText(content: string, project: ProjectState): CompileOutcome {
  const code = project.artifacts.code;
  const files = [{ path: entryOf(project)?.path ?? 'sketch.ino', language: 'arduino', content, purpose: 'candidate', generatedBy: 'model' as const }];
  return outcomeOf(compileFirmware({ files, entryPoint: code?.entryPoint ?? 'sketch.ino' }));
}

/* ------------------------------------------------------------------------- */
/* Manual editor save                                                         */
/* ------------------------------------------------------------------------- */

export interface ManualEditResult {
  assistantMessage: ChatMessage;
  project: ProjectState;
  applied: boolean;
  /** Problems to show under the editor even when the save was refused. */
  diagnostics: string[];
}

export function applyManualFirmwareEdit(input: { project: ProjectState; path: string; content: string }): ManualEditResult {
  const { project, path, content } = input;
  const entry = entryOf(project);

  const refuse = (text: string, diagnostics: string[]): ManualEditResult => ({
    assistantMessage: {
      id: createId('msg'),
      role: 'assistant',
      text,
      at: nowIso(),
      outcome: 'rejected',
      diagnostics,
    },
    project,
    applied: false,
    diagnostics,
  });

  if (!entry || path !== entry.path) {
    return refuse(`Only the entry sketch (${entry?.path ?? 'sketch.ino'}) can be edited in this version.`, []);
  }
  if (content === entry.content) {
    return refuse('The file is unchanged — nothing to save.', []);
  }

  const quality = assessCodeQuality(content);
  if (!quality.usable && braceBalance(content) !== 0) {
    return refuse(`The file does not type-check structurally: ${quality.reasons.join('; ')}. Fix the marked problems and save again.`, quality.reasons);
  }

  const synced = deterministicSync(content, project);
  const compile = compileSketchText(synced.content, project);

  if (compile.ran && !compile.ok) {
    return refuse(
      `Saved nothing: the compiler rejects this version. Fix the problems (shown under the editor) and save again — your edited text is still in the editor.`,
      compile.errors,
    );
  }

  const warnings = [...compile.warnings, ...synced.notes];
  let next = withEntryContent(project, path, synced.content, 'manual edit');
  next = freezeRevision(next, `Firmware edited by hand in the workbench`, { ok: compile.ok, ran: compile.ran, errors: [], warnings: compile.warnings });

  const assistantMessage: ChatMessage = {
    id: createId('msg'),
    role: 'assistant',
    text: compile.ran
      ? `Manual edit saved as revision v${next.revision} — it type-checks (${compile.warnings.length} warning(s)).${synced.notes.length > 0 ? ` Deterministic passes: ${synced.notes.join('; ')}.` : ''}`
      : `Manual edit saved as revision v${next.revision}.${compile.ran ? '' : ` Compile check not run: ${firmwareCompilerStatus().reason ?? 'unavailable'}.`}${
          synced.notes.length > 0 ? ` Deterministic passes: ${synced.notes.join('; ')}.` : ''
        }`,
    at: nowIso(),
    outcome: 'applied',
    revision: next.revision,
    files: [path],
    diff: cappedDiff(entry.content, synced.content, path),
    ...(warnings.length > 0 ? { diagnostics: warnings.slice(0, 8) } : {}),
  };

  return { assistantMessage, project: withChat(next, [assistantMessage]), applied: true, diagnostics: warnings };
}

function truncateForSummary(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
