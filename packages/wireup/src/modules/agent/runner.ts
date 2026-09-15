/**
 * AGENT RUNNER — AUTONOMOUS HARDWARE REASONING AND TOOL EXECUTION.
 *
 * The model is allowed to choose between catalog-backed engineering actions;
 * deterministic tools remain the authority for the circuit, pins, wiring and
 * artifacts. A provider failure or an early model exit therefore never leaves
 * a partially-mutated blackboard masquerading as a finished build.
 *
 * Two model transports are supported for the ReAct/tool loop:
 *   - Bedrock Converse (the established default);
 *   - GPT-6 Astra through OpenAI Responses when a matching direct key exists.
 *
 * Both are normalized behind `AgentModelDriver`, so provider protocol details
 * cannot leak into the engineering tools or the deterministic fallback.
 */

import type { ContentBlock, Message, Tool } from '@aws-sdk/client-bedrock-runtime';

import type { AgentEventLog } from '@/lib/logging/events';
import type { ComponentDefinition, ComponentSelection } from '@/types/component';
import type { ProjectRequirements } from '@/types/project';
import type { PromptAnalysis } from '@/modules/project-understanding/heuristics';
import { converseRaw, describeBedrockConfig, resolveModel } from '@/lib/bedrock';
import {
  astraDirectAvailable,
  attachToolResult,
  callAstraToolTurn,
  defaultEffort,
  detectModelFamily,
  isAstraModel,
  isDirectAstraModelId,
  registerAsyncTool,
} from '@/lib/models';
import { logger } from '@/lib/logging/logger';
import { nowIso } from '@/lib/validation/time';

import type {
  AgentBlackboard,
  AgentModelDriver,
  AgentModelToolCall,
  AgentModelToolOutput,
  AgentModelTurn,
  AgentStepRecord,
  AgentTool,
  AgentToolContext,
  AgentToolResult,
  AgentToolSchema,
} from './types';
import { ALL_AGENT_TOOLS, synchroniseHardwarePlan } from './tools';

const MAX_MODEL_TURNS = 12;
const MAX_MODEL_TOOL_CALLS = 32;
const MAX_TOOL_RESULT_CHARS = 12_000;

/** Component vocabulary differs from product vocabulary ("sound" is a
 * buzzer, "display" may be an OLED). These aliases only improve the advisory
 * completeness note; the deterministic planner remains the authority. */
const COVERAGE_ALIASES: Record<string, string[]> = {
  sound: ['buzzer', 'piezo', 'speaker', 'alarm', 'siren'],
  display: ['oled', 'lcd', 'screen', 'tft'],
  temperature: ['dht', 'bme', 'ds18', 'thermistor'],
  humidity: ['dht', 'bme', 'hygro'],
  temperature_humidity: ['dht', 'bme'],
  distance: ['ultrasonic', 'hc-sr04', 'vl53'],
  lighting: ['led', 'neopixel', 'lamp'],
  motor: ['dc', 'servo', 'stepper', 'l298', 'tb6612'],
  communication: ['bluetooth', 'wifi', 'radio', 'serial'],
};

/**
 * Completion tracking is deliberately advisory. The planner is always run
 * before the canonical tool pass; this information only makes a partial model
 * attempt visible in the project notes.
 */
interface CompletionStatus {
  hasController: boolean;
  requiredComponentCount: number;
  selectedComponentCount: number;
  unfulfilledRequirements: string[];
  missingComponents: string[];
  isComplete: boolean;
}

