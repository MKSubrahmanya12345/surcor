/**
 * The Bedrock operations exposed to the orchestrator.
 *
 * CALL 1 — GENERATION  : generateProjectSpec()
 * CALL 2 — VALIDATION  : reviewProject()
 * FIX (agentic loop)   : proposeFixChanges()
 *
 * Each returns an already JSON-parsed payload plus transport metadata. Payload
 * *interpretation* belongs to the modules that own the data.
 */

import {
  ASSEMBLY_PERSONA,
  buildAssemblyUserPrompt,
  buildFixUserPrompt,
  buildGenerationUserPrompt,
  buildIntakeUserPrompt,
  buildValidationUserPrompt,
  ENGINEER_PERSONA,
  type AssemblyPromptInput,
  type FixPromptInput,
  type GenerationPromptInput,
  type IntakePromptInput,
  type ValidationPromptInput,
} from '@/lib/bedrock/prompts';
import { runStructuredCall, type StructuredCallResult } from '@/lib/bedrock/structured';
import type { BedrockOp } from '@/lib/bedrock/client';
import { defaultEffort, parseEffort } from '@/lib/models';
import { env } from '@/lib/validation/env';

export interface BedrockOperationResult extends StructuredCallResult {
  op: BedrockOp;
}

const VALIDATOR_PERSONA = `You are a ruthless but fair hardware design reviewer on the Wireup platform.
You audit generated embedded projects the way a senior engineer audits a design review package:
component selection, electrical compatibility, pin usage, power budget, wiring completeness,
firmware correctness and documentation consistency. You never rubber-stamp, and you never invent problems.
Answer with JSON ONLY.`;

const FIXER_PERSONA = `You are the Wireup repair agent. You receive a broken artifact plus the exact
validation issues and you emit the SMALLEST possible set of typed changes that fixes them.
You never regenerate a project, never touch unrelated artifacts, and never change ids you were not asked to change.
Answer with JSON ONLY.`;

/** CALL 1 — full project generation. */
export async function generateProjectSpec(input: GenerationPromptInput): Promise<BedrockOperationResult> {
  const result = await runStructuredCall({
    op: 'generation',
    system: [ENGINEER_PERSONA],
    user: buildGenerationUserPrompt(input),
    effort: defaultEffort('generation'),
  });
  return { ...result, op: 'generation' };
}

/** CALL 2 — critical validation review. */
export async function reviewProject(input: ValidationPromptInput): Promise<BedrockOperationResult> {
  const result = await runStructuredCall({
    op: 'validation',
    system: [ENGINEER_PERSONA, VALIDATOR_PERSONA],
    user: buildValidationUserPrompt(input),
    // Validation output is small; a lower temperature keeps it consistent.
    temperature: 0,
    effort: parseEffort(env().models.effortValidation, defaultEffort('validation')),
  });
  return { ...result, op: 'validation' };
}

export interface FirmwareReviewPromptInput {
  prompt: string;
  controller: string;
  entryPoint: string;
  files: { path: string; content: string }[];
  pinAssignments: unknown;
  libraries: string[];
}

/** A focused, one-time firmware review before the simulation assets are built. */
export async function reviewFirmware(input: FirmwareReviewPromptInput): Promise<BedrockOperationResult> {
  const user = `USER REQUEST:\n${input.prompt}\n\nCONTROLLER: ${input.controller}\nENTRY POINT: ${input.entryPoint}\nLIBRARIES: ${input.libraries.join(', ') || 'none'}\nPIN ASSIGNMENTS:\n${JSON.stringify(input.pinAssignments, null, 2)}\n\nFIRMWARE FILES:\n${input.files.map((file) => `--- ${file.path} ---\n${file.content}`).join('\n')}\n\nReview only the firmware. Check compilation risks for the controller, setup/loop, assigned pins, required libraries, bus/serial initialization, and obvious runtime faults. Return JSON ONLY: {"verdict":"approve"|"needs_changes","issues":[{"file":"...","line":0,"severity":"error"|"warning","message":"..."}],"notes":["..."]}. Report only concrete issues.`;
  const result = await runStructuredCall({
    op: 'firmware_review',
    system: ['You are a senior embedded firmware reviewer. Be concrete and adversarial, but never invent issues. Answer JSON ONLY.'],
    user,
    temperature: 0,
    effort: parseEffort(env().models.effortValidation, defaultEffort('validation')),
  });
  return { ...result, op: 'firmware_review' };
}

/** Targeted fix — produces a changeset, never a new project. */
export async function proposeFixChanges(input: FixPromptInput): Promise<BedrockOperationResult> {
  const result = await runStructuredCall({
    op: 'fix',
    system: [ENGINEER_PERSONA, FIXER_PERSONA],
    user: buildFixUserPrompt(input),
    temperature: 0.1,
    effort: parseEffort(env().models.effortFix, defaultEffort('fix')),
  });
  return { ...result, op: 'fix' };
}

/** CALL 0 — intake: the doubt session. Names the project and finds the real forks. */
const INTAKE_PERSONA = `You are the Wireup intake agent. Nothing is being built yet.
You name the project, list the doubts that genuinely need the human (or a recorded
decision), and extract the stated facts. You never design, never pick parts and
never answer the user's own questions for them. Answer with JSON ONLY.`;

