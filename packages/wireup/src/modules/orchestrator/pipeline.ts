/**
 * Generation pipeline — FIXED WATERFALL (not agentic graph traversal).
 *
 * Runs the stages in strict dependency order, one event + one persistence hook per
 * stage, so the UI always sees real progress:
 *
 *   understand → catalog → generation call → requirements → hardware →
 *   pins → wiring → software → code → libraries → diagram → instructions
 *
 * This is a LINEAR pipeline, not a graph. The "agent traverses a graph" concept
 * only applies to Everflow, which operates AFTER v1 generation is complete.
 *
 * Every stage has a deterministic fallback: if Bedrock is unavailable (or its
 * JSON is unusable) the planners still produce a complete, wired project from
 * the catalog. The model refines; it never owns correctness.
 *
 * NOTE: The ReAct tool-calling loop runs INSIDE the hardware stage (via
 * runHardwareAgent), not across stages. The stage sequence itself is fixed.
 */

import type { AgentEventLog } from '@/lib/logging/events';
import type {
  CodeArtifact,
  HardwarePlan,
  InstructionsArtifact,
  LibrariesArtifact,
  LlmCallRecord,
  ProjectArtifacts,
  ProjectState,
  SoftwarePlan,
} from '@/types/project';
import type { WiringPlan } from '@/types/wiring';
import type { Diagram } from '@/types/diagram';
import type { GenerationStage } from '@/types/project';
import type { ProjectPatch } from '@/lib/mongodb/projects';
import type { PromptAnalysis } from '@/modules/project-understanding/heuristics';

import { describeBedrockConfig, generateProjectSpec } from '@/lib/bedrock';
import { createId } from '@/lib/validation/ids';
import { asRecord, truncate } from '@/lib/validation/json';
import { describeError, logger } from '@/lib/logging/logger';
import { nowIso } from '@/lib/validation/time';

import { normalizeRequirements, understandPrompt } from '@/modules/project-understanding';
import { formatAnalysisForPrompt } from '@/modules/project-understanding/heuristics';
import { planHardware } from '@/modules/hardware-planner';
import { planSoftware } from '@/modules/software-planner';
import { generateCode } from '@/modules/code-generator';
import { planAssembly, rosterFromDiagram } from '@/modules/assembly-planner';
import { runHardwareAgent } from '@/modules/agent';
import { buildGenerationContext, controllerInfo, type GenerationContext } from './context';

export interface PipelineInput {
  project: ProjectState;
  events: AgentEventLog;
  /** Persisted after every stage so the UI can render partial results. */
  onStage?: (patch: ProjectPatch, stage: GenerationStage) => Promise<void> | void;
}

export interface PipelineOutput {
  project: ProjectState;
  context: GenerationContext;
  analysis: PromptAnalysis;
  llmCalls: LlmCallRecord[];
  notes: string[];
}

const EMPTY_ARTIFACTS: ProjectArtifacts = { code: null, diagram: null, libraries: null, instructions: null };

/** Fields the pipeline is allowed to persist mid-run (never dates/events). */
type StagePatch = Partial<
  Pick<
    ProjectState,
    | 'name'
    | 'status'
    | 'stage'
    | 'requirements'
    | 'components'
    | 'hardwarePlan'
    | 'pinAssignments'
    | 'wiring'
    | 'softwarePlan'
    | 'assembly'
    | 'artifacts'
    | 'llm'
    | 'revision'
    | 'iteration'
  >
>;