function computeCompletionStatus(
  selections: ComponentSelection[],
  requirements: ProjectRequirements,
): CompletionStatus {
  const hasController = selections.some((selection) => selection.category === 'microcontroller');
  const hardwareSelections = selections.filter((selection) => selection.category !== 'microcontroller');
  const expectedMinComponents = Math.max(
    requirements.features.length,
    requirements.inputs.length + requirements.outputs.length,
    Object.values(requirements.quantities).reduce((total, quantity) => total + quantity, 0),
  );

  const unfulfilledRequirements: string[] = [];
  const missingComponents: string[] = [];
  const covers = (word: string): boolean => {
    const tokens = word
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3);
    if (tokens.length === 0) return true;
    const corpus = selections
      .map((selection) => `${selection.componentId} ${selection.name} ${selection.role} ${selection.reason}`.toLowerCase())
      .join(' ');
    // A requirement may be a phrase such as "high humidity alarm". Requiring
    // every word gives false warnings for valid implementation components, so
    // one specific token (or its catalog vocabulary) is enough for this
    // advisory signal.
    return tokens.some((token) => [token, ...(COVERAGE_ALIASES[token] ?? [])].some((candidate) => corpus.includes(candidate)));
  };

  for (const input of requirements.inputs) {
    if (!covers(input)) {
      unfulfilledRequirements.push(`input: ${input}`);
      missingComponents.push(input);
    }
  }
  for (const output of requirements.outputs) {
    if (!covers(output)) {
      unfulfilledRequirements.push(`output: ${output}`);
      missingComponents.push(output);
    }
  }
  for (const feature of requirements.features) {
    if (!covers(feature)) {
      unfulfilledRequirements.push(`feature: ${feature}`);
      missingComponents.push(feature);
    }
  }

  return {
    hasController,
    requiredComponentCount: expectedMinComponents,
    selectedComponentCount: hardwareSelections.length,
    unfulfilledRequirements,
    missingComponents,
    isComplete:
      hasController &&
      hardwareSelections.length >= Math.max(1, Math.ceil(expectedMinComponents * 0.5)) &&
      unfulfilledRequirements.length === 0,
  };
}

export interface AgentRunInput {
  prompt: string;
  projectName: string;
  requirements: ProjectRequirements;
  analysis: PromptAnalysis;
  catalog: ComponentDefinition[];
  events: AgentEventLog;
  onStep?: (record: AgentStepRecord) => void;
  /** Dependency-injection seam for deterministic agent tests. */
  modelDriver?: AgentModelDriver;
}

export interface AgentRunOutput {
  blackboard: AgentBlackboard;
  steps: AgentStepRecord[];
  notes: string[];
}

function systemPrompt(): string {
  return `You are Wireup's embedded hardware engineering agent. You operate a real,
stateful circuit blackboard exclusively through the supplied tools.

Rules:
- Select only catalog components returned by search_components. Never invent a
  part, pin, voltage, connection, library, or test result.
- Work in this order: search/select → plan_hardware → check_compatibility →
  assign_and_verify_pins → route_wiring → generate_firmware → (repair_firmware
  when compile feedback requires it) → build_artifacts.
- If a hardware check fails, adjust the part selection, then call plan_hardware
  again; it invalidates stale downstream work by design.
- If generate_firmware reports compiler errors, use its diagnostics and bounded
  source preview to call repair_firmware with a behavioural plan. That tool
  re-roots pins/includes/buses and recompiles it; never claim success until the
  repair passes. Do not call build_artifacts on a failed compile.
- Tool calls mutate shared engineering state. Issue one action at a time and
  inspect its result before making another call.
- Keep narrative to a short operational status. Do not reveal private
  chain-of-thought; the tool results are the engineering record.
- Finish only after build_artifacts reports success.`;
}

function userPrompt(input: Pick<AgentRunInput, 'projectName' | 'prompt' | 'requirements' | 'analysis'>): string {
  const { projectName, prompt, requirements, analysis } = input;
  return `Project: "${projectName}"
User request: "${prompt}"
Detected requirements: ${JSON.stringify(requirements.summary || requirements)}
Platform preference: ${requirements.detectedPlatform || analysis.detectedPlatform || 'esp32'}

Design, verify, wire, code, and package this hardware system using the tools.`;
}

function toolSpecs() {
  return Object.values(ALL_AGENT_TOOLS).map((tool) => tool.schema);
}

