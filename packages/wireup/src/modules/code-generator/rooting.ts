/**
 * The rooting gate for model-authored firmware.
 *
 * The model writes BEHAVIOUR (state, setup logic, the loop, helper functions).
 * Wireup owns the HARDWARE CONTEXT: the include list, the pin constants and
 * the I2C bus setup are re-derived from the authoritative pin plan and library
 * manifest on every generation. The two are assembled together here, and the
 * model's sections are sanitised on the way in:
 *
 *   - `#include` lines written by the model are stripped (the managed includes
 *     block is the only include source);
 *   - pin-constant declarations written by the model are dropped when they
 *     repeat a planned constant, aliased onto the planned constant when the
 *     name maps to exactly one assignment, and rejected as a hallucination
 *     when they map to nothing (a pin the plan never assigned);
 *   - raw numeric pin literals in `pinMode`/`digitalWrite`/… calls are
 *     rewritten to the planned constant names;
 *   - brace balance is repaired (or the sketch is rejected when it cannot be).
 *
 * The result is audited before it is allowed to become the sketch: no setup(),
 * no loop(), unrecoverable braces, or a hallucinated pin that the model's own
 * logic depends on ⇒ `rejected`, and the caller falls back to the deterministic
 * template. The managed blocks are therefore *fixed unless the plan itself
 * changes* — a later fix that moves a pin re-derives the block and re-audits
 * the model logic against it, which is exactly the property follow-up edits
 * need.
 *
 * Everything in this module is deterministic and pure so it can be exercised
 * offline (`scripts/verify-llm-codegen.ts`).
 */

import type { LibraryRequirement } from '@/types/component';
import type { PinAssignment } from '@/types/wiring';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';

import {
  buildIncludesBlock,
  buildPinMapBlock,
  constantName,
  INCLUDES_END,
  INCLUDES_START,
  PIN_MAP_END,
  PIN_MAP_START,
  pinConstantMap,
  pinLiteral,
} from './managed-blocks';
import { assessCodeQuality, braceBalance, looksLikePinConstant, normalizeConstantName } from './quality';

/* ------------------------------------------------------------------------- */
/* Types                                                                      */
/* ------------------------------------------------------------------------- */

/** One model-proposed `const` declaration. Pin-looking ones never pass as-is. */
export interface LlmSketchConstant {
  name: string;
  value: string;
  comment?: string;
}

/** A complete helper function definition (`float mapRange(...) { … }`). */
export interface LlmSketchFunction {
  name: string;
  definition: string;
}

/** The behavioural sections the model is allowed to author. */
export interface LlmSketchPlan {
  constants: LlmSketchConstant[];
  globals: string;
  setup: string;
  loop: string;
  functions: LlmSketchFunction[];
  /** The model's own remarks — display only, never compiled. */
  notes: string[];
}

export interface RootingContext {
  projectName: string;
  projectSummary: string;
  controllerName: string;
  assignments: PinAssignment[];
  libraries: LibraryRequirement[];
  platformIsEsp32: boolean;
  profile?: McuProfile;
  /** Deterministic `Wire.begin(...)` lines for the board (from managed-blocks). */
  i2cInitLines?: string[];
}

export interface RootingResult {
  content: string;
  verdict: 'rooted' | 'rejected';
  /** Fatal problems — the reason a sketch was rejected. */
  issues: string[];
  /** Deterministic fixes applied while rooting (all resolved). */
  repairs: string[];
  /** Non-fatal observations the user should see in the notes. */
  warnings: string[];
}

/* ------------------------------------------------------------------------- */
/* Model → plan constant reconciliation                                       */
/* ------------------------------------------------------------------------- */

