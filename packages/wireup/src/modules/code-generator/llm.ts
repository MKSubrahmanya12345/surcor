/**
 * AI-first firmware authoring, rooted to the plan.
 *
 * This is the counterpart of `rooting.ts`: it asks the model for the
 * BEHAVIOURAL sections of the sketch (constants that are not pins, globals,
 * setup body, loop body, helper functions) against a fully grounded, exact
 * description of the hardware context, and parses the answer into the
 * `LlmSketchPlan` shape the rooting gate assembles.
 *
 * Grounding rules baked into the prompt (the "fixed stuff stays fixed"
 * contract):
 *
 *   1. The pin map is owned by Wireup. The model may reference the provided
 *      `PIN_*` constants but must never declare pins, write `#include`, or use
 *      raw pin numbers.
 *   2. The include list is owned by Wireup and derived from the resolved
 *      library manifest.
 *   3. The model may only drive peripherals that exist in the build.
 *
 * The provider is injected (`SketchPlanProvider`) so the pipeline can use the
 * real Bedrock call while offline verification harnesses substitute a canned
 * one. Failure at any layer is reported, never thrown into the artifact path:
 * the caller falls back to `modelCode`/template and the event log says why.
 */

import { z } from 'zod';

import type { ComponentDefinition, ComponentSelection } from '@/types/component';
import type { ProjectRequirements, SoftwarePlan } from '@/types/project';
import type { PinAssignment } from '@/types/wiring';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';
import { runStructuredCall } from '@/lib/bedrock/structured';
import { env } from '@/lib/validation/env';
import { truncate } from '@/lib/validation/json';

import { buildIncludesBlock, buildPinMapBlock, constantName, pinLiteral } from './managed-blocks';
import type { LlmSketchPlan } from './rooting';

/* ------------------------------------------------------------------------- */
/* Request / result types                                                     */
/* ------------------------------------------------------------------------- */

export interface LlmSketchRequest {
  projectName: string;
  projectSummary: string;
  /** The user's original prompt — the behavioural source of truth. */
  prompt: string;
  requirements: ProjectRequirements;
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  assignments: PinAssignment[];
  softwarePlan: SoftwarePlan;
  controllerName: string;
  platformIsEsp32: boolean;
  profile?: McuProfile;
  revision: number;
}

export interface LlmSketchMeta {
  model: string;
  durationMs: number;
  attempts?: number;
  inputTokens?: number;
  outputTokens?: number;
  repaired?: boolean;
}

export type LlmSketchProviderResult =
  | { ok: true; plan: LlmSketchPlan; meta: LlmSketchMeta }
  | { ok: false; error: string; code?: string; meta?: LlmSketchMeta };

/** Anything that can turn a grounded request into a behavioural sketch plan. */
export type SketchPlanProvider = (request: LlmSketchRequest) => Promise<LlmSketchProviderResult>;

/* ------------------------------------------------------------------------- */
/* Schema (tolerant: modelspad fields, numbers as strings, flat functions)     */
/* ------------------------------------------------------------------------- */

const SketchPlanSchema = z.object({
  constants: z
    .array(
      z
        .object({
          name: z.string(),
          value: z.union([z.string(), z.number(), z.boolean()]),
          comment: z.string().optional(),
        })
        .transform((entry) => ({
          name: entry.name,
          value: typeof entry.value === 'boolean' ? (entry.value ? 'true' : 'false') : String(entry.value),
          ...(entry.comment !== undefined ? { comment: entry.comment } : {}),
        })),
    )
    .catch([])
    .default([]),
  globals: z.string().catch('').default(''),
  setup: z.string().catch('').default(''),
  loop: z.string().catch('').default(''),
  functions: z
    .array(
      z.union([
        z.object({ name: z.string().optional(), definition: z.string() }),
        z.string().transform((definition) => ({ name: undefined, definition })),
      ]),
    )
    .catch([])
    .default([]),
  notes: z.array(z.string()).catch([]).default([]),
});

function normalizePlan(raw: z.infer<typeof SketchPlanSchema>): LlmSketchPlan {
  return {
    constants: raw.constants.map((entry) => ({
      name: entry.name,
      value: entry.value,
      ...(entry.comment !== undefined ? { comment: entry.comment } : {}),
    })),
    globals: raw.globals ?? '',
    setup: raw.setup ?? '',
    loop: raw.loop ?? '',
    functions: raw.functions.map((entry) => ({
      name: entry.name ?? functionNameFromDefinition(entry.definition),
      definition: entry.definition,
    })),
    notes: raw.notes ?? [],
  };
}

