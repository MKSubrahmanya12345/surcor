/**
 * Code generator.
 *
 * AI-first with a rooted fallback. When the environment enables it
 * (`WIREUP_ENABLE_LLM_CODEGEN`) and a sketch provider is supplied, the model
 * authors the behavioural sections of the sketch against the fully grounded
 * hardware context (see `llm.ts`), and `rooting.ts` assembles the final file:
 * the managed include block and pin map are re-derived here from the
 * authoritative pin plan, so the firmware can never disagree with the wiring
 * graph or `diagram.json`, and a pin fix later only needs to re-run this
 * synchronisation step.
 *
 * Order of preference for the sketch source:
 *
 *   1. the model's rooted sketch plan (AI-first path),
 *   2. whole-file model code from the generation call (`modelCode`),
 *   3. the deterministic template.
 *
 * Every path runs through the same deterministic synchronisation passes
 * (managed blocks, pin-constant sync, firmware hygiene), and if the model
 * returns nothing usable the artifact still exists — the model refines, it
 * never owns correctness.
 */

import type { ComponentDefinition, ComponentSelection, LibraryRequirement } from '@/types/component';
import type { CodeArtifact, GeneratedCodeFile, LlmCallRecord, ProjectRequirements, SoftwarePlan } from '@/types/project';
import type { PinAssignment } from '@/types/wiring';
import type { AgentEventLog } from '@/lib/logging/events';
import type { I2CBus, SerialLink } from '@/modules/pin-planner';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';

import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import { env } from '@/lib/validation/env';

import {
  INCLUDES_END,
  INCLUDES_START,
  PIN_MAP_END,
  PIN_MAP_START,
  buildIncludesBlock,
  buildPinMapBlock,
  constantName,
  i2cBusInitLines,
  includeStatement,
  pinLiteral,
} from './managed-blocks';
import { generateSketch, type SketchContext } from './templates';
import { applyFirmwareHygiene } from './hygiene';
import { braceBalance, assessCodeQuality, looksLikePinConstant, normalizeConstantName } from './quality';
import { roleWordFor, rootLlmSketch, type RootingContext } from './rooting';
import { bedrockSketchPlanProvider, llmCodegenEnabled, type SketchPlanProvider } from './llm';

/* Public re-exports: the validator and fixer import these from this module. */
export { assessCodeQuality, braceBalance } from './quality';

export interface CodeGeneratorInput {
  projectName: string;
  projectSummary: string;
  requirements: ProjectRequirements;
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  assignments: PinAssignment[];
  serialLinks: SerialLink[];
  i2cBuses: I2CBus[];
  softwarePlan: SoftwarePlan;
  controllerName: string;
  profile?: McuProfile;
  revision: number;
  modelCode?: unknown;
  events?: AgentEventLog;
  /** The original user brief — the grounding source for the AI-first path. */
  prompt?: string;
  /**
   * AI-first sketch provider (the Bedrock one, or a canned stub in offline
   * harnesses). Used only when `WIREUP_ENABLE_LLM_CODEGEN` is true.
   */
  llmProvider?: SketchPlanProvider;
  /** Receives the finished `codegen` call record so callers can persist it. */
  onLlmCall?: (call: LlmCallRecord) => void;
}

interface ModelFile {
  path: string;
  language: string;
  content: string;
  purpose: string;
}

function languageForPath(path: string): string {
  if (path.endsWith('.ino')) return 'arduino';
  if (path.endsWith('.h') || path.endsWith('.hpp')) return 'c-header';
  if (path.endsWith('.c')) return 'c';
  if (path.endsWith('.cpp') || path.endsWith('.cc')) return 'cpp';
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.md')) return 'markdown';
  return 'text';
}

function parseModelFiles(raw: unknown): ModelFile[] {
  const candidates: unknown[] = [];
  if (Array.isArray(raw)) candidates.push(...raw);
  else if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.files)) candidates.push(...record.files);
    else candidates.push(record);
  }

  const files: ModelFile[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content : typeof record.code === 'string' ? record.code : '';
    if (content.trim().length === 0) continue;
    const path = String(record.path ?? record.filename ?? record.file ?? 'sketch.ino').trim().replace(/^\/+/, '');
    files.push({
      path: path || 'sketch.ino',
      language: typeof record.language === 'string' ? record.language : languageForPath(path),
      content,
      purpose: String(record.purpose ?? record.description ?? 'Generated firmware source'),
    });
  }
  return files;
}

