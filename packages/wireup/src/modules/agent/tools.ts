/**
 * AGENT TOOLS REGISTRY.
 *
 * Implements the atomic tools the Agent uses to explore the component database,
 * verify physical/electrical constraints, assign MCU pins, route wiring,
 * generate firmware, and run design rule checks.
 */

import type { AgentFirmwareCompileStatus, AgentTool, AgentToolContext } from './types';
import type { ComponentDefinition, ComponentInstance, ComponentPin, ComponentRole, ComponentSelection, PowerBudget } from '@/types/component';
import type { CodeArtifact, HardwarePlan, SoftwarePlan } from '@/types/project';
import { checkCompatibility } from '@/modules/hardware-planner/compatibility';
import { planHardware } from '@/modules/hardware-planner';
import { planPins } from '@/modules/pin-planner';
import { planWiring } from '@/modules/wiring-planner';
import { planSoftware } from '@/modules/software-planner';
import { generateCode } from '@/modules/code-generator';
import { parseLlmSketchPlan } from '@/modules/code-generator/llm';
import { i2cBusInitLines } from '@/modules/code-generator/managed-blocks';
import { rootLlmSketch, type RootingContext } from '@/modules/code-generator/rooting';
import { generateLibraries } from '@/modules/libraries-generator';
import { generateDiagram } from '@/modules/diagram-generator';
import { generateInstructions } from '@/modules/instructions-generator';
import { compileFirmware, formatDiagnostic, type CompileResult } from '@/modules/firmware-compiler';
import { createId } from '@/lib/validation/ids';

const MAX_FIRMWARE_REPAIR_ATTEMPTS = 2;

const VALID_ROLES = new Set<ComponentRole>([
  'controller',
  'driver',
  'sensor',
  'actuator',
  'communication',
  'power',
  'input',
  'display',
  'passive',
  'prototyping',
  'other',
]);

function toRole(roleCandidate: string, category: string): ComponentRole {
  if (VALID_ROLES.has(roleCandidate as ComponentRole)) return roleCandidate as ComponentRole;
  if (category === 'microcontroller') return 'controller';
  if (category === 'sensor') return 'sensor';
  if (category === 'motor' || category === 'actuator') return 'actuator';
  if (category === 'display') return 'display';
  if (category === 'power') return 'power';
  return 'other';
}

function instancesFor(definition: ComponentDefinition, quantity: number): ComponentInstance[] {
  return Array.from({ length: quantity }, (_, index) => ({
    instanceId: quantity > 1 ? `${definition.id}-${index + 1}` : `${definition.id}-1`,
    componentId: definition.id,
    name: definition.name,
    index: index + 1,
    label: quantity > 1 ? `${definition.name} #${index + 1}` : definition.name,
    category: definition.category,
  }));
}

/**
 * A changed circuit makes every derived artifact suspect. Clearing all of them
 * is safer than letting a model backtrack from one part while keeping the old
 * pins, wires, sketch, or diagram. The deterministic runner rebuilds them.
 */
function invalidateCircuitDerivatives(blackboard: AgentToolContext['blackboard']): void {
  blackboard.hardwarePlan = null;
  blackboard.pinAssignments = [];
  blackboard.serialLinks = [];
  blackboard.i2cBuses = [];
  blackboard.wiring = null;
  blackboard.softwarePlan = null;
  blackboard.code = null;
  blackboard.firmwareCompile = null;
  blackboard.firmwareRepairAttempts = 0;
  blackboard.diagram = null;
  blackboard.libraries = null;
  blackboard.instructions = null;
  blackboard.drcIssues = [];
}

interface FirmwareCompileGateResult {
  status: AgentFirmwareCompileStatus['status'];
  ok: boolean;
  ran: boolean;
  compiler?: string;
  durationMs: number;
  errors: string[];
  warnings: string[];
  skippedReason?: string;
}

/**
 * The agent's code-producing tools share one compile gate. It records the
 * verdict with the exact source that was checked, preserving failures for the
 * next model turn and the pipeline fixer instead of hiding them behind a
 * generated-files success message.
 */