function bedrockTools(): Tool[] {
  return Object.values(ALL_AGENT_TOOLS).map((tool) => ({
    toolSpec: {
      name: tool.schema.name,
      description: tool.schema.description,
      inputSchema: { json: tool.schema.parameters },
    },
  })) as unknown as Tool[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Model calls are untrusted input even when the provider promises JSON. */
function validateToolArguments(tool: AgentTool, raw: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'arguments must be a JSON object' };
  const schema = tool.schema.parameters;
  const allowed = new Set(Object.keys(schema.properties));
  const unexpected = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) return { ok: false, error: `unexpected argument(s): ${unexpected.join(', ')}` };

  for (const required of schema.required ?? []) {
    const value = raw[required];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0)) {
      return { ok: false, error: `missing required argument "${required}"` };
    }
  }

  for (const [name, value] of Object.entries(raw)) {
    const expected = schema.properties[name]?.type;
    const valid =
      expected === 'string'
        ? typeof value === 'string'
        : expected === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : expected === 'boolean'
            ? typeof value === 'boolean'
            : expected === 'array'
              ? Array.isArray(value)
              : expected === 'object'
                ? isRecord(value)
                : false;
    if (!valid) return { ok: false, error: `argument "${name}" must be a ${expected}` };
  }
  return { ok: true, args: raw };
}

/** Bound tool observations so a verbose catalog result cannot consume a turn. */
function serialiseToolResult(result: AgentToolResult): string {
  const payload = {
    success: result.success,
    message: result.message,
    ...(result.error ? { error: result.error } : {}),
    ...(result.data !== undefined ? { data: result.data } : {}),
  };
  try {
    const json = JSON.stringify(payload, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
    if (json.length <= MAX_TOOL_RESULT_CHARS) return json;
    return JSON.stringify({
      success: result.success,
      message: result.message,
      truncated: true,
      preview: json.slice(0, MAX_TOOL_RESULT_CHARS),
    });
  } catch {
    return JSON.stringify({
      success: false,
      message: 'Tool result could not be serialised safely; inspect the local engineering record.',
    });
  }
}

function bedrockResultContent(output: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return { success: false, message: 'Tool result serialisation was invalid.' };
  }
}

