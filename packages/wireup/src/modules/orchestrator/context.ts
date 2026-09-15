/**
 * Shared generation context + the deterministic re-derivations ("refreshers")
 * the fixer is allowed to run after a patch.
 *
 * Refreshers never call the model: they re-run the same planners that produced
 * the artifact in the first place, using the *patched* project state as input.
 */

import type { ComponentDefinition } from '@/types/component';
import type { AgentEventLog } from '@/lib/logging/events';
import type { ProjectState } from '@/types/project';
import type { PinAssignment } from '@/types/wiring';
import type { I2CBus, SerialLink } from '@/modules/pin-planner';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';
import type { PromptAnalysis } from '@/modules/project-understanding/heuristics';
import type { FixerRefreshers, RefreshResult } from '@/modules/fixer/apply';

import { logger } from '@/lib/logging/logger';
import {
  formatCatalogContext,
  formatMcuContext,
  getCatalog,
  retrieveRelevantComponents,
  type CatalogState,
} from '@/modules/components';
import { getMcuProfile } from '@/modules/pin-planner/mcu-profiles';
import { planPins } from '@/modules/pin-planner';
import { extendWiringPlan, planWiring } from '@/modules/wiring-planner';
import { planSoftware } from '@/modules/software-planner';
import { ensureIncludesBlock, ensurePinMap, generateCode, syncPinConstants } from '@/modules/code-generator';
import { bedrockSketchPlanProvider, llmCodegenEnabled } from '@/modules/code-generator/llm';
import { describeBedrockConfig } from '@/lib/bedrock';
import { generateLibraries } from '@/modules/libraries-generator';
import { generateDiagram } from '@/modules/diagram-generator';
import { generateInstructions } from '@/modules/instructions-generator';
import { refreshHardwarePlan } from '@/modules/hardware-planner';

export interface GenerationContext {
  catalog: ComponentDefinition[];
  catalogSource: CatalogState['source'];
  catalogError?: string;
  /** Prompt-focused slice of the catalog. */
  relevant: ComponentDefinition[];
  catalogContext: string;
  /** Full catalog context, used by the validation and fix calls. */
  fullCatalogContext: string;
  mcuContext: string;
  profiles: McuProfile[];
  notes: string[];
}

export interface BuildContextInput {
  prompt: string;
  analysis: PromptAnalysis;
  events?: AgentEventLog;
}

export async function buildGenerationContext(input: BuildContextInput): Promise<GenerationContext> {
  const handle = input.events?.start('component_search_started', 'Loading the component database and selecting the relevant slice...', {
    stage: 'catalog',
  });

  const state = await getCatalog();
  const retrieval = await retrieveRelevantComponents({
    prompt: input.prompt,
    features: input.analysis.features,
    hints: input.analysis.explicitParts,
    maxComponents: 34,
  });

  const profiles = retrieval.profiles.length > 0 ? retrieval.profiles : [];
  const context: GenerationContext = {
    catalog: state.components,
    catalogSource: state.source,
    relevant: retrieval.components,
    catalogContext: formatCatalogContext(retrieval.components),
    fullCatalogContext: formatCatalogContext(state.components),
    mcuContext: formatMcuProfileContext(profiles, state.components),
    profiles,
    notes: [...retrieval.notes, ...(state.error ? [`Component database: ${state.error}`] : [])],
  };

  handle?.complete(
    `Component database ready — ${state.components.length} part(s) from ${state.source}, ${retrieval.components.length} relevant to this prompt.`,
    {
      catalogSize: state.components.length,
      source: state.source,
      relevant: retrieval.components.length,
      mcus: retrieval.mcus.map((mcu) => mcu.id),
      profiles: profiles.map((profile) => profile.componentId),
    },
  );

  return context;
}

function formatMcuProfileContext(profiles: McuProfile[], catalog: ComponentDefinition[]): string {
  if (profiles.length > 0) return formatMcuContext(profiles);
  const fallback = catalog
    .filter((component) => component.category === 'microcontroller')
    .map((component) => getMcuProfile(component.id))
    .filter((profile): profile is McuProfile => profile !== undefined);
  return formatMcuContext(fallback);
}