function compileAndRecordFirmware(context: AgentToolContext, code: CodeArtifact): FirmwareCompileGateResult {
  let compile: CompileResult;
  try {
    compile = compileFirmware({ files: code.files, entryPoint: code.entryPoint });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    code.notes.push(`Firmware compile validation could not run: ${detail}`);
    context.blackboard.code = code;
    context.blackboard.firmwareCompile = {
      status: 'unavailable',
      diagnostics: [detail],
      skippedReason: detail,
    };
    context.blackboard.drcIssues = [`Firmware compile validation could not run: ${detail}`];
    return {
      status: 'unavailable',
      ok: false,
      ran: false,
      durationMs: 0,
      errors: [detail],
      warnings: [],
      skippedReason: detail,
    };
  }

  const errors = compile.diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map(formatDiagnostic);
  const warnings = compile.diagnostics
    .filter((diagnostic) => diagnostic.severity === 'warning')
    .map(formatDiagnostic);
  const status: AgentFirmwareCompileStatus['status'] = !compile.ran ? 'skipped' : compile.ok ? 'passed' : 'failed';
  const skippedReason = compile.skippedReason ?? 'compiler unavailable';

  if (!compile.ran) {
    code.notes.push(`Firmware compile check skipped: ${skippedReason}`);
  } else if (!compile.ok) {
    const details = errors.length > 0 ? errors : [compile.skippedReason ?? 'The compiler exited non-zero without a parseable diagnostic.'];
    code.notes.push(`Firmware compile check failed: ${details.join(' | ')}`);
    context.blackboard.drcIssues = details;
  } else {
    code.notes.push(`Firmware compile check passed with ${compile.compiler ?? 'host compiler'} in ${compile.durationMs} ms.`);
    context.blackboard.drcIssues = [];
  }

  context.blackboard.code = code;
  context.blackboard.firmwareCompile = {
    status,
    ...(compile.compiler ? { compiler: compile.compiler } : {}),
    durationMs: compile.durationMs,
    diagnostics: [...errors, ...warnings],
    ...(!compile.ran ? { skippedReason } : {}),
  };

  return {
    status,
    ok: compile.ok,
    ran: compile.ran,
    ...(compile.compiler ? { compiler: compile.compiler } : {}),
    durationMs: compile.durationMs,
    errors,
    warnings,
    ...(!compile.ran ? { skippedReason } : {}),
  };
}

function compileObservation(result: FirmwareCompileGateResult): Record<string, unknown> {
  return {
    status: result.status,
    ...(result.compiler ? { compiler: result.compiler } : {}),
    durationMs: result.durationMs,
    errors: result.errors,
    warnings: result.warnings,
    ...(!result.ran ? { skippedReason: result.skippedReason ?? 'compiler unavailable' } : {}),
  };
}

/** Keep failure feedback small enough to be returned through a model tool turn. */
function repairContext(code: CodeArtifact): Record<string, unknown> {
  const entry = code.files.find((file) => file.path === code.entryPoint);
  const source = entry?.content ?? '';
  const max = 6_000;
  return {
    entryPoint: code.entryPoint,
    source: source.slice(0, max),
    ...(source.length > max ? { sourceTruncated: true } : {}),
  };
}

function firmwareRootingContext(context: AgentToolContext): RootingContext | null {
  const { selections, workingCatalog: catalog, softwarePlan, pinAssignments, i2cBuses, projectName, requirements } = context.blackboard;
  if (!softwarePlan) return null;
  const controller = selections.find((selection) => {
    const component = catalog.find((candidate) => candidate.id === selection.componentId);
    return component?.category === 'microcontroller';
  });
  const controllerName = catalog.find((component) => component.id === controller?.componentId)?.name ?? 'Arduino';
  return {
    projectName,
    projectSummary: requirements.summary,
    controllerName,
    assignments: pinAssignments,
    libraries: softwarePlan.libraries,
    platformIsEsp32: /esp32/i.test(controllerName),
    ...(i2cBuses.length > 0
      ? { i2cInitLines: i2cBusInitLines({ assignments: pinAssignments, buses: i2cBuses, linkIdentifier: 'Serial' }) }
      : {}),
  };
}

function sameSelectionTopology(a: ComponentSelection[], b: ComponentSelection[]): boolean {
  const signature = (selection: ComponentSelection) => `${selection.componentId}:${selection.quantity}:${selection.role}`;
  return a.length === b.length && a.map(signature).sort().join('|') === b.map(signature).sort().join('|');
}