async function executeToolCall(
  call: AgentModelToolCall,
  context: AgentToolContext,
  logStep: (record: AgentStepRecord) => void,
  allowedToolNames?: ReadonlySet<string>,
): Promise<AgentModelToolOutput> {
  const tool = !allowedToolNames || allowedToolNames.has(call.name) ? ALL_AGENT_TOOLS[call.name] : undefined;
  let result: AgentToolResult;

  if (!tool) {
    result = {
      success: false,
      message: allowedToolNames
        ? `Tool "${call.name}" is unavailable in this restricted repair pass.`
        : `Unknown tool "${call.name}". Use only a listed tool.`,
    };
  } else {
    const validated = validateToolArguments(tool, call.arguments);
    if (!validated.ok) {
      result = {
        success: false,
        message: `Rejected ${call.name}: ${validated.error}. Correct the arguments and try again.`,
        error: 'invalid_tool_arguments',
      };
    } else {
      try {
        result = await tool.execute(validated.args, context);
      } catch (error) {
        result = {
          success: false,
          message: `${call.name} failed before it could change the circuit.`,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  logStep({
    step: 0, // populated by the caller's step recorder
    thought: `Model requested ${call.name}.`,
    action: { tool: call.name, args: isRecord(call.arguments) ? call.arguments : {} },
    result,
    timestamp: nowIso(),
  });

  return { callId: call.id, output: serialiseToolResult(result) };
}

/**
 * Runs a provider-neutral serial tool loop. Serial execution is intentional:
 * every hardware tool writes the same blackboard, so provider-level parallel
 * calls would race selection invalidation against pin/wire generation.
 */
async function runModelToolLoop(input: {
  driver: AgentModelDriver;
  system: string;
  user: string;
  context: AgentToolContext;
  events: AgentEventLog;
  logStep: (record: AgentStepRecord) => void;
  /** A repair pass exposes only the code-repair tool, never the full board. */
  tools?: AgentToolSchema[];
  allowedToolNames?: ReadonlySet<string>;
}): Promise<void> {
  let outputs: AgentModelToolOutput[] | undefined;
  let callCount = 0;

  for (let turn = 0; turn < MAX_MODEL_TURNS; turn += 1) {
    const response: AgentModelTurn = await input.driver.next({
      turn,
      systemPrompt: input.system,
      ...(turn === 0 ? { userPrompt: input.user } : {}),
      tools: input.tools ?? toolSpecs(),
      ...(outputs ? { toolOutputs: outputs } : {}),
    });

    input.events.emit('info', response.toolCalls.length > 0 ? `Model requested ${response.toolCalls.length} engineering tool action(s).` : 'Model completed its tool-planning turn.', {
      stage: 'hardware',
      metadata: {
        model: input.driver.model,
        transport: input.driver.transport,
        turn: turn + 1,
        toolCalls: response.toolCalls.map((call) => call.name),
        // The status is deliberately not persisted. It can be a model's
        // private reasoning despite the system instruction; tool results are
        // the auditable user-facing record.
        statusReceived: Boolean(response.statusText?.trim()),
      },
    });

    if (response.toolCalls.length === 0) return;

    outputs = [];
    for (const call of response.toolCalls) {
      if (callCount >= MAX_MODEL_TOOL_CALLS) {
        input.events.emit('info', `Agent tool-call limit (${MAX_MODEL_TOOL_CALLS}) reached; deterministic completion is taking over.`, {
          stage: 'hardware',
          metadata: { model: input.driver.model, transport: input.driver.transport, limit: MAX_MODEL_TOOL_CALLS },
        });
        return;
      }
      callCount += 1;

      if (input.driver.transport === 'openai-responses') {
        const rawArguments = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {});
        registerAsyncTool({ callId: call.id, name: call.name, arguments: rawArguments, issuedAt: nowIso() });
      }
      try {
        outputs.push(await executeToolCall(call, input.context, input.logStep, input.allowedToolNames));
      } finally {
        // Removing the pending entry is just as important as adding it: a
        // failed local tool must not leak a stale call into a later project.
        if (input.driver.transport === 'openai-responses') attachToolResult(call.id);
      }
    }
  }

  input.events.emit('info', `Agent model turn limit (${MAX_MODEL_TURNS}) reached; deterministic completion is taking over.`, {
    stage: 'hardware',
    metadata: { model: input.driver.model, transport: input.driver.transport, limit: MAX_MODEL_TURNS },
  });
}

function createAstraDriver(model: string): AgentModelDriver {
  let previousResponseId: string | undefined;
  return {
    model,
    transport: 'openai-responses',
    reason: 'GPT-6 Astra model id + OPENAI_API_KEY — direct Responses tool loop.',
    next: async (input) => {
      const turn = await callAstraToolTurn({
        model,
        system: [input.systemPrompt],
        ...(input.userPrompt ? { userText: input.userPrompt } : {}),
        ...(previousResponseId ? { previousResponseId } : {}),
        tools: input.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
        toolOutputs: input.toolOutputs,
        maxTokens: 4096,
        effort: defaultEffort('generation'),
      });
      previousResponseId = turn.responseId;
      return {
        ...(turn.text ? { statusText: turn.text } : {}),
        toolCalls: turn.toolCalls.map((call) => ({ id: call.callId, name: call.name, arguments: parseModelArguments(call.arguments) })),
      };
    },
  };
}

function createBedrockDriver(model: string): AgentModelDriver {
  const messages: Message[] = [];
  const tools = bedrockTools();
  const family = detectModelFamily(model);

  return {
    model,
    transport: 'bedrock',
    reason: 'Bedrock Converse tool loop.',
    next: async (input) => {
      if (messages.length === 0) {
        if (!input.userPrompt) throw new Error('Bedrock agent session needs userPrompt on its first turn.');
        messages.push({ role: 'user', content: [{ text: input.userPrompt }] });
      } else if (input.userPrompt) {
        // A compile failure after canonical generation is actionable feedback,
        // not a tool result. Preserve the same Bedrock conversation and let
        // the model invoke the bounded repair tool with those diagnostics.
        messages.push({ role: 'user', content: [{ text: input.userPrompt }] });
      } else {
        messages.push({
          role: 'user',
          content: (input.toolOutputs ?? []).map((result) => ({
            toolResult: {
              toolUseId: result.callId,
              content: [{ json: bedrockResultContent(result.output) }],
              status: 'success',
            },
          })) as ContentBlock[],
        });
      }

      const response = await converseRaw({
        modelId: model,
        messages,
        system: [{ text: input.systemPrompt }],
        toolConfig: { tools },
        inferenceConfig: {
          maxTokens: 4096,
          // Astra and Fable reject generic sampling knobs. Bedrock does not
          // expose their direct effort field, but it accepts this minimal form.
          ...(family === 'astra' || family === 'fable' ? {} : { temperature: 0.2 }),
        },
      });
      const assistant = response.output.output?.message;
      if (!assistant) throw new Error('Bedrock returned no assistant message for the agent tool loop.');
      messages.push(assistant);

      const content = assistant.content ?? [];
      const statusText = content
        .filter((block): block is { text: string } => 'text' in block && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
      const toolCalls = content
        .filter((block): block is { toolUse: NonNullable<ContentBlock['toolUse']> } => 'toolUse' in block && Boolean(block.toolUse))
        .flatMap((block): AgentModelToolCall[] => {
          const toolUse = block.toolUse;
          const id = toolUse.toolUseId?.trim() ?? '';
          const name = toolUse.name?.trim() ?? '';
          return id && name ? [{ id, name, arguments: toolUse.input ?? {} }] : [];
        });

      return { ...(statusText ? { statusText } : {}), toolCalls };
    },
  };
}

function parseModelArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // The validation layer returns a tool-visible error instead of letting a
    // malformed provider payload reach a mutating engineering tool.
    return raw;
  }
}

function configuredGenerationModel(): string | null {
  try {
    return resolveModel('generation');
  } catch {
    return null;
  }
}

/** Select the best tool-capable driver without making a provider call. */
function productionDriver(model: string | null, bedrockConfigured: boolean): AgentModelDriver | null {
  if (model && isDirectAstraModelId(model) && astraDirectAvailable()) return createAstraDriver(model);
  if (model && bedrockConfigured) return createBedrockDriver(model);
  return null;
}

function canonicalResult(tool: string, result: AgentToolResult, logStep: (record: AgentStepRecord) => void): void {
  logStep({
    step: 0,
    thought: `Deterministic completion ran ${tool}.`,
    action: { tool, args: {} },
    result,
    timestamp: nowIso(),
  });
}

/**
 * The compile result is returned verbatim as a bounded tool observation, then
 * sent once more as an explicit user turn if deterministic generation happens
 * after the model's first loop. This lets the same provider repair what it
 * just generated instead of leaving a later validation stage to rediscover it.
 */
function firmwareRepairFeedback(result: AgentToolResult): string {
  return `The canonical firmware generation failed its compile gate. Repair only the firmware by calling repair_firmware. Do not change components, pins, wiring, libraries, or the project brief. The tool result below contains the compiler diagnostics and a bounded source preview. Submit a complete behavioural plan (constants, globals, setup body, loop body, helper functions), not raw sketch text.\n\n${serialiseToolResult(result)}`;
}

export async function runHardwareAgent(input: AgentRunInput): Promise<AgentRunOutput> {
  const { prompt, projectName, requirements, analysis, catalog, events, onStep } = input;
  const blackboard: AgentBlackboard = {
    prompt,
    projectName,
    analysis,
    requirements,
    catalog,
    workingCatalog: [...catalog],
    selections: [],
    hardwarePlan: null,
    pinAssignments: [],
    serialLinks: [],
    i2cBuses: [],
    wiring: null,
    softwarePlan: null,
    code: null,
    firmwareCompile: null,
    firmwareRepairAttempts: 0,
    diagram: null,
    libraries: null,
    instructions: null,
    drcIssues: [],
    notes: [],
  };

  const steps: AgentStepRecord[] = [];
  const logStep = (record: AgentStepRecord) => {
    const next = { ...record, step: steps.length + 1 };
    steps.push(next);
    onStep?.(next);
  };
  const toolContext: AgentToolContext = { blackboard, events };

  events.emit('info', `Autonomous hardware agent initialized with ${Object.keys(ALL_AGENT_TOOLS).length} engineering tools.`, {
    stage: 'understanding',
    metadata: { tools: Object.keys(ALL_AGENT_TOOLS) },
  });

  const model = configuredGenerationModel();
  const bedrockStatus = await describeBedrockConfig();
  const driver = input.modelDriver ?? productionDriver(model, bedrockStatus.configured);

  if (driver) {
    events.emit('info', `Starting the ${driver.transport} model tool loop (${driver.reason})`, {
      stage: 'hardware',
      metadata: { model: driver.model, transport: driver.transport, reason: driver.reason },
    });
    try {
      await runModelToolLoop({
        driver,
        system: systemPrompt(),
        user: userPrompt({ projectName, prompt, requirements, analysis }),
        context: toolContext,
        events,
        logStep,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ error, model: driver.model, transport: driver.transport }, 'agent model tool loop interrupted; using deterministic completion');
      events.emit('info', `Model tool loop unavailable (${message}) — deterministic engineering tools are completing the build.`, {
        stage: 'hardware',
        metadata: { model: driver.model, transport: driver.transport, degraded: true },
      });
      blackboard.notes.push(`Model tool loop unavailable (${message}); deterministic engineering tools completed the build.`);
    }
  } else {
    const reason = model
      ? isAstraModel(model) && !isDirectAstraModelId(model)
        ? 'This Astra model id is a Bedrock profile/id, so direct Responses tools are unavailable and Bedrock is not configured.'
        : isDirectAstraModelId(model) && !astraDirectAvailable()
          ? 'Astra direct tools need OPENAI_API_KEY and Bedrock is not configured.'
          : 'Bedrock is not configured for the selected model.'
      : 'No generation model is configured.';
    events.emit('info', `Model tool loop skipped: ${reason} Deterministic engineering tools are completing the build.`, {
      stage: 'hardware',
      metadata: { model, reason, degraded: true },
    });
    blackboard.notes.push(`Model tool loop skipped: ${reason}`);
  }

  /*
   * Canonical completion pass. It does not trust a model's claim that a step
   * finished: the planner normalizes selections and every derived artifact is
   * recalculated in dependency order from the resulting blackboard.
   */
  const before = computeCompletionStatus(blackboard.selections, requirements);
  const hardwareHandle = events.start('hardware_plan_started', 'Canonicalizing selected parts, quantities, power, and compatibility...', {
    stage: 'hardware',
  });

  try {
    const synchronized = await synchroniseHardwarePlan(toolContext);
    const compatibility = await ALL_AGENT_TOOLS.check_compatibility.execute({}, toolContext);
    canonicalResult('plan_hardware', {
      success: Boolean(blackboard.hardwarePlan),
      message: `Canonical hardware plan prepared${synchronized.changed ? '; stale derived work was cleared.' : '.'}`,
      data: { provisional: synchronized.provisional, notes: synchronized.notes },
    }, logStep);
    canonicalResult('check_compatibility', compatibility, logStep);

    const after = computeCompletionStatus(blackboard.selections, requirements);
    if (!after.isComplete && after.unfulfilledRequirements.length > 0) {
      const warning = `Catalog coverage still needs review: ${after.unfulfilledRequirements.join(', ')}.`;
      blackboard.notes.push(warning);
      logger.warn({ projectName, before: before.unfulfilledRequirements, after: after.unfulfilledRequirements }, 'agent selection coverage needs review');
    }
    if (!compatibility.success) {
      blackboard.notes.push(`Compatibility review reported: ${compatibility.message}`);
    }
    hardwareHandle.complete(`Selected ${blackboard.selections.length} catalog-grounded part line item(s).`, {
      partsCount: blackboard.selections.length,
      selectedInstances: blackboard.selections.reduce((total, selection) => total + selection.instances.length, 0),
      coverageWarnings: after.unfulfilledRequirements.length,
      compatibilityPassed: compatibility.success,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    hardwareHandle.fail(`Hardware planning failed: ${message}`, error);
    blackboard.notes.push(`Hardware planning failed (${message}). Downstream artifacts may be incomplete.`);
    logger.warn({ error, projectName }, 'agent canonical hardware plan error');
  }

  if (!blackboard.hardwarePlan || blackboard.selections.length === 0) {
    return { blackboard, steps, notes: blackboard.notes };
  }

  const pinHandle = events.start('pin_assignment_started', 'Assigning and verifying microcontroller GPIO pins...', { stage: 'pins' });
  const pinResult = await ALL_AGENT_TOOLS.assign_and_verify_pins.execute({}, toolContext);
  canonicalResult('assign_and_verify_pins', pinResult, logStep);
  if (!pinResult.success) {
    pinHandle.fail(`Pin allocation alert: ${pinResult.message}`);
    blackboard.notes.push(`Pin allocation blocked downstream generation: ${pinResult.message}`);
    return { blackboard, steps, notes: blackboard.notes };
  }
  pinHandle.complete(`Assigned ${blackboard.pinAssignments.length} pin connection(s) with zero unassigned demands.`);

  const wireHandle = events.start('wiring_started', 'Routing power rails, ground nets, and signals...', { stage: 'wiring' });
  const wireResult = await ALL_AGENT_TOOLS.route_wiring.execute({}, toolContext);
  canonicalResult('route_wiring', wireResult, logStep);
  if (!wireResult.success) {
    wireHandle.fail(`Wiring alert: ${wireResult.message}`);
    blackboard.notes.push(`Wiring blocked downstream generation: ${wireResult.message}`);
    return { blackboard, steps, notes: blackboard.notes };
  }
  wireHandle.complete(`Routed ${blackboard.wiring?.connections.length ?? 0} circuit connection(s).`);

  const firmwareHandle = events.start('code_generation_started', 'Generating firmware from the grounded pin map...', { stage: 'code' });
  const existingFirmware = Boolean(blackboard.code?.files.some((file) => file.path === blackboard.code?.entryPoint)) &&
    (blackboard.firmwareCompile?.status === 'passed' || blackboard.firmwareCompile?.status === 'skipped');
  // A model may already have completed a diagnostics-informed repair during
  // its initial tool loop. Do not regenerate over that verified source; the
  // canonical hardware synchronisation above would already have invalidated it
  // if selections/topology had changed.
  const firmwareResult = existingFirmware
    ? {
        success: true,
        message: `Reusing current firmware after compile check ${blackboard.firmwareCompile?.status}.`,
        data: { compile: blackboard.firmwareCompile },
      }
    : await ALL_AGENT_TOOLS.generate_firmware.execute({}, toolContext);
  canonicalResult('generate_firmware', firmwareResult, logStep);
  if (!firmwareResult.success) {
    if (driver && blackboard.firmwareCompile?.status === 'failed') {
      events.emit('info', 'Firmware compile diagnostics are being returned to the model for a bounded rooted repair pass.', {
        stage: 'code',
        metadata: { model: driver.model, transport: driver.transport, maxRepairAttempts: 2 },
      });
      try {
        await runModelToolLoop({
          driver,
          system: systemPrompt(),
          user: firmwareRepairFeedback(firmwareResult),
          context: toolContext,
          events,
          logStep,
          tools: [ALL_AGENT_TOOLS.repair_firmware.schema],
          allowedToolNames: new Set(['repair_firmware']),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        blackboard.notes.push(`Firmware repair feedback loop was unavailable (${message}).`);
        logger.warn({ error, model: driver.model, transport: driver.transport }, 'agent firmware repair feedback loop interrupted');
      }
    }

    if (blackboard.firmwareCompile?.status !== 'passed') {
      const detail = blackboard.firmwareCompile?.diagnostics[0] ?? firmwareResult.message;
      firmwareHandle.fail(`Firmware alert: ${detail}`);
      blackboard.notes.push(`Firmware generation blocked artifact generation: ${detail}`);
      return { blackboard, steps, notes: blackboard.notes };
    }
    firmwareHandle.complete(`Firmware repaired from compiler feedback: ${blackboard.code?.files.length ?? 0} file(s).`);
  } else {
    firmwareHandle.complete(`Firmware synthesized: ${blackboard.code?.files.length ?? 0} file(s).`);
  }

  const artifactHandle = events.start('instructions_generation_started', 'Building simulation diagram, libraries, and instructions...', { stage: 'instructions' });
  const artifactResult = await ALL_AGENT_TOOLS.build_artifacts.execute({}, toolContext);
  canonicalResult('build_artifacts', artifactResult, logStep);
  if (!artifactResult.success) {
    artifactHandle.fail(`Artifact generation alert: ${artifactResult.message}`);
    blackboard.notes.push(`Artifact generation failed: ${artifactResult.message}`);
  } else {
    artifactHandle.complete('Circuit diagram, libraries, and assembly instructions are ready.');
  }

  return { blackboard, steps, notes: blackboard.notes };
}