/* ------------------------------------------------------------------------- */
/* Controller / link derivation                                               */
/* ------------------------------------------------------------------------- */

export interface ControllerInfo {
  instanceId?: string;
  componentId?: string;
  name: string;
  profile?: McuProfile;
}

export function controllerInfo(project: ProjectState, catalog: ComponentDefinition[]): ControllerInfo {
  const controller = project.hardwarePlan?.controller;
  const selection = project.components.find((entry) => entry.role === 'controller');
  const componentId = controller?.componentId ?? selection?.componentId;
  const instanceId = controller?.instanceId ?? selection?.instances[0]?.instanceId;
  const profile = componentId ? getMcuProfile(componentId) : undefined;
  return {
    ...(instanceId ? { instanceId } : {}),
    ...(componentId ? { componentId } : {}),
    name: controller?.name ?? selection?.name ?? componentId ?? 'the controller',
    ...(profile ? { profile } : {}),
  };
}

/**
 * Rebuild the serial/I²C link view from the *stored* pin assignments, so a
 * refresh never disagrees with the pin plan the project already has.
 */
export function deriveLinks(project: ProjectState, profile?: McuProfile): { serialLinks: SerialLink[]; i2cBuses: I2CBus[] } {
  const serialLinks: SerialLink[] = [];
  const i2cBuses: I2CBus[] = [];

  const uartByTarget = new Map<string, PinAssignment[]>();
  const i2cByTarget = new Map<string, PinAssignment[]>();

  for (const assignment of project.pinAssignments) {
    if (assignment.protocol === 'uart') {
      const list = uartByTarget.get(assignment.targetInstanceId) ?? [];
      list.push(assignment);
      uartByTarget.set(assignment.targetInstanceId, list);
    }
    if (assignment.protocol === 'i2c') {
      const list = i2cByTarget.get(assignment.targetInstanceId) ?? [];
      list.push(assignment);
      i2cByTarget.set(assignment.targetInstanceId, list);
    }
  }

  const hardwareUartPins = new Set<string>();
  for (const port of profile?.uarts ?? []) {
    if (port.tx) hardwareUartPins.add(port.tx);
    if (port.rx) hardwareUartPins.add(port.rx);
  }

  let uartIndex = 0;
  for (const [instanceId, assignments] of uartByTarget) {
    uartIndex += 1;
    const tx = assignments.find((assignment) => /tx/i.test(assignment.targetPin) || /rx/i.test(assignment.pin));
    const rx = assignments.find((assignment) => /rx/i.test(assignment.targetPin) || /tx/i.test(assignment.pin));
    const pins = assignments.map((assignment) => assignment.pin);
    /* ESP32 UARTs are remappable, so any pin pair is a hardware port there;
       AVR only has one hardware UART (D0/D1) and needs SoftwareSerial otherwise. */
    const isEsp = /esp32/i.test(profile?.componentId ?? '');
    const matchesHardwarePort = pins.length > 0 && pins.every((pin) => hardwareUartPins.has(pin));
    const isHardware = isEsp || matchesHardwarePort;
    serialLinks.push({
      id: `serial-${uartIndex}`,
      kind: isHardware ? 'hardware' : 'software',
      mcuTxPin: tx?.pin ?? pins[0] ?? '',
      mcuRxPin: rx?.pin ?? pins[1] ?? pins[0] ?? '',
      peripheralInstanceId: instanceId,
      peripheralComponentId: assignments[0]?.targetComponentId ?? '',
      ...(assignments[0]?.purpose ? { note: assignments[0].purpose } : { note: 'Serial control link' }),
    });
  }

  /* Integrated radios (Bluetooth/Wi-Fi capability) need no pins at all. */
  for (const selection of project.components) {
    if (selection.role !== 'communication') continue;
    if (uartByTarget.has(selection.instances[0]?.instanceId ?? '')) continue;
    const instanceId = selection.instances[0]?.instanceId;
    if (!instanceId) continue;
    const integrated = /bluetooth|wifi|ble|radio/i.test(`${selection.componentId} ${selection.name}`);
    if (!integrated) continue;
    serialLinks.push({
      id: `serial-${serialLinks.length + 1}`,
      kind: 'hardware',
      mcuTxPin: '',
      mcuRxPin: '',
      peripheralInstanceId: instanceId,
      peripheralComponentId: selection.componentId,
      note: 'Integrated radio — no MCU pins required.',
    });
  }

  let busIndex = 0;
  for (const [, assignments] of i2cByTarget) {
    busIndex += 1;
    const sda = assignments.find((assignment) => /sda/i.test(assignment.targetPin)) ?? assignments[0];
    const scl = assignments.find((assignment) => /scl/i.test(assignment.targetPin)) ?? assignments[1] ?? assignments[0];
    const devices = Array.from(new Set(assignments.map((assignment) => assignment.targetInstanceId))).map((instanceId) => ({
      instanceId,
      componentId: assignments.find((assignment) => assignment.targetInstanceId === instanceId)?.targetComponentId ?? '',
    }));
    i2cBuses.push({
      id: `i2c-${busIndex}`,
      sdaPin: sda?.pin ?? profile?.i2c.sda ?? '',
      sclPin: scl?.pin ?? profile?.i2c.scl ?? '',
      devices,
    });
  }

  return { serialLinks, i2cBuses };
}