function plannerInputFromSelections(selections: ComponentSelection[]): unknown[] {
  return selections.map((selection) => ({
    componentId: selection.componentId,
    quantity: selection.quantity,
    role: selection.role,
    reason: selection.reason,
    required: selection.required,
  }));
}

/**
 * Canonicalise model-selected parts through the hardware planner. This keeps
 * the catalog, defaults, quantities, power budget, and compatibility report in
 * agreement before any downstream tool commits a pin or wire.
 */
export async function synchroniseHardwarePlan(context: AgentToolContext): Promise<{
  changed: boolean;
  provisional: string[];
  notes: string[];
}> {
  const blackboard = context.blackboard;
  const previous = blackboard.selections;
  const hadPlan = blackboard.hardwarePlan !== null;
  const planned = await planHardware(
    {
      requirements: blackboard.requirements,
      analysis: blackboard.analysis,
      modelComponents: plannerInputFromSelections(previous),
      catalog: blackboard.workingCatalog,
    },
    context.events,
  );

  const knownIds = new Set(blackboard.workingCatalog.map((component) => component.id));
  for (const provisional of planned.provisional) {
    if (!knownIds.has(provisional.id)) {
      blackboard.workingCatalog.push(provisional);
      knownIds.add(provisional.id);
    }
  }

  const changed = !hadPlan || !sameSelectionTopology(previous, planned.selections);
  blackboard.selections = planned.selections;
  blackboard.hardwarePlan = planned.plan;
  for (const note of planned.notes) {
    if (!blackboard.notes.includes(note)) blackboard.notes.push(note);
  }

  if (changed) {
    // Preserve the freshly calculated plan while discarding every artifact
    // derived from the previous (or plan-less) circuit.
    const plan = blackboard.hardwarePlan;
    invalidateCircuitDerivatives(blackboard);
    blackboard.hardwarePlan = plan;
  }

  return { changed, provisional: planned.provisional.map((component) => component.id), notes: planned.notes };
}

/**
 * Tool 1: search_components
 * Search the component catalog by keywords, category, or interface.
 */
export const searchComponentsTool: AgentTool = {
  schema: {
    name: 'search_components',
    description: 'Search the catalog of real hardware components by keyword, category, or communication protocol.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term e.g. "soil moisture", "oled", "servo", "temp sensor"' },
        category: {
          type: 'string',
          description: 'Filter by category: microcontroller, sensor, display, motor, motor_driver, discrete, power, communication',
        },
      },
      required: ['query'],
    },
  },
  execute: (args, context) => {
    const query = String(args.query || '').toLowerCase().trim();
    const category = args.category ? String(args.category).toLowerCase().trim() : null;
    const catalog = context.blackboard.workingCatalog;

    const matches = catalog.filter((part) => {
      if (category && part.category !== category) return false;
      if (!query) return true;
      const haystack = [
        part.id,
        part.name,
        part.category,
        part.description,
        ...(part.keywords || []),
        ...(part.aliases || []),
      ].join(' ').toLowerCase();
      return query.split(/\s+/).every((word) => haystack.includes(word));
    }).slice(0, 8);

    return {
      success: true,
      message: `Found ${matches.length} matching component(s).`,
      data: matches.map((m) => ({
        id: m.id,
        name: m.name,
        category: m.category,
        voltage: m.voltage,
        maxVoltage: m.maxVoltage,
        protocols: m.communicationProtocols,
        pinCount: m.pins?.length ?? 0,
        pins: m.pins?.map((p: ComponentPin) => `${p.name} (${p.type}/${p.direction})`),
        description: m.description,
      })),
    };
  },
};

/**
 * Tool 2: select_component
 * Select a component instance into the working circuit.
 */