/** A generic role word a model uses for a peripheral (`LED_PIN`, `BUTTON_PIN`). */
export function roleWordFor(assignment: PinAssignment): string | undefined {
  const id = assignment.targetInstanceId.toLowerCase();
  if (/oled|ssd1306|lcd/.test(id)) return 'OLED';
  if (/button|switch/.test(id)) return 'BUTTON';
  if (/rgb/.test(id)) return 'RGB';
  if (/(^|[^o])led/.test(id)) return 'LED';
  if (/buzzer/.test(id)) return 'BUZZER';
  if (/servo/.test(id)) return 'SERVO';
  if (/relay/.test(id)) return 'RELAY';
  if (/pir/.test(id)) return 'PIR';
  if (/dht/.test(id)) return 'DHT';
  if (/pot/.test(id)) return 'POT';
  if (/ldr|photo/.test(id)) return 'LDR';
  if (/trig|ultrasonic|hc-?sr04|sonar/.test(id)) return 'TRIG';
  if (/echo/.test(id)) return 'ECHO';
  return undefined;
}

/**
 * Which planned assignments could a model-invented constant name refer to?
 * Whole-word matching on `_`-separated tokens against the instance id, its
 * stem, catalog component words and the role word — the same idea as the
 * fuzzy repair in `syncPinConstants`, but returning candidates instead of
 * rewriting.
 */
function matchPlanConstants(name: string, assignments: PinAssignment[]): PinAssignment[] {
  const upper = normalizeConstantName(name);
  const words = new Set(upper.split('_').filter(Boolean));
  const hasWord = (token: string): boolean => {
    const parts = token.split('_').filter(Boolean);
    return parts.length > 0 && parts.every((part) => words.has(part));
  };

  const scored = assignments.map((assignment) => {
    const instanceToken = normalizeConstantName(assignment.targetInstanceId);
    const instanceStem = instanceToken.replace(/_\d+$/, '');
    const componentWords = instanceStem.split('_').filter((part) => part.length >= 3 && !/^\d+$/.test(part));
    const roleWord = roleWordFor(assignment);
    const mentionsComponent =
      hasWord(instanceToken) || hasWord(instanceStem) || componentWords.some((word) => words.has(word)) || (roleWord !== undefined && words.has(roleWord));
    const pinToken = normalizeConstantName(assignment.targetPin);
    const mentionsPin = pinToken.length >= 2 && hasWord(pinToken);
    const score = (mentionsComponent ? 1 : 0) + (mentionsPin ? 1 : 0);
    return { assignment, score };
  });

  const best = Math.max(0, ...scored.map((entry) => entry.score));
  if (best === 0) return [];
  return scored.filter((entry) => entry.score === best).map((entry) => entry.assignment);
}

interface ConstantReconciliation {
  /** `const` lines that may enter the sketch (model constants + aliases). */
  kept: string[];
  repairs: string[];
  /** Fatal: the model declared a pin the plan never assigned. */
  issues: string[];
  warnings: string[];
}

/**
 * Reconcile the model's `constants` array with the authoritative pin map.
 *
 * - name == a planned constant  → dropped (the managed block declares it).
 * - pin-looking, unique match   → aliased: `const int BUTTON_PIN = PIN_BUTTON_1;`
 *   so the model's own references keep working without owning the value.
 * - pin-looking, no match       → fatal (hallucinated pin).
 * - anything else               → kept verbatim (thresholds, sizes, states…).
 */
export function reconcileConstants(constants: LlmSketchConstant[], assignments: PinAssignment[]): ConstantReconciliation {
  const planned = pinConstantMap(assignments);
  const kept: string[] = [];
  const repairs: string[] = [];
  const issues: string[] = [];
  const warnings: string[] = [];

  for (const constant of constants) {
    const value = String(constant.value).trim();
    const name = constant.name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      issues.push(`model constant "${name}" is not a valid C identifier and was rejected`);
      continue;
    }

    if (planned.has(normalizeConstantName(name))) {
      repairs.push(`constant ${name} duplicates the pin map — dropped (the managed block already declares it)`);
      continue;
    }

    if (looksLikePinConstant(name, value)) {
      const candidates = matchPlanConstants(name, assignments);
      const uniqueLiterals = new Set(candidates.map((candidate) => pinLiteral(candidate)));
      if (candidates.length > 0 && uniqueLiterals.size === 1) {
        const target = constantName(candidates[0] as PinAssignment);
        kept.push(`const int ${name} = ${target};${constant.comment ? ` // ${constant.comment}` : ' // aliased to the planned pin constant by Wireup'}`);
        repairs.push(`model pin constant ${name} (was ${value}) aliased onto the planned constant ${target}`);
        continue;
      }
      issues.push(
        `model declared pin constant ${name} = ${value}, but the pin plan assigns nothing that matches — hallucinated pin, sketch rejected`,
      );
      continue;
    }

    // Non-pin constants are the model's legitimate business (thresholds,
    // timings, state ids). Pick a declaration form that survives any value.
    kept.push(declareModelConstant(name, value, constant.comment));
    if (/\b(PIN|GPIO)\b/i.test(name)) {
      warnings.push(`model constant ${name} mentions a pin but holds a non-pin value (${value}) — left as authored`);
    }
  }

  return { kept, repairs, issues, warnings };
}

