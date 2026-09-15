/**
 * Assembly planner — decides the 3D shape of the build.
 *
 * The model authors the shape (vehicle archetype, custom chassis/mounts,
 * which real instance sits where); the resolver grounds it to the diagram and
 * the heuristic fills whatever the model left out. With no model available
 * the heuristic alone still seats every part, so the 3D view never depends
 * on Bedrock being up.
 */

import type { Diagram } from '@/types/diagram';
import type { ResolvedAssemblyPlan } from '@/types/assembly';

import { describeBedrockConfig } from '@/lib/bedrock/client';
import { proposeAssembly } from '@/lib/bedrock/operations';
import { nowIso } from '@/lib/validation/time';

import { describeArchetypes } from './archetypes';
import { inferArchetype, type AssemblyRosterEntry } from './heuristics';
import { heuristicAssembly, resolveAssemblyPlan, rosterEntryFor, type ResolveContext } from './resolve';
import { parseAssemblyProposal } from './schema';

export type AssemblyPlanMode = 'auto' | 'model' | 'heuristic';

export interface PlanAssemblyInput {
  prompt: string;
  goal: string;
  roster: AssemblyRosterEntry[];
  mode?: AssemblyPlanMode;
}

export interface AssemblyCallInfo {
  model: string;
  ok: boolean;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
}

export interface PlanAssemblyResult {
  plan: ResolvedAssemblyPlan;
  call: AssemblyCallInfo | null;
  notes: string[];
}

/** Diagram components that occupy 3D space (wiring media excluded). */
export function rosterFromDiagram(diagram: Diagram): AssemblyRosterEntry[] {
  return diagram.components
    .filter((component) => component.category !== 'prototyping')
    .map((component) =>
      rosterEntryFor(component.id, component.ref, component.name, component.category, component.label),
    );
}

function rosterLine(entry: AssemblyRosterEntry): string {
  const dims = `${entry.dims.w}x${entry.dims.l}x${entry.dims.h}mm`;
  return `- ${entry.id} | ${entry.ref} | ${entry.name} | ${entry.category} | ${dims}`;
}

export async function planAssembly(input: PlanAssemblyInput): Promise<PlanAssemblyResult> {
  const notes: string[] = [];
  const context: ResolveContext = {
    roster: input.roster,
    prompt: input.prompt,
    goal: input.goal,
    now: nowIso(),
  };
  const mode = input.mode ?? 'auto';

  if (mode === 'heuristic') {
    return { plan: heuristicAssembly(context), call: null, notes };
  }

  const bedrock = await describeBedrockConfig();
  if (!bedrock.configured) {
    const plan = heuristicAssembly(context);
    plan.notes.push(
      `No model available (${bedrock.problem ?? 'Bedrock not configured'}) — deterministic shape.`,
    );
    return { plan, call: null, notes };
  }

  const guess = inferArchetype(input.roster, input.prompt);
  const startedAt = Date.now();
  try {
    const response = await proposeAssembly({
      goal: input.goal,
      promptExcerpt: input.prompt.slice(0, 1200),
      rosterLines: input.roster.map(rosterLine),
      heuristicHint: `${guess.archetype} (${guess.reason})`,
      archetypeCatalog: describeArchetypes(),
    });
    const call: AssemblyCallInfo = {
      model: response.model,
      ok: response.ok,
      ...(response.error ? { error: response.error } : {}),
      ...(response.usage.inputTokens !== undefined ? { inputTokens: response.usage.inputTokens } : {}),
      ...(response.usage.outputTokens !== undefined ? { outputTokens: response.usage.outputTokens } : {}),
      durationMs: Date.now() - startedAt,
    };
    if (!response.ok || response.payload === undefined) {
      const plan = heuristicAssembly(context);
      plan.notes.push(`Model shape unavailable (${response.error ?? 'unparsable payload'}) — deterministic shape.`);
      return { plan, call, notes };
    }
    const proposal = parseAssemblyProposal(response.payload);
    if (!proposal) {
      const plan = heuristicAssembly(context);
      plan.notes.push('Model shape did not match the assembly contract — deterministic shape.');
      return { plan, call: { ...call, ok: false, error: 'proposal failed schema validation' }, notes };
    }
    const { plan } = resolveAssemblyPlan(proposal, context);
    return { plan, call, notes };
  } catch (error) {
    const plan = heuristicAssembly(context);
    const message = error instanceof Error ? error.message : String(error);
    plan.notes.push(`Model shape call threw (${message}) — deterministic shape.`);
    return {
      plan,
      call: { model: bedrock.model ?? 'unknown', ok: false, error: message, durationMs: Date.now() - startedAt },
      notes,
    };
  }
}

export { getArchetypeBase, normaliseArchetypeId, ASSEMBLY_ARCHETYPE_IDS, type AssemblyArchetypeId } from './archetypes';
export {
  bindRoles,
  dimsFor,
  inferArchetype,
  isDriveMotor,
  isPropeller,
  labelFor,
  type AssemblyRosterEntry,
  type ArchetypeGuess,
} from './heuristics';
export {
  heuristicAssembly,
  pruneAssemblyToIds,
  resolveAssemblyPlan,
  rosterEntryFor,
  translateAssemblyForVlx,
  type ResolveContext,
} from './resolve';
export { ASSEMBLY_ROLES, AssemblyProposalSchema, parseAssemblyProposal, type AssemblyProposal } from './schema';