export const selectComponentTool: AgentTool = {
  schema: {
    name: 'select_component',
    description: 'Add a component from the catalog into the active project circuit with a role and quantity.',
    parameters: {
      type: 'object',
      properties: {
        componentId: { type: 'string', description: 'The exact ID of the catalog component (e.g. "esp32-devkit-v1", "sensor-dht22")' },
        role: { type: 'string', description: 'Role in the project (e.g. "Main microcontroller", "Ambient temperature monitor")' },
        quantity: { type: 'number', description: 'Number of instances needed (default: 1)' },
      },
      required: ['componentId'],
    },
  },
  execute: (args, context) => {
    const componentId = String(args.componentId).trim();
    const roleRaw = String(args.role || 'Hardware component').trim();
    const requestedQuantity = Number(args.quantity);
    const qty = Number.isFinite(requestedQuantity) ? Math.max(1, Math.min(10, Math.round(requestedQuantity))) : 1;
    const def = context.blackboard.workingCatalog.find((c) => c.id === componentId);

    if (!def) {
      return {
        success: false,
        message: `Component "${componentId}" not found in catalog. Use search_components to find valid component IDs.`,
      };
    }

    const role = toRole(roleRaw, def.category);

    // Check if already selected. Updating quantity must rebuild concrete
    // instances too; leaving the old instance list behind creates pins and
    // wires for parts that are no longer in the BOM.
    const existing = context.blackboard.selections.find((s) => s.componentId === componentId);
    if (existing) {
      const changed = existing.quantity !== qty || existing.role !== role || existing.reason !== roleRaw;
      existing.quantity = qty;
      existing.role = role;
      existing.reason = roleRaw;
      existing.instances = instancesFor(def, qty);
      if (changed) invalidateCircuitDerivatives(context.blackboard);
      context.events.emit('component_selected', `Updated ${def.name} (${qty}x, ${role})`, {
        stage: 'hardware',
        metadata: { componentId: def.id, quantity: qty, role, updated: true },
      });
      return {
        success: true,
        message: `Updated existing component "${def.name}" quantity to ${qty}.`,
        data: existing,
      };
    }

    const instances = instancesFor(def, qty);

    const selection: ComponentSelection = {
      id: createId('sel'),
      componentId: def.id,
      name: def.name,
      category: def.category,
      role,
      quantity: qty,
      reason: roleRaw,
      required: true,
      instances,
      source: 'catalog',
    };

    context.blackboard.selections.push(selection);
    invalidateCircuitDerivatives(context.blackboard);
    context.events.emit('component_selected', `Selected ${def.name} (${role})`, {
      stage: 'hardware',
      metadata: { componentId: def.id, quantity: qty, role },
    });

    return {
      success: true,
      message: `Selected ${def.name} into the circuit.`,
      data: {
        componentId: def.id,
        name: def.name,
        category: def.category,
        instances: instances.map((ins) => ins.instanceId),
      },
    };
  },
};

/**
 * Tool 3: deselect_component
 * Backtracking: Remove a component from the working circuit if incompatible.
 */
export const deselectComponentTool: AgentTool = {
  schema: {
    name: 'deselect_component',
    description: 'Remove a component instance from the circuit (used to swap incompatible parts or backtrack).',
    parameters: {
      type: 'object',
      properties: {
        componentId: { type: 'string', description: 'Component ID to remove' },
      },
      required: ['componentId'],
    },
  },
  execute: (args, context) => {
    const componentId = String(args.componentId).trim();
    const idx = context.blackboard.selections.findIndex((s) => s.componentId === componentId);
    if (idx === -1) {
      return { success: false, message: `Component "${componentId}" is not currently in the circuit.` };
    }
    context.blackboard.selections.splice(idx, 1);
    invalidateCircuitDerivatives(context.blackboard);

    context.events.emit('info', `Removed ${componentId} from the circuit for replacement.`, {
      stage: 'hardware',
      metadata: { componentId },
    });

    return {
      success: true,
      message: `Removed ${componentId}. Downstream pin and wire plans cleared for re-routing.`,
    };
  },
};

/**
 * Tool 4: plan_hardware
 * Make the planner's catalog-grounded selections and power budget canonical.
 */
export const planHardwareTool: AgentTool = {
  schema: {
    name: 'plan_hardware',
    description: 'Canonicalize selected catalog components, add engineering-required supporting parts, and calculate the real power and compatibility plan before assigning pins.',
    parameters: { type: 'object', properties: {} },
  },
  execute: async (_args, context) => {
    const result = await synchroniseHardwarePlan(context);
    const plan = context.blackboard.hardwarePlan;
    return {
      success: Boolean(plan),
      message: `Hardware plan is grounded on ${context.blackboard.selections.length} part selection(s)${result.changed ? '; downstream artifacts were reset for the revised circuit.' : '.'}`,
      data: {
        parts: context.blackboard.selections.map((selection) => ({
          componentId: selection.componentId,
          quantity: selection.quantity,
          role: selection.role,
        })),
        powerAdequate: plan?.power.adequate ?? false,
        risks: plan?.risks ?? [],
        provisional: result.provisional,
      },
    };
  },
};