/** `const int` for integers, `const float` for decimals, `#define` for the rest. */
function declareModelConstant(name: string, value: string, comment?: string): string {
  const suffix = comment ? ` // ${comment}` : '';
  if (/^-?\d+$/.test(value)) return `const int ${name} = ${value};${suffix}`;
  if (/^-?\d+\.\d+$/.test(value)) return `const float ${name} = ${value};${suffix}`;
  return `#define ${name} ${value}${suffix}`;
}

/* ------------------------------------------------------------------------- */
/* Section sanitisation                                                       */
/* ------------------------------------------------------------------------- */

interface SanitizedSection {
  body: string;
  strayIncludes: string[];
  repairs: string[];
  issues: string[];
  warnings: string[];
}

const PIN_API_PATTERN = /\b(pinMode|digitalWrite|digitalRead|analogRead|analogWrite|tone|noTone|attach)\s*\(\s*(\d{1,3}|A\d{1,2}|LED_BUILTIN)\b/g;

/**
 * Clean one behavioural section before it enters the sketch:
 * strip `#include` lines, neutralise smuggled pin declarations, and rewrite
 * raw numeric pin literals to the planned constant names.
 */
export function sanitizeModelSection(source: string, assignments: PinAssignment[]): SanitizedSection {
  const plannedByLiteral = new Map<string, string[]>();
  for (const [name, literal] of pinConstantMap(assignments)) {
    plannedByLiteral.set(literal, [...(plannedByLiteral.get(literal) ?? []), name]);
  }
  const plannedNames = new Set([...pinConstantMap(assignments).keys()].map(normalizeConstantName));

  const repairs: string[] = [];
  const issues: string[] = [];
  const warnings: string[] = [];
  const strayIncludes: string[] = [];

  let body = source;

  // 1. #include lines never enter a logic section.
  body = body
    .split('\n')
    .filter((line) => {
      const match = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/.exec(line);
      if (!match) return true;
      strayIncludes.push(match[1] ?? '');
      repairs.push(`model include <${match[1]}> stripped — includes come from the managed library block`);
      return false;
    })
    .join('\n');

  // 2. Pin-constant declarations smuggled into the section.
  const definitionPattern = /(?:const\s+(?:unsigned\s+)?(?:int|uint8_t|uint16_t|int8_t|byte)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;\n]+);|#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_"]+))/g;
  const edits: { start: number; end: number; text: string }[] = [];
  for (const match of body.matchAll(definitionPattern)) {
    const name = (match[1] ?? match[3] ?? '').trim();
    const value = (match[2] ?? match[4] ?? '').trim();
    if (!name || !looksLikePinConstant(name, value)) continue;

    if (plannedNames.has(normalizeConstantName(name))) {
      edits.push({ start: match.index, end: match.index + match[0].length, text: '' });
      repairs.push(`pin constant ${name} re-declared by the model — dropped (the managed block is authoritative)`);
      continue;
    }
    const candidates = matchPlanConstants(name, assignments);
    const uniqueLiterals = new Set(candidates.map((candidate) => pinLiteral(candidate)));
    if (candidates.length > 0 && uniqueLiterals.size === 1) {
      const target = constantName(candidates[0] as PinAssignment);
      edits.push({ start: match.index, end: match.index + match[0].length, text: `const int ${name} = ${target};` });
      repairs.push(`model pin constant ${name} (was ${value}) aliased onto ${target}`);
      continue;
    }
    issues.push(`model declared pin constant ${name} = ${value} inside its code, but no planned pin matches — hallucinated pin, sketch rejected`);
  }
  for (let i = edits.length - 1; i >= 0; i -= 1) {
    const edit = edits[i];
    if (!edit) continue;
    body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  }

  // 3. Raw numeric pin literals in pin APIs → planned constant names.
  body = body.replace(PIN_API_PATTERN, (whole, api: string, literal: string, offset: number) => {
    if (literal === 'LED_BUILTIN') return whole;
    const names = plannedByLiteral.get(literal);
    if (!names || names.length === 0) {
      warnings.push(`model calls ${api}(${literal}) — that number is not in the pin plan (may be legitimate, verify)`);
      return whole;
    }
    if (names.length > 1) {
      warnings.push(`${api}(${literal}) matches several planned pins (${names.join(', ')}) — left as a literal`);
      return whole;
    }
    const replacement = `${api}(${names[0]}`;
    repairs.push(`${api}(${literal}) rewritten to ${api}(${names[0]}) so the call follows the pin plan`);
    void offset;
    return replacement;
  });

  return { body, strayIncludes, repairs, issues, warnings };
}