/* ------------------------------------------------------------------------- */
/* Refreshers                                                                 */
/* ------------------------------------------------------------------------- */

export interface RefresherDeps {
  catalog: ComponentDefinition[];
  /** Project state before the fix, used to detect additive-only changes. */
  baseline: ProjectState;
  analysis: PromptAnalysis;
  events?: AgentEventLog;
}

function withProject(project: ProjectState, patch: Partial<ProjectState>): ProjectState {
  return { ...project, ...patch };
}

function artifactsPatch(project: ProjectState, patch: Partial<ProjectState['artifacts']>): ProjectState {
  return { ...project, artifacts: { ...project.artifacts, ...patch } };
}

export function buildRefreshers(deps: RefresherDeps): FixerRefreshers {
  const { catalog, baseline, events } = deps;
  let cachedLinks: { serialLinks: SerialLink[]; i2cBuses: I2CBus[] } | null = null;

  const linksFor = (project: ProjectState, profile?: McuProfile) => {
    if (!cachedLinks) cachedLinks = deriveLinks(project, profile);
    return cachedLinks;
  };

  const refreshers: FixerRefreshers = {
    hardware: (project) => {
      if (!project.requirements) return { project, notes: ['Hardware plan left untouched: no requirements artifact.'] };
      const plan = refreshHardwarePlan({
        selections: project.components,
        catalog,
        requirements: project.requirements,
        previous: project.hardwarePlan,
      });
      return {
        project: withProject(project, { hardwarePlan: plan }),
        notes: [`Hardware plan re-derived: ${plan.architecture.length} block(s), ${plan.subsystems.length} subsystem(s).`],
      };
    },

    pins: (project) => {
      const controller = controllerInfo(project, catalog);
      const result = planPins({
        selections: project.components,
        catalog,
        ...(controller.instanceId ? { controllerInstanceId: controller.instanceId } : {}),
        ...(events ? { events } : {}),
      });
      cachedLinks = { serialLinks: result.serialLinks, i2cBuses: result.i2cBuses };
      const notes = [
        `Pin plan re-derived: ${result.assignments.length} assignment(s)${result.overrides.length > 0 ? `, ${result.overrides.length} override(s)` : ''}.`,
        ...result.unassigned.map((entry) => `Could not assign ${entry.instanceId}.${entry.pin}: ${entry.reason}`),
        ...result.notes,
      ];
      return { project: withProject(project, { pinAssignments: result.assignments }), notes };
    },

    wiring: (project) => {
      const controller = controllerInfo(project, catalog);
      const power = project.hardwarePlan?.power;
      if (!power) return { project, notes: ['Wiring left untouched: no power budget is available.'] };

      const links = linksFor(project, controller.profile);
      const baselineIds = new Set(baseline.components.flatMap((selection) => selection.instances.map((instance) => instance.instanceId)));
      const currentIds = project.components.flatMap((selection) => selection.instances.map((instance) => instance.instanceId));
      const added = currentIds.filter((instanceId) => !baselineIds.has(instanceId));
      const removed = Array.from(baselineIds).filter((instanceId) => !currentIds.includes(instanceId));
      const additiveOnly = removed.length === 0 && added.length > 0 && baseline.wiring !== null;

      if (additiveOnly && project.wiring) {
        const extended = extendWiringPlan({
          existing: project.wiring,
          selections: project.components,
          catalog,
          assignments: project.pinAssignments,
          targetInstanceIds: added,
          power,
          ...(controller.instanceId ? { controllerInstanceId: controller.instanceId } : {}),
          ...(controller.profile ? { profile: controller.profile } : {}),
          ...(events ? { events } : {}),
        });
        return {
          project: withProject(project, { wiring: extended }),
          notes: [`Wiring extended for ${added.length} new instance(s): ${extended.connections.length} connection(s) total.`],
        };
      }

      const plan = planWiring({
        selections: project.components,
        catalog,
        assignments: project.pinAssignments,
        power,
        ...(controller.instanceId ? { controllerInstanceId: controller.instanceId } : {}),
        ...(controller.profile ? { profile: controller.profile } : {}),
        serialLinks: links.serialLinks,
        ...(events ? { events } : {}),
      });
      return {
        project: withProject(project, { wiring: plan }),
        notes: [`Wiring graph re-derived: ${plan.connections.length} connection(s), ${plan.conflicts.length} conflict(s).`],
      };
    },

    code: async (project, options) => {
      const controller = controllerInfo(project, catalog);
      const entry = project.artifacts.code?.files.find((file) => file.path === project.artifacts.code?.entryPoint);
      const broken =
        !entry ||
        !/void\s+setup\s*\(/.test(entry.content) ||
        !/void\s+loop\s*\(/.test(entry.content) ||
        (entry.content.match(/\{/g) ?? []).length !== (entry.content.match(/\}/g) ?? []).length;

      /* Conservative: only rebuild the sketch when it is structurally broken.
         Otherwise re-sync the machine-managed blocks in place. A `force`
         re-derivation (the behavioural fixer) skips this shortcut: the sketch
         may compile yet still violate a checked behaviour, so it is regenerated
         from the deterministic template. */
      if (!broken && !options?.force && project.artifacts.code) {
        let changed = 0;
        const files = project.artifacts.code.files.map((file) => {
          if (!/\.(ino|cpp|c|h|hpp)$/i.test(file.path)) return file;
          const esp32 = /esp32/i.test(controller.componentId ?? '') || /esp32/i.test(controller.profile?.componentId ?? '');
          const withMap = ensurePinMap(file.content, project.pinAssignments, controller.profile);
          const synced = syncPinConstants(withMap, project.pinAssignments);
          const withIncludes = ensureIncludesBlock(synced.content, project.artifacts.libraries?.libraries ?? [], esp32);
          if (withIncludes === file.content) return file;
          changed += 1;
          return { ...file, content: withIncludes, generatedBy: 'fixer' as const };
        });
        return {
          project: artifactsPatch(project, { code: { ...project.artifacts.code, files, pinsSynchronised: true } }),
          notes: [`Firmware re-synchronised in place (${changed} file(s) touched).`],
        };
      }

      if (!project.requirements || !project.softwarePlan) {
        return { project, notes: ['Firmware left untouched: requirements or software plan missing.'] };
      }

      const links = linksFor(project, controller.profile);
      /* The rebuild keeps the same AI-first rooting contract as the initial
         build: the model authors the logic, Wireup re-derives the managed
         blocks from the (possibly patched) pin plan. */
      const bedrock = await describeBedrockConfig();
      const code = await generateCode({
        projectName: project.name,
        projectSummary: project.requirements.summary,
        requirements: project.requirements,
        selections: project.components,
        catalog,
        assignments: project.pinAssignments,
        serialLinks: links.serialLinks,
        i2cBuses: links.i2cBuses,
        softwarePlan: project.softwarePlan,
        controllerName: controller.name,
        ...(controller.profile ? { profile: controller.profile } : {}),
        revision: project.revision,
        prompt: project.prompt,
        ...((bedrock.configured || Boolean(process.env.GEMINI_API_KEY)) && llmCodegenEnabled()
          ? { llmProvider: bedrockSketchPlanProvider() }
          : {}),
        ...(events ? { events } : {}),
      });
      return {
        project: artifactsPatch(project, { code }),
        notes: [`Firmware rebuilt from the software plan (${code.files.length} file(s)): the previous sketch was structurally broken.`],
      };
    },

    libraries: (project) => {
      if (!project.softwarePlan) return { project, notes: ['Libraries left untouched: no software plan.'] };
      const controller = controllerInfo(project, catalog);
      const libraries = generateLibraries({
        softwarePlan: project.softwarePlan,
        selections: project.components,
        catalog,
        ...(controller.componentId ? { controllerComponentId: controller.componentId } : {}),
        ...(events ? { events } : {}),
      });
      return {
        project: artifactsPatch(project, { libraries }),
        notes: [`libraries.json re-derived: ${libraries.libraries.length} entr(ies).`],
      };
    },

    diagram: (project) => {
      if (!project.requirements) return { project, notes: ['Diagram left untouched: no requirements artifact.'] };
      const diagram = generateDiagram({
        projectId: project.id,
        revision: project.revision,
        projectName: project.name,
        projectSummary: project.requirements.summary,
        requirements: project.requirements,
        selections: project.components,
        catalog,
        assignments: project.pinAssignments,
        wiring: project.wiring,
        hardwarePlan: project.hardwarePlan,
        ...(events ? { events } : {}),
      });
      return {
        project: artifactsPatch(project, { diagram }),
        notes: [`diagram.json re-derived: ${diagram.stats.components} component(s), ${diagram.stats.connections} wire(s).`],
      };
    },

    instructions: (project) => {
      if (!project.requirements) return { project, notes: ['Instructions left untouched: no requirements artifact.'] };
      const controller = controllerInfo(project, catalog);
      const instructions = generateInstructions({
        projectName: project.name,
        projectSummary: project.requirements.summary,
        requirements: project.requirements,
        selections: project.components,
        catalog,
        hardwarePlan: project.hardwarePlan,
        pinAssignments: project.pinAssignments,
        wiring: project.wiring,
        softwarePlan: project.softwarePlan,
        libraries: project.artifacts.libraries,
        diagram: project.artifacts.diagram,
        controllerName: controller.name,
        ...(controller.componentId ? { controllerComponentId: controller.componentId } : {}),
        revision: project.revision,
        ...(events ? { events } : {}),
      });
      return {
        project: artifactsPatch(project, { instructions }),
        notes: [`Instructions re-derived: ${instructions.sections.length} section(s).`],
      };
    },
  };

  return refreshers;
}

/** Software plan re-derivation (not a `rerun_stage` op — always available). */
export function refreshSoftware(project: ProjectState, catalog: ComponentDefinition[], events?: AgentEventLog): RefreshResult {
  if (!project.requirements) return { project, notes: ['Software plan left untouched: no requirements artifact.'] };
  const controller = controllerInfo(project, catalog);
  const links = deriveLinks(project, controller.profile);
  try {
    const softwarePlan = planSoftware({
      requirements: project.requirements,
      selections: project.components,
      catalog,
      assignments: project.pinAssignments,
      serialLinks: links.serialLinks,
      i2cBuses: links.i2cBuses,
      ...(controller.instanceId ? { controllerInstanceId: controller.instanceId } : {}),
      ...(controller.componentId ? { controllerComponentId: controller.componentId } : {}),
      ...(events ? { events } : {}),
    });
    return {
      project: withProject(project, { softwarePlan }),
      notes: [`Software plan re-derived: ${softwarePlan.modules.length} module(s), ${softwarePlan.libraries.length} library(ies).`],
    };
  } catch (error) {
    logger.warn({ err: error }, 'software plan refresh failed');
    return { project, notes: ['Software plan refresh failed; the previous plan was kept.'] };
  }
}