/**
 * Tool 5: check_compatibility
 * Check electrical and voltage compatibility between selected parts and the controller.
 */
export const checkCompatibilityTool: AgentTool = {
  schema: {
    name: 'check_compatibility',
    description: 'Check electrical, logic-level, and power compatibility for the currently selected components.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  execute: (_args, context) => {
    const selections = context.blackboard.selections;
    const catalog = context.blackboard.workingCatalog;
    const controllerSel = selections.find((s) => {
      const def = catalog.find((c) => c.id === s.componentId);
      return def?.category === 'microcontroller';
    }) ?? null;

    if (!controllerSel) {
      return {
        success: false,
        message: 'No microcontroller is currently selected in the circuit. Select a microcontroller first.',
      };
    }

    const { checks, risks } = checkCompatibility({
      selections,
      catalog,
      controller: controllerSel,
    });
    const incompatible = checks.filter((c) => !c.compatible);

    return {
      success: incompatible.length === 0,
      message: incompatible.length === 0
        ? `All ${checks.length} compatibility checks passed clean.`
        : `Found ${incompatible.length} compatibility issue(s).`,
      data: {
        controller: controllerSel.componentId,
        incompatible: incompatible.map((c) => ({
          partA: c.a,
          partB: c.b,
          reason: c.reason,
        })),
        risks,
      },
    };
  },
};

/**
 * Tool 6: assign_and_verify_pins
 * Assign MCU pins to all peripherals and check for shortages/conflicts.
 */
export const assignPinsTool: AgentTool = {
  schema: {
    name: 'assign_and_verify_pins',
    description: 'Assign microcontroller GPIO pins to all selected peripherals with bus and capability constraints.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  execute: (_args, context) => {
    const selections = context.blackboard.selections;
    const catalog = context.blackboard.workingCatalog;
    const controllerSel = selections.find((s) => {
      const def = catalog.find((c) => c.id === s.componentId);
      return def?.category === 'microcontroller';
    });

    if (!controllerSel) {
      return {
        success: false,
        message: 'Cannot assign pins: No microcontroller is selected in the circuit.',
      };
    }

    const controllerInstanceId = controllerSel.instances[0]?.instanceId;
    const result = planPins({
      selections,
      catalog,
      controllerInstanceId,
      events: context.events,
    });

    context.blackboard.pinAssignments = result.assignments;
    context.blackboard.serialLinks = result.serialLinks;
    context.blackboard.i2cBuses = result.i2cBuses;

    if (result.unassigned.length > 0) {
      return {
        success: false,
        message: `Pin allocation failed: ${result.unassigned.length} pin(s) could not be assigned.`,
        data: {
          assignedCount: result.assignments.length,
          unassigned: result.unassigned.map((u) => `${u.instanceId}.${u.pin}: ${u.reason}`),
          suggestion: 'Consider selecting a microcontroller with more GPIO/analog pins or using an I2C expander.',
        },
      };
    }

    return {
      success: true,
      message: `Successfully assigned all ${result.assignments.length} pins with zero conflicts.`,
      data: {
        assignments: result.assignments.map((a) => ({
          peripheral: `${a.targetInstanceId}.${a.targetPin}`,
          mcuPin: a.pin,
          signalType: a.signal,
        })),
        buses: {
          i2c: result.i2cBuses,
          serial: result.serialLinks,
        },
      },
    };
  },
};

/**
 * Tool 7: route_wiring
 * Route the power rails and signal connections for the design.
 */