export function replaceMarkerBlock(content: string, start: string, end: string, block: string): string | null {
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return null;
  return `${content.slice(0, startIndex)}${block}${content.slice(endIndex + end.length)}`;
}

export function insertAfterIncludes(content: string, block: string): string {
  const includePattern = /^[ \t]*#\s*include\b.*$/gm;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = includePattern.exec(content)) !== null) lastMatch = match;

  if (lastMatch) {
    const insertAt = lastMatch.index + lastMatch[0].length;
    return `${content.slice(0, insertAt)}\n\n${block}${content.slice(insertAt)}`;
  }

  const headerEnd = content.indexOf('*/');
  if (headerEnd !== -1) {
    return `${content.slice(0, headerEnd + 2)}\n\n${block}\n${content.slice(headerEnd + 2)}`;
  }
  return `${block}\n\n${content}`;
}

/** Insert or replace the authoritative pin map block. */
export function ensurePinMap(content: string, assignments: PinAssignment[], profile?: McuProfile): string {
  const block = buildPinMapBlock(assignments, profile);
  const replaced = replaceMarkerBlock(content, PIN_MAP_START, PIN_MAP_END, block);
  if (replaced !== null) return replaced;
  return insertAfterIncludes(content, block);
}

/** Insert or replace the authoritative include block. */
export function ensureIncludesBlock(content: string, libraries: LibraryRequirement[], platformIsEsp32: boolean): string {
  const block = buildIncludesBlock(libraries, platformIsEsp32);
  const replaced = replaceMarkerBlock(content, INCLUDES_START, INCLUDES_END, block);
  if (replaced !== null) return replaced;

  // No marker block: append any missing includes after the existing ones.
  const missing: string[] = [];
  for (const library of libraries) {
    const statement = includeStatement(library);
    if (!statement) continue;
    if (/BluetoothSerial\.h|BLEDevice\.h|WiFi\.h/i.test(library.import) && !platformIsEsp32) continue;
    if (!content.includes(statement)) missing.push(statement);
  }
  if (missing.length === 0) return content;
  return insertAfterIncludes(content, missing.join('\n'));
}

export function syncPinConstants(
  content: string,
  assignments: PinAssignment[],
): { content: string; synced: { name: string; from: string; to: string }[]; unresolved: string[] } {
  const synced: { name: string; from: string; to: string }[] = [];
  const unresolved: string[] = [];

  const blockStart = content.indexOf(PIN_MAP_START);
  const blockEnd = content.indexOf(PIN_MAP_END);
  const protectedRanges: [number, number][] = blockStart >= 0 && blockEnd > blockStart ? [[blockStart, blockEnd + PIN_MAP_END.length]] : [];

  const inProtectedRange = (index: number) => protectedRanges.some(([start, end]) => index >= start && index <= end);

  const expected = new Map<string, string>();
  for (const assignment of assignments) expected.set(constantName(assignment), pinLiteral(assignment));

  const byNormalised = new Map<string, string>();
  for (const [name, literal] of expected) byNormalised.set(normalizeConstantName(name), literal);

  // const int NAME = VALUE;  |  const uint8_t NAME = VALUE;  |  #define NAME VALUE
  const definitionPattern = /(?:const\s+(?:unsigned\s+)?(?:int|uint8_t|uint16_t|int8_t|byte)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);|#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_"]+))/g;

  let result = content;
  let match: RegExpExecArray | null;
  const replacements: { start: number; end: number; text: string }[] = [];

  while ((match = definitionPattern.exec(content)) !== null) {
    if (inProtectedRange(match.index)) continue;
    const name = match[1] ?? match[3] ?? '';
    const value = (match[2] ?? match[4] ?? '').trim();
    if (!name) continue;

    let literal = byNormalised.get(normalizeConstantName(name));

    if (literal === undefined) {
      /*
       * Fuzzy match: a model-invented pin constant (BUTTON_PIN, LED_PIN,
       * PIN_OLED_SDA, …) that maps to exactly one assignment.
       *
       * Only constants that *look* like pin declarations qualify, and tokens
       * are compared as whole `_`-separated words — a substring test used to
       * turn `OLED_ADDRESS 0x3C` into `OLED_ADDRESS 4` because the LED's pin
       * is called `A`.
       */
      if (!looksLikePinConstant(name, value)) continue;
      const upper = normalizeConstantName(name);
      const words = new Set(upper.split('_').filter(Boolean));
      const hasWord = (token: string) => {
        const parts = token.split('_').filter(Boolean);
        return parts.length > 0 && parts.every((part) => words.has(part));
      };
      const candidates = assignments.filter((assignment) => {
        const pinToken = normalizeConstantName(assignment.targetPin);
        const instanceToken = normalizeConstantName(assignment.targetInstanceId);
        const instanceStem = instanceToken.replace(/_\d+$/, '');
        const componentWords = instanceStem.split('_').filter((part) => part.length >= 3 && !/^\d+$/.test(part));
        const roleWord = roleWordFor(assignment);
        const mentionsComponent =
          hasWord(instanceToken) ||
          hasWord(instanceStem) ||
          componentWords.some((word) => words.has(word)) ||
          (roleWord !== undefined && words.has(roleWord));
        const mentionsPin = pinToken.length >= 2 && hasWord(pinToken);
        return mentionsComponent || mentionsPin;
      });
      // `OLED_SDA_PIN` matches both OLED assignments by component; the one
      // that also names the pin wins.
      const scored = candidates.map((assignment) => ({
        assignment,
        score: (normalizeConstantName(assignment.targetPin).length >= 2 && hasWord(normalizeConstantName(assignment.targetPin)) ? 1 : 0) as number,
      }));
      const best = Math.max(0, ...scored.map((entry) => entry.score));
      const narrowed = scored.filter((entry) => entry.score === best).map((entry) => entry.assignment);
      const uniqueLiterals = new Set(narrowed.map((candidate) => pinLiteral(candidate)));
      if (narrowed.length > 0 && uniqueLiterals.size === 1) literal = [...uniqueLiterals][0];
      else if (narrowed.length > 1) unresolved.push(name);
    }

    if (literal === undefined) continue;
    if (value === literal) continue;

    const isDefine = match[3] !== undefined;
    const text = isDefine ? `#define ${name} ${literal}` : `${match[0]?.split('=')[0]?.trim() ?? `const int ${name}`} = ${literal};`;
    replacements.push({ start: match.index, end: match.index + match[0].length, text });
    synced.push({ name, from: value, to: literal });
  }

  for (let i = replacements.length - 1; i >= 0; i -= 1) {
    const replacement = replacements[i];
    if (!replacement) continue;
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }

  return { content: result, synced, unresolved: [...new Set(unresolved)] };
}