/* ------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* ------------------------------------------------------------------------- */

function indentBlock(source: string, pad = '  '): string {
  return source
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.trim().length === 0 ? '' : `${pad}${line}`))
    .join('\n');
}

/** Reject bodies that define their own setup()/loop() instead of being bodies. */
function containsEntryDefinition(source: string): boolean {
  return /\bvoid\s+(setup|loop)\s*\(/.test(source);
}

export function rootLlmSketch(plan: LlmSketchPlan, ctx: RootingContext): RootingResult {
  const issues: string[] = [];
  const repairs: string[] = [];
  const warnings: string[] = [];

  /* --- entry contract: bodies, not definitions ---------------------------- */
  for (const [label, section] of [
    ['setup', plan.setup],
    ['loop', plan.loop],
  ] as const) {
    if (containsEntryDefinition(section)) {
      issues.push(`the model's ${label} section defines its own ${label}() — it must be a body of statements`);
    }
  }

  /* --- constants ----------------------------------------------------------- */
  const reconciliation = reconcileConstants(plan.constants, ctx.assignments);
  issues.push(...reconciliation.issues);
  repairs.push(...reconciliation.repairs);
  warnings.push(...reconciliation.warnings);

  /* --- sections ------------------------------------------------------------ */
  const globals = sanitizeModelSection(plan.globals, ctx.assignments);
  const setup = sanitizeModelSection(plan.setup, ctx.assignments);
  const loop = sanitizeModelSection(plan.loop, ctx.assignments);
  issues.push(...globals.issues, ...setup.issues, ...loop.issues);
  repairs.push(...globals.repairs, ...setup.repairs, ...loop.repairs);
  warnings.push(...globals.warnings, ...setup.warnings, ...loop.warnings);

  const sanitizedFunctions: string[] = [];
  for (const definition of plan.functions) {
    const clean = sanitizeModelSection(definition.definition, ctx.assignments);
    issues.push(...clean.issues);
    repairs.push(...clean.repairs);
    warnings.push(...clean.warnings);
    if (clean.body.trim().length > 0) sanitizedFunctions.push(clean.body.trim());
  }

  if (issues.length > 0) {
    return { content: '', verdict: 'rejected', issues, repairs, warnings };
  }

  /* --- assemble ------------------------------------------------------------ */
  const lines: string[] = [];
  lines.push(`// ${ctx.projectName} — firmware logic authored by the model, rooted by Wireup.`);
  lines.push(`// ${ctx.projectSummary}`);
  lines.push('// The includes block and pin map below are machine-managed: they are re-derived');
  lines.push('// from the pin plan and library manifest on every generation, so the firmware');
  lines.push('// can never disagree with the wiring graph or diagram.json.');
  lines.push('');
  lines.push(buildIncludesBlock(ctx.libraries, ctx.platformIsEsp32));
  lines.push('');
  lines.push(buildPinMapBlock(ctx.assignments, ctx.profile));
  lines.push('');

  if (reconciliation.kept.length > 0) {
    lines.push('// ---- model constants (reconciled with the pin plan) ----');
    lines.push(...reconciliation.kept);
    lines.push('');
  }
  if (globals.body.trim().length > 0) {
    lines.push('// ---- model globals ----');
    lines.push(globals.body.trim());
    lines.push('');
  }

  const setupParts: string[] = [];
  if (!/Serial\s*\.\s*begin\s*\(/.test(setup.body)) {
    setupParts.push('Serial.begin(115200);');
    repairs.push('Serial.begin(115200) inserted — telemetry and the behavioural harness read the serial trace');
  }
  for (const line of ctx.i2cInitLines ?? []) setupParts.push(line);
  setupParts.push(setup.body.trim());

  const loopBody = loop.body.trim().length > 0 ? loop.body.trim() : '// the model authored no loop body — the deterministic template covers behaviour instead';
  if (loop.body.trim().length === 0) issues.push('the model returned an empty loop body');

  lines.push('void setup() {');
  lines.push(indentBlock(setupParts.join('\n')));
  lines.push('}');
  lines.push('');
  lines.push('void loop() {');
  lines.push(indentBlock(loopBody));
  lines.push('}');

  if (sanitizedFunctions.length > 0) {
    lines.push('');
    lines.push('// ---- model helper functions ----');
    for (const definition of sanitizedFunctions) {
      lines.push('');
      lines.push(definition);
    }
  }
  lines.push('');

  let content = lines.join('\n');

  /* --- brace repair / rejection -------------------------------------------- */
  const balance = braceBalance(content);
  if (balance > 0) {
    content = `${content.trimEnd()}\n${'}'.repeat(balance)}\n`;
    repairs.push(`${balance} closing brace(s) appended to balance the model's sections`);
  } else if (balance < 0) {
    issues.push(`unrecoverable brace imbalance (${Math.abs(balance)} extra '}')`);
  }

  if (issues.length > 0) {
    return { content: '', verdict: 'rejected', issues, repairs, warnings };
  }

  /* --- final audit ---------------------------------------------------------- */
  const audit = auditRootedSketch(content, ctx);
  warnings.push(...audit.warnings);
  if (!audit.ok) {
    return { content: '', verdict: 'rejected', issues: [...issues, ...audit.issues], repairs, warnings };
  }

  return { content, verdict: 'rooted', issues, repairs, warnings };
}

/* ------------------------------------------------------------------------- */
/* Audit                                                                      */
/* ------------------------------------------------------------------------- */

export interface RootingAudit {
  ok: boolean;
  issues: string[];
  warnings: string[];
}

/**
 * Independent post-assembly check: the managed blocks must agree with the plan
 * byte-for-byte, no pin constant may be declared outside the managed block,
 * and every include outside the managed block must be provided by the plan or
 * the toolchain. This runs on the *assembled file*, not on the model's answer,
 * so it also catches assembly bugs.
 */
export function auditRootedSketch(content: string, ctx: RootingContext): RootingAudit {
  const issues: string[] = [];
  const warnings: string[] = [];

  const quality = assessCodeQuality(content);
  if (!quality.usable) issues.push(`assembled sketch failed the quality gate: ${quality.reasons.join('; ')}`);

  /* Managed pin block present and exactly correct. */
  const mapStart = content.indexOf(PIN_MAP_START);
  const mapEnd = content.indexOf(PIN_MAP_END);
  if (mapStart === -1 || mapEnd === -1 || mapEnd < mapStart) {
    issues.push('managed pin map block is missing');
  } else {
    const block = content.slice(mapStart, mapEnd + PIN_MAP_END.length);
    for (const [name, literal] of pinConstantMap(ctx.assignments)) {
      const declaration = new RegExp(`const\\s+int\\s+${name}\\s*=\\s*([^;]+);`).exec(block);
      if (!declaration) issues.push(`managed pin map is missing ${name}`);
      else if ((declaration[1] ?? '').trim() !== literal) {
        issues.push(`managed pin map declares ${name} = ${(declaration[1] ?? '').trim()} but the plan says ${literal}`);
      }
    }
  }

  /* Managed includes block present. */
  const incStart = content.indexOf(INCLUDES_START);
  const incEnd = content.indexOf(INCLUDES_END);
  if (incStart === -1 || incEnd === -1 || incEnd < incStart) issues.push('managed includes block is missing');

  /* No pin-looking constant declared outside the managed block. */
  const managedRanges: [number, number][] = [];
  if (mapStart !== -1 && mapEnd !== -1) managedRanges.push([mapStart, mapEnd + PIN_MAP_END.length]);
  if (incStart !== -1 && incEnd !== -1) managedRanges.push([incStart, incEnd + INCLUDES_END.length]);
  const inManaged = (index: number): boolean => managedRanges.some(([start, end]) => index >= start && index <= end);

  for (const match of content.matchAll(/(?:const\s+(?:unsigned\s+)?(?:int|uint8_t|uint16_t|int8_t|byte)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;\n]+);|#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_"]+))/g)) {
    if (inManaged(match.index)) continue;
    const name = (match[1] ?? match[3] ?? '').trim();
    const value = (match[2] ?? match[4] ?? '').trim();
    if (name && looksLikePinConstant(name, value)) {
      issues.push(`pin constant ${name} = ${value} declared outside the managed block`);
    }
  }

  /* Includes outside the managed block must be plan- or toolchain-provided. */
  const plannedImports = new Set(ctx.libraries.map((library) => library.import.replace(/[<>"']/g, '').toLowerCase()));
  const beforeIncludes = incStart === -1 ? content.length : incStart;
  for (const match of content.slice(0, beforeIncludes).matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm)) {
    // Includes above the managed block can only exist before it; the assembly
    // never writes any, so any hit here is a construction bug.
    issues.push(`include <${match[1]}> appears above the managed includes block`);
  }
  for (const match of content.slice(incEnd === -1 ? content.length : incEnd + INCLUDES_END.length).matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm)) {
    const header = (match[1] ?? '').replace(/[<>"']/g, '').toLowerCase();
    if (plannedImports.has(header) || TOOLCHAIN_ALLOWLIST.test(header)) {
      warnings.push(`include <${match[1]}> outside the managed block (${plannedImports.has(header) ? 'planned' : 'toolchain'})`);
    } else {
      issues.push(`include <${match[1]}> is provided by neither the library plan nor the toolchain`);
    }
  }

  /* Sections were sanitised, but verify no raw pin-literal API call survived
     against a pin that the plan does not know (LED_BUILTIN is legal). */
  const plannedLiterals = new Set(pinConstantMap(ctx.assignments).keys());
  for (const match of content.matchAll(PIN_API_PATTERN)) {
    const literal = match[2] ?? '';
    if (literal === 'LED_BUILTIN' || plannedLiterals.has(literal)) continue;
    warnings.push(`${match[1]}(${literal}) uses a pin number that is not in the plan`);
  }

  return { ok: issues.length === 0, issues, warnings };
}

/** Headers always available on the Arduino toolchain (mirrors hygiene.ts). */
const TOOLCHAIN_ALLOWLIST =
  /^(Arduino|Wire|SPI|EEPROM|SoftwareSerial|Servo|math|stdint|stdlib|string|stdio|avr\/.*|util\/.*|esp_.*|freertos\/.*|WiFi|BluetoothSerial|BLEDevice|BLEServer|BLEUtils|BLE2902|Preferences|HardwareSerial|pgmspace|limits|ctype)\.h$/i;