export const routeWiringTool: AgentTool = {
  schema: {
    name: 'route_wiring',
    description: 'Route power rails (VCC/3V3/5V/GND) and signal lines based on the allocated pin map.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  execute: (_args, context) => {
    const { selections, pinAssignments, workingCatalog: catalog } = context.blackboard;
    if (pinAssignments.length === 0) {
      return {
        success: false,
        message: 'Cannot route wiring before pins are assigned. Call assign_and_verify_pins first.',
      };
    }

    const controllerSel = selections.find((s) => {
      const def = catalog.find((c) => c.id === s.componentId);
      return def?.category === 'microcontroller';
    });

    const power: PowerBudget = context.blackboard.hardwarePlan?.power || {
      rails: [],
      adequate: true,
      notes: [],
    };

    const wiring = planWiring({
      selections,
      catalog,
      assignments: pinAssignments,
      power,
      controllerInstanceId: controllerSel?.instances[0]?.instanceId,
      serialLinks: context.blackboard.serialLinks,
      events: context.events,
    });

    context.blackboard.wiring = wiring;

    return {
      success: wiring.conflicts.length === 0,
      message: `Routed ${wiring.connections.length} connection(s) across the circuit.`,
      data: {
        totalWires: wiring.connections.length,
        conflicts: wiring.conflicts,
      },
    };
  },
};

/**
 * Tool 8: generate_firmware
 * Generate sketch firmware and record its host compile-gate verdict against the assigned pin map.
 */
export const generateFirmwareTool: AgentTool = {
  schema: {
    name: 'generate_firmware',
    description: 'Author the sketch.ino embedded firmware from the assigned pins and run the host compile gate.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  execute: async (_args, context) => {
    const { selections, pinAssignments, workingCatalog: catalog, requirements } = context.blackboard;
    if (pinAssignments.length === 0) {
      return {
        success: false,
        message: 'Cannot generate firmware: No pins have been assigned yet.',
      };
    }

    const controllerSel = selections.find((s) => {
      const def = catalog.find((c) => c.id === s.componentId);
      return def?.category === 'microcontroller';
    });
    const controllerDef = catalog.find((c) => c.id === controllerSel?.componentId);

    const softwarePlan: SoftwarePlan = planSoftware({
      requirements,
      selections,
      catalog,
      assignments: pinAssignments,
      serialLinks: context.blackboard.serialLinks || [],
      i2cBuses: context.blackboard.i2cBuses || [],
      controllerInstanceId: controllerSel?.instances[0]?.instanceId,
      controllerComponentId: controllerSel?.componentId,
      events: context.events,
    });
    context.blackboard.softwarePlan = softwarePlan;

    const code = await generateCode({
      projectName: context.blackboard.projectName,
      projectSummary: requirements.summary,
      requirements,
      selections,
      catalog,
      assignments: pinAssignments,
      serialLinks: context.blackboard.serialLinks || [],
      i2cBuses: context.blackboard.i2cBuses || [],
      softwarePlan,
      controllerName: controllerDef?.name || 'Arduino',
      revision: 1,
      prompt: context.blackboard.prompt,
      events: context.events,
    });

    /*
     * Code presence is not a firmware verdict. A failed result includes the
     * compiler feedback and a bounded source preview for the next agent turn,
     * which can submit a rooted repair rather than merely reporting the error.
     */
    const compile = compileAndRecordFirmware(context, code);
    if (!compile.ok) {
      return {
        success: false,
        message: `Firmware failed the compile gate: ${(compile.errors[0] ?? compile.skippedReason ?? 'compiler exited non-zero').slice(0, 300)}`,
        error: compile.status === 'unavailable' ? 'firmware_validation_unavailable' : 'firmware_compile_error',
        data: {
          files: code.files.map((file) => file.path),
          compile: compileObservation(compile),
          repair: repairContext(code),
        },
      };
    }

    return {
      success: code.files.length > 0,
      message: `Firmware generated: ${code.files.length} file(s). Compile check ${compile.status}${compile.ran ? ` (${compile.compiler ?? 'host compiler'}, ${compile.warnings.length} warning(s)).` : `: ${compile.skippedReason ?? 'compiler unavailable'}`}`,
      data: {
        files: code.files.map((file) => file.path),
        notes: code.notes,
        compile: compileObservation(compile),
      },
    };
  },
};

/**
 * Tool 9: repair_firmware
 * Feed compiler diagnostics back into a bounded, rooted repair attempt. The
 * model can revise behavioural sections only; the rooter rebuilds all
 * hardware-owned includes, pins, and I2C initialisation before compiling.
 */