export async function proposeIntake(input: IntakePromptInput): Promise<BedrockOperationResult> {
  const result = await runStructuredCall({
    op: 'intake',
    system: [ENGINEER_PERSONA, INTAKE_PERSONA],
    user: buildIntakeUserPrompt(input),
    temperature: 0.2,
    effort: defaultEffort('intake'),
  });
  return { ...result, op: 'intake' };
}

/* ------------------------------------------------------------------------- */
/* Idea graph — expansion (R2 decision power + child proposals) and review     */
/* ------------------------------------------------------------------------- */

const EXPANSION_PERSONA = `You are the Wireup decomposition agent. You receive ONE node of a hardware
project's idea graph and propose its NEXT level of children: responsibilities, not parts.
Rules:
  • every child carries a goal a machine can test and a concrete test;
  • never restate a sibling already listed under the same parent;
  • power, actuator and radio children are stakes:"risk_gated";
  • when the node is strategic (no child would change a part, pin, wire,
    line of code or test), return children: [].
Answer with JSON ONLY.`;

export interface ExpansionPromptInput {
  nodeLabel: string;
  nodeContent: string;
  nodeLevel: number;
  projectClass: string;
  prompt: string;
  brief: string;
  existingLabels: string[];
}

export async function proposeExpansion(input: ExpansionPromptInput): Promise<BedrockOperationResult> {
  const user = [
    `PROJECT CLASS: ${input.projectClass}`,
    `ORIGINAL BRIEF: ${input.prompt}`,
    input.brief ? `PROJECT BRIEF (state summary):\n${input.brief.slice(0, 4000)}` : '',
    `NODE TO EXPAND (level ${input.nodeLevel}): ${input.nodeLabel}`,
    `NODE DETAIL: ${input.nodeContent}`,
    input.existingLabels.length > 0 ? `ALREADY IN THE GRAPH (never restate): ${input.existingLabels.join(', ')}` : '',
    `Return JSON: {"children": [{"label": str (<=40 chars), "content": str, "goal": str (a testable completion criterion), "subsystemClass": one of POWER|DRIVE|STEERING|CONTROL_LINK|SENSING|BRAIN|STRUCTURE|SAFETY|OUTPUT|OTHER, "stakes": "normal"|"risk_gated", "test": {"rung": one of catalog|electrical|compile|behavioral|rooting|human_verify, "assertion": str}}]}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const result = await runStructuredCall({
    op: 'idea_expansion',
    system: [ENGINEER_PERSONA, EXPANSION_PERSONA],
    user,
    temperature: 0.2,
    effort: parseEffort(env().models.effortExpansion, defaultEffort('idea_expansion')),
  });
  return { ...result, op: 'idea_expansion' };
}

/** R2 — one cheap call: would any child change a downstream action? */
export async function proposeDecisionPower(input: { nodeLabel: string; nodeContent: string; realization: string }): Promise<BedrockOperationResult> {
  const user = [
    `NODE: ${input.nodeLabel}`,
    `DETAIL: ${input.nodeContent}`,
    `CURRENT REALIZATION: ${input.realization}`,
    `Question: if you expanded this node one level deeper, would ANY child change a downstream action — a part selection, a pin, a wire, a line of firmware, or a test?`,
    `Answer with JSON ONLY: {"changes": true|false, "reason": str (<=200 chars)}`,
  ].join('\n');
  const result = await runStructuredCall({
    op: 'idea_expansion',
    system: [ENGINEER_PERSONA, EXPANSION_PERSONA],
    user,
    temperature: 0,
    maxTokens: 300,
    effort: parseEffort(env().models.effortR2, defaultEffort('idea_r2')),
  });
  return { ...result, op: 'idea_expansion' };
}

/** 3D assembly — the model authors the shape the parts assemble into. */
export async function proposeAssembly(input: AssemblyPromptInput): Promise<BedrockOperationResult> {
  const result = await runStructuredCall({
    op: 'assembly',
    system: [ENGINEER_PERSONA, ASSEMBLY_PERSONA],
    user: buildAssemblyUserPrompt(input),
    temperature: 0.2,
    effort: defaultEffort('assembly'),
  });
  return { ...result, op: 'assembly' };
}

/** The fresh-context reviewer (Part of the idea graph): brief + graph + test results ONLY. */
export async function proposeIdeaReview(input: { reviewDocument: string }): Promise<BedrockOperationResult> {
  const result = await runStructuredCall({
    op: 'idea_review',
    system: [
      'You are the Wireup fresh-context reviewer. You receive ONLY the project brief, the idea graph and its test results — never the builder\'s reasoning. Your job: would this build work? Is any goal unproven, any test self-serving, any assumption hiding? You never edit; you return findings. Answer with JSON ONLY.',
    ],
    user: input.reviewDocument,
    temperature: 0,
    effort: parseEffort(env().models.effortReview, defaultEffort('idea_review')),
  });
  return { ...result, op: 'idea_review' };
}