/**
 * Validate an externally supplied behavioural plan before it reaches the
 * rooting gate. The hardware agent uses this after returning compiler
 * diagnostics to its model, so function-call arguments get the same contract
 * as a dedicated firmware-authoring model response.
 */
export function parseLlmSketchPlan(value: unknown): { ok: true; plan: LlmSketchPlan } | { ok: false; error: string } {
  const parsed = SketchPlanSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `firmware plan did not match the required schema${issue ? ` (${issue.path.join('.') || 'root'}: ${issue.message})` : ''}`,
    };
  }
  return { ok: true, plan: normalizePlan(parsed.data) };
}

function functionNameFromDefinition(definition: string): string {
  const match = /\b(?:[A-Za-z_][A-Za-z0-9_:<>*&\s]*\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(definition);
  return match?.[1] ?? 'modelHelper';
}

/* ------------------------------------------------------------------------- */
/* Prompt                                                                     */
/* ------------------------------------------------------------------------- */

export const SKETCH_PERSONA = `You are the firmware author for Wireup, an agentic embedded-hardware platform.
A deterministic pipeline has already chosen the parts, planned the power budget, assigned every MCU pin and
resolved the libraries. You write ONLY the behavioural logic of the Arduino sketch; Wireup assembles your
sections into the final file and injects the machine-managed includes block and pin map.

THE FIXED CONTEXT IS NOT YOURS TO CHANGE — it is fixed unless the plan itself changes, and the plan only
changes through the deterministic planners:
1. NEVER declare pin constants (no "const int ..._PIN = ...", no "#define ..._PIN ..."). The pin map is
   injected for you. Reference ONLY the PIN_* constants listed below.
2. NEVER write #include. The include block is injected from the resolved library manifest.
3. NEVER pass raw pin numbers to pinMode/digitalWrite/digitalRead/analogRead/analogWrite — use the PIN_*
   constants. LED_BUILTIN is the one allowed literal.
4. Only drive peripherals that appear in the BILL OF MATERIALS below. Never invent sensors, displays or
   buses that the build does not contain.
5. Write logic that compiles as Arduino C++: every identifier you use is either declared by you, injected
   (the PIN_* constants) or part of the Arduino core / the listed libraries. No TODOs, no placeholders.
6. setup and loop fields are BODIES of statements (no "void setup() {" wrapper, no braces of your own).
   Prefer the non-blocking pattern (millis()-based scheduling). Avoid delay() longer than ~20 ms; if the
   brief genuinely needs it, keep it minimal and say why in "notes".
7. Honour the BEHAVIOURAL ASSERTIONS: the firmware is executed against them, and a failed assertion sends
   the sketch to the repair loop.
Answer with JSON ONLY. No markdown fences, no prose before or after, no comments outside string values.`;

const SKETCH_JSON_CONTRACT = `Return a single JSON object with EXACTLY this shape:

{
  "constants": [ { "name": "<identifier>", "value": "<number or token>", "comment": "<optional why>" } ],
  "globals":   "<C++ global declarations: state variables, objects from the listed libraries>",
  "setup":     "<C++ statements: Serial.begin if you use Serial, library init calls, initial pin modes>",
  "loop":      "<C++ statements: the non-blocking main loop>",
  "functions": [ { "name": "<helperName>", "definition": "<complete C++ function definition with body>" } ],
  "notes":     ["<anything the human should know>"]
}

"constants" is for thresholds, timings and state values — never for pins.`;

export function buildSketchUserPrompt(request: LlmSketchRequest): string {
  const parts: string[] = [];

  parts.push('=== PROJECT ===');
  parts.push(`Name: ${request.projectName}`);
  parts.push(`Summary: ${request.projectSummary}`);
  parts.push(`User brief (verbatim):\n"""\n${truncate(request.prompt, 4000)}\n"""`);

  parts.push('');
  parts.push('=== CONTROLLER ===');
  parts.push(`${request.controllerName}${request.profile ? ` — ${request.profile.name}` : ''}`);
  if (request.profile) {
    const notes: string[] = [];
    if (request.profile.i2cRemappable === true) notes.push('I2C is routable to any pin; Wire.begin(SDA, SCL) is injected for you');
    if (request.profile.uarts.length > 0) {
      notes.push(`Hardware UARTs: ${request.profile.uarts.map((uart) => `${uart.id} (${uart.tx}/${uart.rx})`).join(', ')}`);
    }
    if (notes.length > 0) parts.push(notes.map((note) => `- ${note}`).join('\n'));
  }

  parts.push('');
  parts.push('=== PIN MAP (fixed — reference these constants, never declare pins) ===');
  parts.push(buildPinMapBlock(request.assignments, request.profile));

  parts.push('');
  parts.push('=== INCLUDES (fixed — injected for you, do not write #include) ===');
  parts.push(buildIncludesBlock(request.softwarePlan.libraries, request.platformIsEsp32));

  parts.push('');
  parts.push('=== BILL OF MATERIALS (only these peripherals exist) ===');
  for (const selection of request.selections) {
    const definition = request.catalog.find((component) => component.id === selection.componentId);
    const instanceIds = selection.instances.map((instance) => instance.instanceId).join(', ');
    const extras: string[] = [];
    if (definition?.metadata.i2cAddress !== undefined) extras.push(`I2C address ${String(definition.metadata.i2cAddress)}`);
    if (selection.category === 'microcontroller') {
      parts.push(`- ${selection.name} [${selection.category}] instances: ${instanceIds} — the controller itself`);
      continue;
    }
    parts.push(`- ${selection.name} [${selection.category}] instances: ${instanceIds}${extras.length > 0 ? ` (${extras.join(', ')})` : ''}`);
  }

  parts.push('');
  parts.push('=== REQUIREMENTS ===');
  const requirements = request.requirements;
  const bullet = (title: string, items: string[]): string => (items.length > 0 ? `${title}: ${items.join(' | ')}` : '');
  parts.push(
    [
      bullet('Goal', [requirements.goal]),
      bullet('Requirements', requirements.requirements),
      bullet('Behaviours', requirements.behaviors),
      bullet('Inputs', requirements.inputs),
      bullet('Outputs', requirements.outputs),
      bullet('Features', requirements.features),
      bullet('Assumptions', requirements.assumptions),
    ]
      .filter(Boolean)
      .join('\n'),
  );

  parts.push('');
  parts.push('=== SOFTWARE PLAN (your logic implements this) ===');
  parts.push(`Architecture: ${request.softwarePlan.architecture}`);
  parts.push(`Loop strategy: ${request.softwarePlan.loopStrategy}`);
  for (const module of request.softwarePlan.modules) {
    parts.push(`- ${module.name}: ${module.responsibility}`);
  }
  for (const state of request.softwarePlan.controlStates) {
    const transitions = state.transitions.map((transition) => `→${transition.to} when ${transition.when}`).join(' ');
    parts.push(`- state ${state.name}: ${state.description} ${transitions}`.trim());
  }
  if (request.softwarePlan.communication) {
    parts.push(`- communication: ${request.softwarePlan.communication.protocol} over ${request.softwarePlan.communication.transport} — ${request.softwarePlan.communication.details}`);
  }
  for (const line of request.softwarePlan.safety) parts.push(`- safety: ${line}`);

  parts.push('');
  parts.push(SKETCH_JSON_CONTRACT);
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------------- */
/* Bedrock provider                                                           */
/* ------------------------------------------------------------------------- */

/** True when the environment wants the AI-first codegen stage at all. */
export function llmCodegenEnabled(): boolean {
  return env().agent.enableLlmCodegen;
}

/** The real provider: a Bedrock structured call parsed into a sketch plan. */
export function bedrockSketchPlanProvider(): SketchPlanProvider {
  return async (request: LlmSketchRequest): Promise<LlmSketchProviderResult> => {
    const result = await runStructuredCall({
      op: 'codegen',
      system: [SKETCH_PERSONA],
      user: buildSketchUserPrompt(request),
      // Firmware authoring benefits from a little determinism but not zero.
      temperature: 0.2,
    });

    const meta: LlmSketchMeta = {
      model: result.model,
      durationMs: result.durationMs,
      attempts: result.attempts,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      repaired: result.repaired,
    };

    if (!result.ok) {
      return { ok: false, error: result.error ?? 'the model call failed', ...(result.code ? { code: result.code } : {}), meta };
    }

    const parsed = SketchPlanSchema.safeParse(result.payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        error: `the model's sketch plan did not match the contract${issue ? ` (at ${issue.path.join('.') || 'root'}: ${issue.message})` : ''}`,
        code: 'schema_mismatch',
        meta,
      };
    }

    return { ok: true, plan: normalizePlan(parsed.data), meta };
  };
}

/* ------------------------------------------------------------------------- */
/* Conversational firmware editing (the workbench chat)                       */
/* ------------------------------------------------------------------------- */

export interface LlmEditRequest {
  projectName: string;
  /** The full current sketch (rooted form) the edit applies to. */
  currentSketch: string;
  /** The same grounded context as generation, condensed. */
  grounding: string;
  /** The user's instruction for THIS turn. */
  instruction: string;
  /** Previous turns (already trimmed by the caller). */
  recentMessages: { role: 'user' | 'assistant'; text: string }[];
  /** Compiler diagnostics from a previous attempt, when repairing. */
  diagnostics?: string[];
}

export interface LlmEditTurn {
  decision: 'answer' | 'revise';
  reply: string;
  plan?: LlmSketchPlan;
}

const EDIT_PERSONA = `${SKETCH_PERSONA}

You are now in CONVERSATION mode: the user iterates on an existing project with you.
For every turn you first decide:
- "answer" — the question needs no code change (explanations, trade-offs, "what if"). Reply helpfully.
- "revise" — the user asked for a change to the firmware. Return the COMPLETE updated behavioural
  sections for the whole sketch (not just the edited lines): constants, globals, setup, loop, functions.
  Everything not affected by the request must stay exactly as it is — the same pin references, the same
  style, the same variable names unless the change requires otherwise.
The same fixed-context rules apply: no pin declarations, no #include, no raw pin numbers, only the
peripherals that exist. If the request is electrically impossible for this build (a part that is not in
the bill of materials, a pin that does not exist), do not fake it: decide "answer" and explain what the
user would need to change (parts, wiring) for it to work.`;

const EDIT_JSON_CONTRACT = `Return a single JSON object with EXACTLY this shape:

{
  "decision": "answer" | "revise",
  "reply": "<what you tell the user — one short paragraph>",
  "plan": { ... }  // REQUIRED when decision is "revise", same shape as the sketch contract
}`;

export function buildEditUserPrompt(request: LlmEditRequest): string {
  const parts: string[] = [];

  parts.push(`=== PROJECT: ${request.projectName} ===`);
  parts.push(request.grounding);

  parts.push('');
  parts.push('=== CURRENT SKETCH (rooted form — your baseline) ===');
  parts.push('```cpp');
  parts.push(request.currentSketch);
  parts.push('```');

  if (request.recentMessages.length > 0) {
    parts.push('');
    parts.push('=== RECENT CONVERSATION ===');
    for (const message of request.recentMessages) {
      parts.push(`${message.role === 'user' ? 'USER' : 'YOU'}: ${truncate(message.text, 700)}`);
    }
  }

  if (request.diagnostics && request.diagnostics.length > 0) {
    parts.push('');
    parts.push('=== YOUR PREVIOUS VERSION FAILED TO COMPILE — FIX THESE ERRORS ===');
    for (const diagnostic of request.diagnostics.slice(0, 12)) parts.push(`- ${diagnostic}`);
    parts.push('Return the complete corrected plan.');
  }

  parts.push('');
  parts.push('=== USER REQUEST (this turn) ===');
  parts.push(truncate(request.instruction, 4000));

  parts.push('');
  parts.push(EDIT_JSON_CONTRACT);
  return parts.join('\n\n');
}

const EditTurnSchema = z.object({
  decision: z.union([z.literal('answer'), z.literal('revise')]).catch('answer'),
  reply: z.string().catch(''),
  plan: SketchPlanSchema.optional().catch(undefined),
});

/** The result of a conversational edit turn. */
export type LlmEditProviderResult =
  | { ok: false; error: string; code?: string; meta?: LlmSketchMeta }
  | { ok: true; turn: LlmEditTurn; meta: LlmSketchMeta };

/** The provider for workbench chat turns (same 'codegen' model role). */
export function bedrockSketchEditProvider(): (request: LlmEditRequest) => Promise<LlmEditProviderResult> {
  return async (request: LlmEditRequest) => {
    const result = await runStructuredCall({
      op: 'codegen',
      system: [EDIT_PERSONA],
      user: buildEditUserPrompt(request),
      temperature: 0.2,
    });

    const meta: LlmSketchMeta = {
      model: result.model,
      durationMs: result.durationMs,
      attempts: result.attempts,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      repaired: result.repaired,
    };

    if (!result.ok) {
      return { ok: false, error: result.error ?? 'the model call failed', ...(result.code ? { code: result.code } : {}), meta };
    }

    const parsed = EditTurnSchema.safeParse(result.payload);
    if (!parsed.success) {
      return { ok: false, error: "the model's reply did not match the conversation contract", code: 'schema_mismatch', meta };
    }

    const turn: LlmEditTurn = {
      decision: parsed.data.decision,
      reply: parsed.data.reply.trim(),
      ...(parsed.data.plan ? { plan: normalizePlan(parsed.data.plan) } : {}),
    };
    if (turn.decision === 'revise' && !turn.plan) {
      return { ok: false, error: 'the model decided to revise but returned no plan', code: 'schema_mismatch', meta };
    }
    return { ok: true, turn, meta };
  };
}