export const repairFirmwareTool: AgentTool = {
  schema: {
    name: 'repair_firmware',
    description: 'Repair a failed sketch from the compiler diagnostics. Submit a structured behavioural plan; Wireup preserves the assigned pins, libraries, and buses, then recompiles it.',
    parameters: {
      type: 'object',
      properties: {
        plan: {
          type: 'object',
          description: 'Firmware plan object: constants array, globals string, setup string (body only), loop string (body only), functions array of {name, definition}, and notes array. Do not include #include directives, pin declarations, or void setup/loop wrappers.',
        },
      },
      required: ['plan'],
    },
  },
  execute: (args, context) => {
    const { code, firmwareCompile, firmwareRepairAttempts } = context.blackboard;
    if (!code || !firmwareCompile) {
      return { success: false, message: 'Generate and compile firmware before requesting a repair.' };
    }
    if (firmwareCompile.status !== 'failed') {
      return {
        success: false,
        message: firmwareCompile.status === 'unavailable'
          ? 'Firmware repair is unavailable because the compile gate did not run.'
          : `Firmware repair is not needed: compile status is ${firmwareCompile.status}.`,
      };
    }
    if (firmwareRepairAttempts >= MAX_FIRMWARE_REPAIR_ATTEMPTS) {
      return {
        success: false,
        message: `Firmware repair limit (${MAX_FIRMWARE_REPAIR_ATTEMPTS}) reached. The last compiler diagnostics remain attached for the pipeline fixer.`,
        error: 'firmware_repair_limit',
        data: { compile: compileObservation({
          status: firmwareCompile.status,
          ok: false,
          ran: true,
          ...(firmwareCompile.compiler ? { compiler: firmwareCompile.compiler } : {}),
          durationMs: firmwareCompile.durationMs ?? 0,
          errors: firmwareCompile.diagnostics,
          warnings: [],
        }) },
      };
    }

    const parsed = parseLlmSketchPlan(args.plan);
    if (!parsed.ok) {
      return {
        success: false,
        message: `Rejected firmware repair: ${parsed.error}.`,
        error: 'invalid_firmware_plan',
      };
    }

    const rooting = firmwareRootingContext(context);
    if (!rooting) {
      return { success: false, message: 'Cannot repair firmware: the software and pin plans are missing.' };
    }

    context.blackboard.firmwareRepairAttempts += 1;
    const rooted = rootLlmSketch(parsed.plan, rooting);
    if (rooted.verdict !== 'rooted') {
      return {
        success: false,
        message: `Rejected firmware repair by the grounding gate: ${rooted.issues[0] ?? 'invalid behavioural plan'}.`,
        error: 'firmware_repair_rejected',
        data: {
          issues: rooted.issues,
          warnings: rooted.warnings,
          repairs: rooted.repairs,
          attemptsRemaining: MAX_FIRMWARE_REPAIR_ATTEMPTS - context.blackboard.firmwareRepairAttempts,
        },
      };
    }

    const entry = code.files.find((file) => file.path === code.entryPoint);
    if (!entry) {
      return { success: false, message: `Cannot repair firmware: entry point ${code.entryPoint} is missing.` };
    }

    const repairedCode: CodeArtifact = {
      ...code,
      files: code.files.map((file) => file.path === code.entryPoint
        ? {
            ...file,
            content: rooted.content,
            purpose: 'Firmware behaviour repaired from compiler diagnostics and rooted to the pin plan.',
            generatedBy: 'model',
          }
        : file),
      pinsSynchronised: true,
      notes: [
        ...code.notes,
        `Firmware repair attempt ${context.blackboard.firmwareRepairAttempts} used compiler diagnostics and re-rooted the model plan to the assigned hardware.`,
        ...rooted.repairs.map((repair) => `[rooted repair] ${repair}`),
        ...rooted.warnings.map((warning) => `[rooted warning] ${warning}`),
      ],
    };

    const compile = compileAndRecordFirmware(context, repairedCode);
    if (!compile.ok) {
      return {
        success: false,
        message: `Repaired firmware still failed the compile gate: ${(compile.errors[0] ?? compile.skippedReason ?? 'compiler exited non-zero').slice(0, 300)}`,
        error: compile.status === 'unavailable' ? 'firmware_validation_unavailable' : 'firmware_compile_error',
        data: {
          compile: compileObservation(compile),
          repair: repairContext(repairedCode),
          attemptsRemaining: MAX_FIRMWARE_REPAIR_ATTEMPTS - context.blackboard.firmwareRepairAttempts,
        },
      };
    }

    return {
      success: true,
      message: `Firmware repair passed the compile gate${compile.ran ? ` with ${compile.compiler ?? 'the host compiler'}.` : `; check was skipped: ${compile.skippedReason ?? 'compiler unavailable'}`}`,
      data: {
        files: repairedCode.files.map((file) => file.path),
        compile: compileObservation(compile),
        repairs: rooted.repairs,
        warnings: rooted.warnings,
        attemptsUsed: context.blackboard.firmwareRepairAttempts,
      },
    };
  },
};