/** Ensure the sketch declares every library the plan resolved. */
export function ensureLibraryIncludes(
  content: string,
  libraries: LibraryRequirement[],
  platformIsEsp32: boolean,
): { content: string; added: string[] } {
  const added: string[] = [];
  let output = content;

  for (const library of libraries) {
    const statement = includeStatement(library);
    if (!statement) continue;
    if (/BluetoothSerial\.h|BLEDevice\.h|WiFi\.h/i.test(library.import) && !platformIsEsp32) continue;
    if (output.includes(library.import)) continue;
    output = insertAfterIncludes(output, statement);
    added.push(library.import);
  }

  return { content: output, added };
}

/** Produce the code artifact. */
export async function generateCode(input: CodeGeneratorInput): Promise<CodeArtifact> {
  const handle = input.events?.start('code_generation_started', 'Generating firmware...', {
    stage: 'code',
    metadata: { assignments: input.assignments.length },
  });

  const notes: string[] = [];
  const sketchContext: SketchContext = {
    projectName: input.projectName,
    projectSummary: input.projectSummary,
    requirements: input.requirements,
    selections: input.selections,
    catalog: input.catalog,
    assignments: input.assignments,
    serialLinks: input.serialLinks,
    i2cBuses: input.i2cBuses,
    softwarePlan: input.softwarePlan,
    controllerName: input.controllerName,
    ...(input.profile ? { profile: input.profile } : {}),
    revision: input.revision,
  };

  const platformIsEsp32 = /esp32/i.test(input.controllerName);
  const modelFiles = parseModelFiles(input.modelCode);
  let entryCandidate: ModelFile | undefined;

  let entryContent = '';
  let generatedFromTemplate = false;
  /** The three sketch sources, most preferred first — for the notes. */
  let source: 'model-rooted' | 'model-file' | 'template' = 'template';

  /* --------------------------------------------------------------------- */
  /* 1. AI-first: the model authors the behaviour, rooting owns the hardware */
  /* --------------------------------------------------------------------- */
  const activeProvider =
    input.llmProvider ??
    (llmCodegenEnabled() && (Boolean(process.env.GEMINI_API_KEY) || Boolean(env().bedrock.modelId)) ? bedrockSketchPlanProvider() : undefined);
  const wantsLlm =
    env().agent.enableLlmCodegen && activeProvider !== undefined && typeof input.prompt === 'string' && input.prompt.trim().length > 0;

  if (wantsLlm && activeProvider) {
    const provider = activeProvider;
    const startedAt = Date.now();
    const call: LlmCallRecord = {
      id: createId('llm'),
      op: 'codegen',
      model: 'unknown',
      startedAt: nowIso(),
      status: 'failed',
    };
    const llmHandle = input.events?.start('llm_call_started', 'Asking the model to author the firmware logic against the pin plan...', {
      stage: 'code',
      metadata: { op: 'codegen' },
    });

    try {
      const result = await provider({
        projectName: input.projectName,
        projectSummary: input.projectSummary,
        prompt: input.prompt as string,
        requirements: input.requirements,
        selections: input.selections,
        catalog: input.catalog,
        assignments: input.assignments,
        softwarePlan: input.softwarePlan,
        controllerName: input.controllerName,
        platformIsEsp32,
        ...(input.profile ? { profile: input.profile } : {}),
        revision: input.revision,
      });

      call.model = result.meta?.model ?? 'unknown';
      call.finishedAt = nowIso();
      call.durationMs = Date.now() - startedAt;
      call.inputTokens = result.meta?.inputTokens;
      call.outputTokens = result.meta?.outputTokens;
      input.onLlmCall?.(call);

      if (!result.ok) {
        call.error = result.error;
        llmHandle?.fail(`Model sketch authoring failed (${result.error}) — using the deterministic path.`, result.error, {
          op: 'codegen',
          model: call.model,
          ...(result.code ? { code: result.code } : {}),
        });
        notes.push(`AI firmware authoring failed (${result.error}); the deterministic generator was used.`);
      } else {
        const rootingCtx: RootingContext = {
          projectName: input.projectName,
          projectSummary: input.projectSummary,
          controllerName: input.controllerName,
          assignments: input.assignments,
          libraries: input.softwarePlan.libraries,
          platformIsEsp32,
          ...(input.profile ? { profile: input.profile } : {}),
          ...(input.i2cBuses.length > 0
            ? {
                i2cInitLines: i2cBusInitLines({
                  assignments: input.assignments,
                  buses: input.i2cBuses,
                  ...(input.profile ? { profile: input.profile } : {}),
                  linkIdentifier: 'Serial',
                }),
              }
            : {}),
        };
        const rooted = rootLlmSketch(result.plan, rootingCtx);

        if (rooted.verdict === 'rooted') {
          call.status = 'ok';
          entryContent = rooted.content;
          source = 'model-rooted';
          llmHandle?.complete(`The model authored the firmware logic; Wireup rooted it to the pin plan (${rooted.repairs.length} repair(s)).`, {
            op: 'codegen',
            model: call.model,
            repairs: rooted.repairs.length,
            warnings: rooted.warnings.length,
            inputTokens: call.inputTokens ?? 0,
            outputTokens: call.outputTokens ?? 0,
          });
          notes.push(
            `Firmware logic authored by the model and rooted to the pin plan — the includes block and pin map are Wireup's, derived from the wiring graph.`,
          );
          for (const repair of rooted.repairs) notes.push(`[rooted] ${repair}`);
          for (const warning of rooted.warnings) notes.push(`[verify] ${warning}`);
          for (const modelNote of result.plan.notes.slice(0, 5)) notes.push(`[model] ${truncateLine(modelNote)}`);
        } else {
          llmHandle?.fail(
            `The model's sketch was rejected by the rooting gate: ${rooted.issues[0] ?? 'unspecified'} — using the deterministic path.`,
            rooted.issues.join('; '),
            { op: 'codegen', model: call.model, issues: rooted.issues.length },
          );
          notes.push(`The model's sketch was rejected by the rooting gate and the deterministic firmware was used instead: ${rooted.issues.join('; ')}.`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      call.error = message;
      call.finishedAt = nowIso();
      call.durationMs = Date.now() - startedAt;
      input.onLlmCall?.(call);
      llmHandle?.fail(`Model sketch authoring threw: ${message} — using the deterministic path.`, message, { op: 'codegen' });
      notes.push(`AI firmware authoring threw (${message}); the deterministic generator was used.`);
    }
  }

  /* --------------------------------------------------------------------- */
  /* 2/3. Whole-file model code from CALL 1, else the deterministic template */
  /* --------------------------------------------------------------------- */
  if (source === 'template') {
    entryCandidate =
      modelFiles.find((file) => file.path.toLowerCase() === 'sketch.ino') ??
      modelFiles.find((file) => file.path.toLowerCase().endsWith('.ino')) ??
      modelFiles[0];

    entryContent = entryCandidate?.content ?? '';

    if (!entryCandidate) {
      entryContent = generateSketch(sketchContext);
      generatedFromTemplate = true;
      notes.push('The model returned no source file; the firmware was generated deterministically from the pin plan and software plan.');
    } else {
      const quality = assessCodeQuality(entryContent);
      if (!quality.usable) {
        const balance = braceBalance(entryContent);
        if (balance > 0 && /void\s+setup\s*\(/.test(entryContent) && /void\s+loop\s*\(/.test(entryContent)) {
          entryContent = `${entryContent.trimEnd()}\n${'}'.repeat(balance)}\n`;
          notes.push(`Model source was missing ${balance} closing brace(s); they were appended.`);
          const reassessed = assessCodeQuality(entryContent);
          if (!reassessed.usable) {
            entryContent = generateSketch(sketchContext);
            generatedFromTemplate = true;
            notes.push(`Model source was unusable (${reassessed.reasons.join('; ')}) and was replaced by the deterministic sketch.`);
          }
        } else {
          entryContent = generateSketch(sketchContext);
          generatedFromTemplate = true;
          notes.push(`Model source was unusable (${quality.reasons.join('; ')}) and was replaced by the deterministic sketch.`);
        }
      } else {
        source = 'model-file';
        notes.push('Model-authored firmware was used as the base and synchronised with the pin plan.');
      }
    }
  }

  // Deterministic synchronisation passes.
  const withIncludes = ensureIncludesBlock(entryContent, input.softwarePlan.libraries, platformIsEsp32);
  const includeResult = ensureLibraryIncludes(withIncludes, input.softwarePlan.libraries, platformIsEsp32);
  if (includeResult.added.length > 0) {
    notes.push(`Added missing include(s): ${includeResult.added.join(', ')}.`);
  }

  const withPinMap = ensurePinMap(includeResult.content, input.assignments, input.profile);
  const preSync = syncPinConstants(withPinMap, input.assignments);
  const hygiene = applyFirmwareHygiene(preSync.content, {
    selections: input.selections,
    catalog: input.catalog,
    libraries: input.softwarePlan.libraries,
  });
  notes.push(...hygiene.notes);
  const syncResult = { ...preSync, content: hygiene.content };
  if (syncResult.synced.length > 0) {
    notes.push(
      `Re-synchronised ${syncResult.synced.length} pin constant(s) with the pin plan: ${syncResult.synced
        .map((entry) => `${entry.name} ${entry.from} → ${entry.to}`)
        .join(', ')}.`,
    );
  }
  if (syncResult.unresolved.length > 0) {
    notes.push(
      `Ambiguous pin constant name(s) left untouched (verify manually): ${syncResult.unresolved.join(', ')}.`,
    );
  }

  const files: GeneratedCodeFile[] = [
    {
      path: 'sketch.ino',
      language: 'arduino',
      content: syncResult.content,
      purpose: generatedFromTemplate
        ? 'Complete firmware generated from the pin plan, wiring graph and software plan.'
        : 'Complete firmware for the project (model authored, pin-synchronised by Wireup).',
      generatedBy: generatedFromTemplate ? 'planner' : 'model',
    },
  ];

  for (const file of modelFiles) {
    if (file === entryCandidate) continue;
    files.push({
      path: file.path,
      language: file.language || languageForPath(file.path),
      content: file.content,
      purpose: file.purpose,
      generatedBy: 'model',
    });
  }

  const artifact: CodeArtifact = {
    files,
    entryPoint: 'sketch.ino',
    pinsSynchronised: true,
    notes,
  };

  handle?.complete(
    `Firmware generated — ${files.length} file(s), ${files[0]?.content.split('\n').length ?? 0} lines in sketch.ino${
      source === 'model-rooted' ? ' (model-authored, rooted)' : generatedFromTemplate ? ' (deterministic template)' : ' (model file)'
    }`,
    {
      files: files.length,
      lines: files[0]?.content.split('\n').length ?? 0,
      generatedFromTemplate,
      source,
      syncedConstants: syncResult.synced.length,
    },
  );

  return artifact;
}

/** Keep model remarks inside a single event/note line. */
function truncateLine(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