/** The prompt the model sees: the user's words plus the resolved doubt-session context. */
function effectivePrompt(base: ProjectState): string {
  return base.intakeContext ? `${base.prompt}

${base.intakeContext}` : base.prompt;
}

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const { events, onStage } = input;
  const base = input.project;
  const notes: string[] = [];
  const llmCalls: LlmCallRecord[] = [];

  let state: ProjectState = { ...base, stage: 'understanding', status: 'running' };
  let artifacts: ProjectArtifacts = { ...EMPTY_ARTIFACTS };

  const stage = async (patch: StagePatch, next: GenerationStage): Promise<void> => {
    state = { ...state, ...patch, stage: next };
    if (!onStage) return;
    try {
      await onStage({ ...patch, stage: next } as ProjectPatch, next);
    } catch (error) {
      // A failed progress write must not abort generation; the final save will.
      logger.warn({ err: error, projectId: base.id, stage: next }, 'stage progress write failed');
    }
  };

  const pipelineHandle = events.start('generation_started', `Generation started for "${truncate(base.prompt, 120)}"`, {
    stage: 'generating',
    metadata: { projectId: base.id, promptLength: base.prompt.length },
  });

  /* --- 1. Understand the request ------------------------------------------ */
  const requirementsHandle = events.start('requirements_started', 'Reading the request and extracting requirements...', {
    stage: 'understanding',
  });
  const understanding = understandPrompt(effectivePrompt(base), events);
  const analysis = understanding.analysis;
  let requirements = understanding.requirementsDraft;

  requirementsHandle.complete(
    `Requirements extracted — ${requirements.requirements.length} requirement(s), ${requirements.features.length} feature(s)${
      requirements.ambiguities.length > 0 ? `, ${requirements.ambiguities.length} ambiguity(ies)` : ''
    }.`,
    {
      goal: requirements.goal,
      features: requirements.features,
      quantities: requirements.quantities,
      detectedPlatform: requirements.detectedPlatform ?? null,
      assumptions: requirements.assumptions.length,
      ambiguities: requirements.ambiguities.length,
    },
  );
  notes.push(...analysis.notes);
  await stage({ requirements, status: 'running' }, 'understanding');

  /* --- 2. Component database ---------------------------------------------- */
  const context = await buildGenerationContext({ prompt: effectivePrompt(base), analysis, events });
  const catalog = context.catalog;
  notes.push(...context.notes);
  await stage({}, 'catalog');

  /* --- 3. Generation call (CALL 1) ---------------------------------------- */
  const bedrock = await describeBedrockConfig();
  let modelPayload: Record<string, unknown> = {};

  if (bedrock.configured) {
    const startedAt = Date.now();
    const call: LlmCallRecord = {
      id: createId('llm'),
      op: 'generation',
      model: bedrock.model ?? 'unknown',
      startedAt: nowIso(),
      status: 'failed',
      iteration: 0,
    };
    const handle = events.start('llm_call_started', `Calling ${call.model} to design the project...`, {
      stage: 'generating',
      metadata: { op: 'generation', model: call.model },
    });

    try {
      const response = await generateProjectSpec({
        prompt: effectivePrompt(base),
        requirementsDraft: `${formatAnalysisForPrompt(analysis)}\n\n${truncate(JSON.stringify(requirements, null, 2), 4000)}`,
        catalogContext: context.catalogContext,
        mcuContext: context.mcuContext,
        extraGuidance:
          analysis.notes.length > 0 ? `Heuristic notes to verify: ${analysis.notes.join(' ')}` : undefined,
      });

      call.model = response.model;
      call.finishedAt = nowIso();
      call.durationMs = Date.now() - startedAt;
      call.inputTokens = response.usage.inputTokens;
      call.outputTokens = response.usage.outputTokens;

      if (response.ok && response.payload !== undefined) {
        call.status = 'ok';
        modelPayload = asRecord(response.payload);
        handle.complete(`Model design received (${response.raw.length} characters of JSON${response.repaired ? ', repaired' : ''}).`, {
          op: 'generation',
          model: response.model,
          repaired: response.repaired,
          attempts: response.attempts,
          inputTokens: response.usage.inputTokens ?? 0,
          outputTokens: response.usage.outputTokens ?? 0,
          keys: Object.keys(modelPayload),
        });
      } else {
        call.status = 'failed';
        call.error = response.error ?? 'unparsable payload';
        handle.fail(
          `Model design unavailable (${call.error}) — continuing with the deterministic planners.`,
          response.error,
          { op: 'generation', model: response.model },
        );
        notes.push(`Generation model call failed (${call.error}); the project was built deterministically from the catalog.`);
      }
    } catch (error) {
      const described = describeError(error);
      call.status = 'failed';
      call.error = described.message;
      call.finishedAt = nowIso();
      call.durationMs = Date.now() - startedAt;
      handle.fail(`Model design call threw: ${described.message} — continuing deterministically.`, described.message, { op: 'generation' });
      notes.push(`Generation model call threw (${described.message}); the project was built deterministically from the catalog.`);
    }

    llmCalls.push(call);
    await stage({ llm: { model: call.model, validationModel: bedrock.validationModel, calls: llmCalls } }, 'generating');
  } else {
    events.emit('info', `Amazon Bedrock is not configured${bedrock.problem ? ` (${bedrock.problem})` : ''} — building the project deterministically from the catalog.`, {
      stage: 'generating',
      metadata: { reason: bedrock.problem ?? 'not configured' },
    });
    notes.push('Bedrock is not configured; the project was built deterministically from the catalog.');
  }

  /* --- 4. Requirements (model + heuristics merged) ------------------------- */
  requirements = normalizeRequirements(modelPayload.requirements, {
    prompt: effectivePrompt(base),
    analysis,
    draft: understanding.requirementsDraft,
  });
  const projectName = pickProjectName(modelPayload.project, requirements, base);
  await stage({ requirements, name: projectName }, 'understanding');

  /* --- 5. Hardware Stage (ReAct loop + deterministic fallback) ------------
   *
   * This stage runs the autonomous hardware agent which combines:
   *   a) A ReAct tool-calling loop (up to 12 turns) for dynamic component
   *      selection, pin assignment, wiring, and code generation;
   *   b) A deterministic fallback that guarantees completion if the ReAct
   *      loop exits early (partial completion, timeout, or exception).
   *
   * The fallback checks for COMPLETENESS not just presence — if the ReAct
   * loop selected 2 of 5 required components, the fallback fills the gap.
   *
   * NOTE: This is still ONE STAGE in the linear pipeline. The agent does NOT
   * traverse the pipeline stages as a graph — that only happens in Everflow.
   */
  const agentRun = await runHardwareAgent({
    prompt: effectivePrompt(base),
    projectName,
    requirements,
    analysis,
    catalog,
    events,
  });

  const { blackboard } = agentRun;

  /*
   * The completeness promise, enforced here: a build that reaches validation
   * ALWAYS carries firmware. The agent runner synthesises a sketch even when
   * its tools fail, but the old `blackboard.code || { files: [], ... }`
   * fallback shipped an empty artifact whenever anything slipped past it —
   * which then failed the CodeArtifact schema AND "no firmware source" in
   * validation, with a fixer that had no repair for either. Regenerate
   * deterministically instead; only a genuinely broken catalog skips this.
   */
  if (!blackboard.code || blackboard.code.files.length === 0) {
    const rescueHandle = events.start('code_generation_started', 'Regenerating the firmware the agent left missing...', {
      stage: 'code',
    });
    try {
      const controllerSel = blackboard.selections.find((s) => s.category === 'microcontroller');
      const controllerDef = catalog.find((c) => c.id === controllerSel?.componentId);
      const softwarePlan =
        blackboard.softwarePlan ??
        planSoftware({
          requirements,
          selections: blackboard.selections,
          catalog: blackboard.workingCatalog,
          assignments: blackboard.pinAssignments,
          serialLinks: blackboard.serialLinks ?? [],
          i2cBuses: blackboard.i2cBuses ?? [],
          controllerInstanceId: controllerSel?.instances[0]?.instanceId,
          controllerComponentId: controllerSel?.componentId,
          events,
        });
      blackboard.softwarePlan = softwarePlan;
      blackboard.code = await generateCode({
        projectName,
        projectSummary: requirements.summary,
        requirements,
        selections: blackboard.selections,
        catalog: blackboard.workingCatalog,
        assignments: blackboard.pinAssignments,
        serialLinks: blackboard.serialLinks ?? [],
        i2cBuses: blackboard.i2cBuses ?? [],
        softwarePlan,
        controllerName: controllerDef?.name ?? 'Arduino',
        revision: 1,
        prompt: effectivePrompt(base),
        events,
      });
      rescueHandle.complete(`Firmware regenerated deterministically — ${blackboard.code.files.length} file(s).`);
      notes.push('The agent stage produced no firmware; the sketch was regenerated deterministically before validation.');
    } catch (error) {
      const described = describeError(error);
      rescueHandle.fail(`Firmware regeneration failed: ${described.message} — validation's fix loop will retry.`, described.message, {
        stage: 'code',
      });
      notes.push(`Firmware regeneration failed (${described.message}); validation's fix loop will retry.`);
    }
  }
  const selections = blackboard.selections;
  const hardwarePlan: HardwarePlan = blackboard.hardwarePlan || {
    summary: requirements.summary,
    architecture: [],
    controller: null,
    power: { rails: [], adequate: true, notes: [] },
    subsystems: [],
    signalFlow: [],
    compatibility: [],
    supportingComponents: [],
    risks: [],
  };
  const assignments = blackboard.pinAssignments;
  const wiring: WiringPlan = blackboard.wiring || {
    connections: [],
    conflicts: [],
    nets: [],
    notes: [],
    generatedAt: nowIso(),
  };
  const softwarePlan: SoftwarePlan = blackboard.softwarePlan || {
    architecture: 'Layered',
    language: 'arduino-cpp',
    modules: [],
    libraries: [],
    controlStates: [],
    inputHandling: [],
    sensorLogic: [],
    actuatorLogic: [],
    communication: null,
    safety: [],
    loopStrategy: 'non_blocking',
    files: [{ path: 'sketch.ino', purpose: 'Main sketch' }],
  };
  const code: CodeArtifact = blackboard.code || {
    files: [],
    entryPoint: 'sketch.ino',
    pinsSynchronised: true,
    notes: [],
  };
  const libraries: LibrariesArtifact = blackboard.libraries || {
    libraries: [],
    installCommands: [],
    notes: [],
    generatedAt: nowIso(),
  };
  const diagram: Diagram = blackboard.diagram || {
    version: '1.0',
    format: 'wireup-diagram',
    generator: 'Wireup Agent',
    createdAt: nowIso(),
    projectId: base.id,
    revision: 1,
    meta: {
      title: projectName,
      description: requirements.summary,
      simulatorTarget: 'wokwi',
      units: 'px',
      gridSize: 10,
    },
    components: [],
    connections: [],
    rails: [],
    groups: [],
    layout: { width: 800, height: 600, columns: 8, rows: 6 },
    stats: {
      components: 0,
      connections: 0,
      powerConnections: 0,
      groundConnections: 0,
      signalConnections: 0,
      pins: 0,
    },
  };
  const instructions: InstructionsArtifact = blackboard.instructions || {
    markdown: '',
    sections: [],
    billOfMaterials: [],
    estimatedBuildTimeMinutes: 30,
    generatedAt: nowIso(),
  };

  artifacts = { code, diagram, libraries, instructions };
  notes.push(...blackboard.notes);

  await stage({ components: selections, hardwarePlan }, 'hardware');
  await stage({ pinAssignments: assignments }, 'pins');
  await stage({ wiring }, 'wiring');
  await stage({ softwarePlan }, 'software');
  /*
   * The agent builds code/libraries/diagram/instructions in one shot, but the
   * documented waterfall (and the UI progress rail) has a stage per artifact —
   * skipping straight to 'instructions' left 'code', 'libraries' and 'diagram'
   * never emitted. Persist the artifacts once, then advance stage-only.
   */
  await stage({ artifacts }, 'code');
  await stage({}, 'libraries');
  await stage({}, 'diagram');

  /* --- 6. 3D assembly (the model authors the shape, with a deterministic
   * fallback) ---------------------------------------------------------------
   *
   * Needs the diagram's instance ids, so it runs after the agent stage. A
   * failure here never fails the build: the bench grid is the honest
   * fallback, and the event log says the assembly was skipped.
   */
  const assemblyHandle = events.start('assembly_started', 'Deciding the 3D shape of the build...', {
    stage: 'assembly',
  });
  let assembly: ProjectState['assembly'] = null;
  try {
    const roster = rosterFromDiagram(diagram);
    if (roster.length === 0) {
      assemblyHandle.complete('No seatable parts — skipping the 3D assembly.', { parts: 0 });
    } else {
      const callStarted = nowIso();
      const startedAt = Date.now();
      const result = await planAssembly({ prompt: effectivePrompt(base), goal: requirements.goal, roster });
      assembly = result.plan;
      if (result.call) {
        llmCalls.push({
          id: createId('llm'),
          op: 'assembly',
          model: result.call.model,
          startedAt: callStarted,
          finishedAt: nowIso(),
          durationMs: Date.now() - startedAt,
          status: result.call.ok ? 'ok' : 'failed',
          ...(result.call.inputTokens !== undefined ? { inputTokens: result.call.inputTokens } : {}),
          ...(result.call.outputTokens !== undefined ? { outputTokens: result.call.outputTokens } : {}),
          ...(result.call.error ? { error: result.call.error } : {}),
          iteration: 0,
        });
      }
      const seated = Object.keys(assembly.placements).length + assembly.parametric.length;
      const extras = assembly.parametricRoles?.length ?? 0;
      assemblyHandle.complete(
        `Assembled as ${assembly.label} — ${seated} of ${roster.length} part(s) seated` +
          `${extras > 0 ? ` + ${extras} parametric extra(s) (wheels/caster/props)` : ''}` +
          ` (${assembly.source}).`,
        {
          archetype: assembly.archetype,
          source: assembly.source,
          seated,
          total: roster.length,
          ...(extras > 0 ? { parametricExtras: extras } : {}),
          warnings: assembly.warnings.length,
        },
      );
      if (assembly.warnings.length > 0) {
        notes.push(`3D assembly warnings: ${assembly.warnings.slice(0, 3).join(' ')}`);
      }
    }
  } catch (error) {
    const described = describeError(error);
    assemblyHandle.fail(
      `3D assembly failed (${described.message}) — the default bench layout still applies.`,
      described.message,
      { stage: 'assembly' },
    );
    notes.push(`3D assembly failed (${described.message}); the build renders in the default bench layout.`);
  }
  if (llmCalls.some((call) => call.op === 'assembly')) {
    await stage(
      {
        assembly,
        llm: { model: state.llm?.model ?? bedrock.model ?? 'unknown', validationModel: bedrock.validationModel, calls: llmCalls },
      },
      'assembly',
    );
  } else {
    await stage({ assembly }, 'assembly');
  }
  await stage({}, 'instructions');

  /* --- Done --------------------------------------------------------------- */
  state = {
    ...state,
    name: projectName,
    requirements,
    components: selections,
    hardwarePlan,
    pinAssignments: assignments,
    wiring,
    softwarePlan,
    artifacts,
    revision: 1,
    stage: 'validating',
    status: 'validating',
    iteration: { current: 0, max: state.iteration.max },
    llm: {
      ...(bedrock.model ? { model: bedrock.model } : {}),
      ...(bedrock.validationModel ? { validationModel: bedrock.validationModel } : {}),
      calls: llmCalls,
    },
    updatedAt: nowIso(),
  };

  pipelineHandle.complete(
    `Initial build complete — ${selections.length} part(s), ${assignments.length} pin assignment(s), ${wiring.connections.length} wire(s), ${code.files.length} file(s).`,
    {
      parts: selections.length,
      instances: selections.reduce((sum, selection) => sum + selection.instances.length, 0),
      assignments: assignments.length,
      connections: wiring.connections.length,
      conflicts: wiring.conflicts.length,
      files: code.files.length,
      libraries: libraries.libraries.length,
      diagramComponents: diagram.stats.components,
      instructionSections: instructions.sections.length,
    },
  );

  return { project: state, context, analysis, llmCalls, notes: [...new Set(notes)] };
}

/** The model may name the project; otherwise derive one from the goal. */
/**
 * A project NAME is not a log line. `truncate()` from validation/json is for
 * display text (it appends a newline + "… [truncated N characters]"), and
 * that marker used to land in the name — which then flowed into the sketch
 * header, string constants and coverage corpora, where the non-ASCII ellipsis
 * is a firmware compile error. Names are cut cleanly at a word boundary with
 * a plain ASCII ellipsis instead.
 */
function nameTruncate(value: string, max = 80): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const head = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${head.replace(/[,;:.\s]+$/, '')}...`;
}

function pickProjectName(raw: unknown, requirements: ProjectState['requirements'], base: ProjectState): string {
  const record = asRecord(raw);
  const modelName = typeof record.name === 'string' ? record.name.trim() : '';
  if (modelName.length > 0) return nameTruncate(modelName, 80);
  if (base.name && base.name !== 'Untitled project') return base.name;
  const goal = requirements?.goal?.trim();
  if (goal && goal.length > 0) return nameTruncate(goal.replace(/\.$/, ''), 80);
  return nameTruncate(base.prompt.split('\n')[0] ?? 'Wireup project', 80);
}