/**
 * Tool 10: build_artifacts
 * Generate Wokwi/Velxio diagram, required libraries, and step-by-step instructions.
 */
export const buildArtifactsTool: AgentTool = {
  schema: {
    name: 'build_artifacts',
    description: 'Generate supporting engineering artifacts: diagram.json, libraries.json, and instructions.md.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  execute: (_args, context) => {
    const { selections, pinAssignments, wiring, softwarePlan, code, firmwareCompile, workingCatalog: catalog, requirements } = context.blackboard;
    if (!wiring) {
      return { success: false, message: 'Wiring must be routed before generating diagrams and instructions.' };
    }
    if (!softwarePlan || !code?.files.some((file) => file.path === code.entryPoint)) {
      return { success: false, message: 'Firmware must be generated from the assigned pins before building artifacts.' };
    }
    if (!firmwareCompile) {
      return { success: false, message: 'Firmware compile validation must run before building artifacts.' };
    }
    if (firmwareCompile.status === 'failed' || firmwareCompile.status === 'unavailable') {
      const detail = firmwareCompile.diagnostics[0] ?? firmwareCompile.skippedReason ?? 'No compiler verdict was recorded.';
      return {
        success: false,
        message: `Cannot build artifacts: firmware did not pass compile validation (${detail.slice(0, 300)}).`,
        error: firmwareCompile.status === 'failed' ? 'firmware_compile_error' : 'firmware_validation_unavailable',
      };
    }

    const controllerSel = selections.find((s) => {
      const def = catalog.find((c) => c.id === s.componentId);
      return def?.category === 'microcontroller';
    });

    const fallbackHardwarePlan: HardwarePlan = context.blackboard.hardwarePlan || {
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

    const libraries = generateLibraries({
      softwarePlan: softwarePlan || {
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
      },
      selections,
      catalog,
      controllerComponentId: controllerSel?.componentId,
      events: context.events,
    });
    context.blackboard.libraries = libraries;

    const diagram = generateDiagram({
      projectId: createId('proj'),
      revision: 1,
      projectName: context.blackboard.projectName,
      projectSummary: requirements.summary,
      requirements,
      selections,
      catalog,
      assignments: pinAssignments,
      wiring,
      hardwarePlan: fallbackHardwarePlan,
      events: context.events,
    });
    context.blackboard.diagram = diagram;

    const instructions = generateInstructions({
      projectName: context.blackboard.projectName,
      projectSummary: requirements.summary,
      requirements,
      selections,
      catalog,
      hardwarePlan: fallbackHardwarePlan,
      pinAssignments,
      wiring,
      softwarePlan: softwarePlan || {
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
      },
      libraries,
      diagram,
      controllerName: controllerSel?.componentId || 'Microcontroller',
      controllerComponentId: controllerSel?.componentId,
      revision: 1,
      events: context.events,
    });
    context.blackboard.instructions = instructions;

    return {
      success: true,
      message: 'Generated diagram.json, libraries.json, and instructions.md.',
      data: {
        diagramParts: diagram.stats.components,
        wireCount: diagram.stats.connections,
        librariesNeeded: libraries.libraries.map((l) => l.name),
        instructionSections: instructions.sections.length,
      },
    };
  },
};

export const ALL_AGENT_TOOLS: Record<string, AgentTool> = {
  search_components: searchComponentsTool,
  select_component: selectComponentTool,
  deselect_component: deselectComponentTool,
  plan_hardware: planHardwareTool,
  check_compatibility: checkCompatibilityTool,
  assign_and_verify_pins: assignPinsTool,
  route_wiring: routeWiringTool,
  generate_firmware: generateFirmwareTool,
  repair_firmware: repairFirmwareTool,
  build_artifacts: buildArtifactsTool,
};
