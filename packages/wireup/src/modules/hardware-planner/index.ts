/**
 * Hardware planner.
 *
 * Input : structured requirements + the component database (+ the model's
 *         component suggestions).
 * Output: real catalog components with quantities and reasons, an expanded
 *         instance list, power budget, compatibility analysis and the hardware
 *         architecture.
 *
 * The model never gets the final say on parts: everything it names is matched
 * back onto the catalog, and anything missing is added by engineering rules.
 */

import { z } from 'zod';

import type { ComponentCategory, ComponentDefinition, ComponentInstance, ComponentRole, ComponentSelection } from '@/types/component';
import type { HardwareBlock, HardwarePlan, ProjectRequirements, Subsystem } from '@/types/project';
import type { AgentEventLog } from '@/lib/logging/events';
import { selectionId } from '@/lib/validation/ids';
import { instanceId as buildInstanceId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';

import { findComponentById, matchComponentStrict } from '@/modules/components/service';
import { buildProvisionalComponent, isProvisional, matchContract } from '@/modules/components/contracts';
import { demandRecord, recordDemandBatch, type DemandRecord } from '@/modules/components/demand';
import { getMcuProfile } from '@/modules/pin-planner/mcu-profiles';

import { checkCompatibility } from './compatibility';
import { applyEngineeringDefaults } from './defaults';
import { computePowerBudget, isElectricallyActive } from './power';
import type { DraftSelection, HardwarePlannerInput, HardwarePlanResult } from './types';

export const ROLE_BY_CATEGORY: Record<ComponentCategory, ComponentRole> = {
  microcontroller: 'controller',
  motor: 'actuator',
  motor_driver: 'driver',
  sensor: 'sensor',
  communication: 'communication',
  actuator: 'actuator',
  display: 'display',
  power: 'power',
  passive: 'passive',
  discrete: 'passive',
  electromechanical: 'actuator',
  input_device: 'input',
  prototyping: 'prototyping',
  other: 'other',
};

const ModelComponentSchema = z
  .object({
    componentId: z.string().optional().catch(undefined),
    id: z.string().optional().catch(undefined),
    catalogId: z.string().optional().catch(undefined),
    name: z.string().optional().catch(undefined),
    part: z.string().optional().catch(undefined),
    quantity: z.union([z.number(), z.string()]).optional().catch(undefined),
    role: z.string().optional().catch(undefined),
    reason: z.string().optional().catch(undefined),
    justification: z.string().optional().catch(undefined),
    required: z.boolean().optional().catch(undefined),
    instanceLabels: z.array(z.string()).optional().catch(undefined),
    labels: z.array(z.string()).optional().catch(undefined),
    notes: z.string().optional().catch(undefined),
  })
  .passthrough();

function parseQuantity(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.min(12, Math.max(1, Math.round(value)));
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.replace(/[^0-9]/g, ''), 10);
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(12, parsed);
  }
  return 1;
}

function normaliseRole(value: unknown, category: ComponentCategory): ComponentRole {
  const known: ComponentRole[] = ['controller', 'driver', 'sensor', 'actuator', 'communication', 'power', 'input', 'display', 'passive', 'prototyping', 'other'];
  if (typeof value === 'string') {
    const normalised = value.toLowerCase().trim();
    if ((known as string[]).includes(normalised)) return normalised as ComponentRole;
    if (normalised === 'motors' || normalised === 'motor') return 'actuator';
    if (normalised === 'mcu' || normalised === 'microcontroller') return 'controller';
  }
  return ROLE_BY_CATEGORY[category] ?? 'other';
}

/**
 * Minimum score at which a fuzzy match is treated as *this specific part*
 * rather than "something in the same family". Exact id and alias hits bypass
 * this entirely; anything below it defers to a contract when one exists.
 */
const CONFIDENT_MATCH = 85;

/** Map model component suggestions onto real catalog parts. */
export function normaliseModelSelections(
  raw: unknown,
  catalog: ComponentDefinition[],
): {
  drafts: DraftSelection[];
  unmatched: { query: string; reason: string }[];
  /** Contract-derived parts synthesised for requests the catalog could not serve. */
  provisional: ComponentDefinition[];
  /** One telemetry row per request, so catalog gaps become measurable. */
  demand: DemandRecord[];
} {
  const drafts: DraftSelection[] = [];
  const unmatched: { query: string; reason: string }[] = [];
  const provisional: ComponentDefinition[] = [];
  const demand: DemandRecord[] = [];

  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];

  for (const entry of list) {
    const parsed = ModelComponentSchema.safeParse(entry);
    if (!parsed.success) {
      unmatched.push({ query: JSON.stringify(entry).slice(0, 120), reason: 'entry was not an object' });
      demand.push(demandRecord(JSON.stringify(entry).slice(0, 120), 'unmatched'));
      continue;
    }
    const value = parsed.data;
    const query = value.componentId ?? value.id ?? value.catalogId ?? value.name ?? value.part ?? '';
    if (!query) {
      unmatched.push({ query: '(empty)', reason: 'no component identifier supplied' });
      demand.push(demandRecord('(empty)', 'unmatched'));
      continue;
    }

    const exact = findComponentById(String(query), catalog);
    const match = exact ? { definition: exact, score: 100, via: 'id' as const } : matchComponentStrict(String(query), catalog);
    const fallback = match ? undefined : matchComponentStrict(String(value.name ?? ''), catalog);
    let resolved = match ?? fallback;

    /*
     * Prefer an honest contract over a weak substitution.
     *
     * A score below CONFIDENT_MATCH means the matcher landed on a *family*
     * word, not the part: "DS3218 waterproof servo" hits the SG90 at 80 purely
     * because both contain "servo". Silently shipping an SG90 (500 mA stall)
     * when the user asked for a DS3218 (2.5 A stall) understates the supply by
     * 5x, and nothing downstream can tell that happened.
     *
     * When a contract recognises the same request, the provisional part is
     * strictly better: identical wiring, worst-case ratings, and an explicit
     * record of what is unverified. An exact id/alias hit always wins.
     */
    if (resolved && resolved.score < CONFIDENT_MATCH && resolved.via !== 'id' && resolved.via !== 'alias') {
      const contract = matchContract(String(query));
      if (contract) resolved = undefined;
    }

    /*
     * No catalog part. Before dropping the request, try to recognise the
     * *electrical family* it belongs to. A recognised contract gives a
     * provisional part with the family's worst-case envelope and an explicit
     * list of unverified fields — a working, honest design instead of either a
     * silent substitution or a missing component.
     */
    if (!resolved) {
      const contract = matchContract(String(query));
      const substitute = match ?? fallback;
      if (contract) {
        const synthesised = buildProvisionalComponent(String(query), contract);
        provisional.push(synthesised);
        demand.push(
          demandRecord(String(query), 'provisional', {
            resolvedTo: synthesised.id,
            score: contract.score,
            contract: contract.contract.id,
          }),
        );
        drafts.push({
          componentId: synthesised.id,
          quantity: parseQuantity(value.quantity),
          role: normaliseRole(value.role, synthesised.category),
          reason:
            (value.reason ?? value.justification ?? '').trim() ||
            `Recognised as a ${contract.contract.family}; not a verified catalog part.`,
          required: value.required ?? true,
          source: 'model',
          matchedFrom: String(query),
          notes:
            `Provisional part built from the "${contract.contract.family}" contract. Confirm the datasheet before building.` +
            (substitute
              ? ` Wireup deliberately did not substitute ${substitute.definition.name}, which only matched on a family keyword.`
              : ''),
          ...(labelsOf(value).length > 0 ? { labels: labelsOf(value) } : {}),
        });
        continue;
      }

      unmatched.push({ query: String(query), reason: 'no catalog entry matched this name' });
      demand.push(demandRecord(String(query), 'unmatched'));
      continue;
    }

    const definition = resolved.definition;
    const isExact = Boolean(exact) || resolved.via === 'id' || resolved.via === 'alias';
    demand.push(
      demandRecord(String(query), isExact ? 'catalog' : 'substituted', {
        resolvedTo: definition.id,
        score: resolved.score,
      }),
    );
    const labels = (value.instanceLabels ?? value.labels ?? []).map((label) => String(label).trim()).filter(Boolean);

    drafts.push({
      componentId: definition.id,
      quantity: parseQuantity(value.quantity),
      role: normaliseRole(value.role, definition.category),
      reason: (value.reason ?? value.justification ?? '').trim() || `Selected for the ${definition.category} role it fills in this design.`,
      required: value.required ?? definition.category !== 'prototyping',
      source: exact || resolved.via === 'id' ? 'catalog' : 'model',
      ...(exact || resolved.via === 'id' ? {} : { matchedFrom: String(query) }),
      ...(value.notes ? { notes: value.notes } : {}),
      ...(labels.length > 0 ? { labels } : {}),
    });
  }

  return { drafts, unmatched, provisional, demand };
}

/** Instance labels supplied by the model, normalised. */
function labelsOf(value: { instanceLabels?: unknown[]; labels?: unknown[] }): string[] {
  return (value.instanceLabels ?? value.labels ?? []).map((label) => String(label).trim()).filter(Boolean);
}

/** Merge duplicate component ids so quantities stay consistent. */
export function mergeDrafts(drafts: DraftSelection[]): DraftSelection[] {
  const merged = new Map<string, DraftSelection>();

  for (const draft of drafts) {
    const existing = merged.get(draft.componentId);
    if (!existing) {
      merged.set(draft.componentId, { ...draft });
      continue;
    }
    const combined: DraftSelection = {
      ...existing,
      quantity: Math.min(24, existing.quantity + draft.quantity),
      reason:
        existing.reason.toLowerCase() === draft.reason.toLowerCase()
          ? existing.reason
          : `${existing.reason} ${draft.reason}`.trim(),
      required: existing.required || draft.required,
      labels: [...(existing.labels ?? []), ...(draft.labels ?? [])],
      source: existing.source === 'planner' ? 'planner' : draft.source === 'planner' ? existing.source : existing.source,
      ...(existing.matchedFrom || draft.matchedFrom ? { matchedFrom: existing.matchedFrom ?? draft.matchedFrom } : {}),
    };
    merged.set(draft.componentId, combined);
  }

  return [...merged.values()];
}

function labelFor(definition: ComponentDefinition, index: number, quantity: number, labels?: string[]): string {
  const supplied = labels?.[index - 1];
  if (supplied && supplied.trim().length > 0) return supplied.trim();
  if (quantity === 1) return definition.name;
  if (definition.category === 'motor' && definition.motorRequirements?.motorType === 'dc' && quantity === 2) {
    return index === 1 ? 'Motor A (left channel)' : 'Motor B (right channel)';
  }
  return `${definition.name} ${index}`;
}

/** Materialise concrete instances so wiring/pins/diagram can address them. */
export function expandSelections(drafts: DraftSelection[], catalog: ComponentDefinition[]): ComponentSelection[] {
  const selections: ComponentSelection[] = [];

  for (const draft of drafts) {
    const definition = catalog.find((component) => component.id === draft.componentId);
    if (!definition) continue;

    const instances: ComponentInstance[] = [];
    for (let index = 1; index <= draft.quantity; index += 1) {
      instances.push({
        instanceId: buildInstanceId(definition.id, index),
        componentId: definition.id,
        name: definition.name,
        index,
        label: labelFor(definition, index, draft.quantity, draft.labels),
        category: definition.category,
      });
    }

    selections.push({
      id: selectionId(),
      componentId: definition.id,
      name: definition.name,
      category: definition.category,
      role: draft.role,
      quantity: draft.quantity,
      reason: draft.reason,
      required: draft.required,
      instances,
      source: draft.source,
      ...(draft.matchedFrom ? { matchedFrom: draft.matchedFrom } : {}),
      ...(draft.notes ? { notes: draft.notes } : {}),
    });
  }

  return selections;
}

function groupBySubsystem(selections: ComponentSelection[]): Record<string, ComponentSelection[]> {
  const groups: Record<string, ComponentSelection[]> = {
    control: [],
    drive: [],
    sensing: [],
    communication: [],
    actuation: [],
    display: [],
    power: [],
    support: [],
  };

  for (const selection of selections) {
    switch (selection.role) {
      case 'controller':
        groups.control.push(selection);
        break;
      case 'driver':
        groups.drive.push(selection);
        break;
      case 'sensor':
        groups.sensing.push(selection);
        break;
      case 'communication':
        groups.communication.push(selection);
        break;
      case 'input':
        groups.sensing.push(selection);
        break;
      case 'display':
        groups.display.push(selection);
        break;
      case 'actuator':
        if (selection.category === 'motor') groups.drive.push(selection);
        else groups.actuation.push(selection);
        break;
      case 'power':
        groups.power.push(selection);
        break;
      default:
        groups.support.push(selection);
        break;
    }
  }

  return groups;
}

const SUBSYSTEM_META: Record<string, { name: string; kind: HardwareBlock['kind']; description: string }> = {
  control: { name: 'Control', kind: 'controller', description: 'Executes the firmware, reads inputs and drives outputs.' },
  drive: { name: 'Drive train', kind: 'drive', description: 'Power stage that converts logic signals into motor motion.' },
  sensing: { name: 'Sensing & input', kind: 'sensing', description: 'Sensors and user inputs that inform the control logic.' },
  communication: { name: 'Communication', kind: 'communication', description: 'Wireless or wired link used for commands and telemetry.' },
  actuation: { name: 'Indication & actuation', kind: 'actuation', description: 'Lights, sound and switching outputs.' },
  display: { name: 'Display', kind: 'actuation', description: 'Visual output of state and sensor data.' },
  power: { name: 'Power', kind: 'power', description: 'Energy source, regulation and protection.' },
  support: { name: 'Support & assembly', kind: 'support', description: 'Passives, connectors and the prototyping medium.' },
};

function buildSubsystems(selections: ComponentSelection[]): Subsystem[] {
  const groups = groupBySubsystem(selections);
  const subsystems: Subsystem[] = [];

  for (const [key, members] of Object.entries(groups)) {
    if (members.length === 0) continue;
    const meta = SUBSYSTEM_META[key];
    if (!meta) continue;

    subsystems.push({
      id: key,
      name: meta.name,
      description: meta.description,
      instanceIds: members.flatMap((member) => member.instances.map((instance) => instance.instanceId)),
      inputs:
        key === 'drive' || key === 'actuation'
          ? ['logic signals from the controller']
          : key === 'sensing'
            ? ['physical environment / user']
            : key === 'power'
              ? ['battery or external supply']
              : [],
      outputs:
        key === 'sensing'
          ? ['electrical signals to the controller']
          : key === 'drive'
            ? ['mechanical motion']
            : key === 'power'
              ? ['regulated voltage rails']
              : key === 'communication'
                ? ['wireless link to the user device']
                : [],
    });
  }

  return subsystems;
}

function buildArchitecture(selections: ComponentSelection[]): HardwareBlock[] {
  const groups = groupBySubsystem(selections);
  const blocks: HardwareBlock[] = [];

  for (const [key, members] of Object.entries(groups)) {
    if (members.length === 0) continue;
    const meta = SUBSYSTEM_META[key];
    if (!meta) continue;
    blocks.push({
      id: key,
      name: meta.name,
      description: members.map((member) => `${member.quantity}x ${member.name}`).join(', '),
      instanceIds: members.flatMap((member) => member.instances.map((instance) => instance.instanceId)),
      kind: meta.kind,
    });
  }

  return blocks;
}

function buildSignalFlow(selections: ComponentSelection[], requirements: HardwarePlannerInput['requirements']): string[] {
  const flow: string[] = [];
  const groups = groupBySubsystem(selections);

  const sources: string[] = [];
  for (const selection of groups.communication) sources.push(`${selection.name} command link`);
  for (const selection of groups.sensing) sources.push(`${selection.name} reading`);
  if (sources.length === 0) sources.push('Firmware start-up');

  flow.push(...sources);

  const controller = groups.control[0];
  flow.push(controller ? `${controller.name} firmware (input handling → control logic)` : 'Controller firmware');

  for (const requirement of requirements.behaviors.slice(0, 3)) flow.push(`Behaviour: ${requirement}`);

  for (const selection of groups.drive) {
    if (selection.role === 'driver') flow.push(`${selection.name} power stage`);
  }
  for (const selection of groups.drive) {
    if (selection.category === 'motor') flow.push(`${selection.name} motion`);
  }
  for (const selection of groups.actuation) flow.push(`${selection.name} output`);
  for (const selection of groups.display) flow.push(`${selection.name} readout`);

  return [...new Set(flow)];
}

/** Build the hardware plan: parts, instances, power, compatibility, architecture. */
export async function planHardware(input: HardwarePlannerInput, events?: AgentEventLog): Promise<HardwarePlanResult> {
  const { catalog, requirements, analysis } = input;

  const searchHandle = events?.start('component_search_started', 'Searching component database...', {
    stage: 'catalog',
    metadata: { catalogSize: catalog.length },
  });

  const { drafts: normalisedModelDrafts, unmatched, provisional, demand } = normaliseModelSelections(
    input.modelComponents,
    catalog,
  );

  const modelNotes: string[] = [];
  const vehiclePrompt = /\b(rc[-\s]*car|robot[-\s]*car|tank|rover|remote[-\s]*controlled\s+(?:car|vehicle|truck))\b/i.test(analysis.prompt);
  const explicitlyRequestsLighting = analysis.features.includes('lighting') || /\b(led|neopixel|lamp|status\s+light)\b/i.test(analysis.prompt);
  // A hallucinated LED + resistor pair was previously able to become the
  // visible "RC car" circuit when the model omitted all drive hardware. Keep
  // user-requested lighting, but remove that unrelated pair from a vehicle
  // build; the deterministic motor/driver rules below then own the topology.
  const modelDrafts = vehiclePrompt && !explicitlyRequestsLighting
    ? normalisedModelDrafts.filter((draft) => !/(?:led|resistor)/i.test(draft.componentId))
    : normalisedModelDrafts;
  if (modelDrafts.length !== normalisedModelDrafts.length) {
    modelNotes.push('Removed an unrelated model-selected LED/resistor pair from the RC vehicle; it was not requested and cannot replace the drive train.');
  }

  /*
   * Provisional parts join the working catalog so every downstream stage — pin
   * planning, wiring, diagram, firmware — treats them like any other part. What
   * makes them different is carried in `metadata.provisional`, not in a special
   * code path, so there is no second pipeline to keep in sync.
   */
  const workingCatalog = provisional.length > 0 ? [...catalog, ...provisional] : catalog;

  searchHandle?.complete(
    `Component database searched — ${modelDrafts.length} model suggestion(s) matched to real parts, ` +
      `${provisional.length} built from an electrical contract, ${unmatched.length} unmatched`,
    {
      matched: modelDrafts.length,
      provisional: provisional.map((component) => component.id),
      unmatched: unmatched.map((entry) => entry.query),
    },
  );

  for (const component of provisional) {
    events?.emit(
      'info',
      `"${component.metadata.requestedAs}" is not in the component database — built a provisional part from the ${component.metadata.contractFamily} contract.`,
      {
        stage: 'hardware',
        status: 'info',
        metadata: {
          componentId: component.id,
          contract: component.metadata.contractId,
          unverifiedFields: component.metadata.unverifiedFields,
        },
      },
    );
  }

  // Telemetry is fire-and-forget: a demand log must never delay or fail a build.
  void recordDemandBatch(demand);

  const defaults = applyEngineeringDefaults({ drafts: modelDrafts, catalog: workingCatalog, requirements, analysis });
  const mergedDrafts = mergeDrafts([...modelDrafts, ...defaults.additions]);

  const selections = expandSelections(mergedDrafts, workingCatalog);
  const controller = selections.find((selection) => selection.role === 'controller') ?? null;

  for (const selection of selections) {
    events?.emit('component_selected', `Selected ${selection.quantity}x ${selection.name}`, {
      stage: 'hardware',
      status: 'completed',
      metadata: {
        componentId: selection.componentId,
        quantity: selection.quantity,
        role: selection.role,
        reason: selection.reason,
        source: selection.source,
        instances: selection.instances.map((instance) => instance.instanceId),
      },
    });
  }

  const profile = controller ? getMcuProfile(controller.componentId) : undefined;

  const power = computePowerBudget({ selections, catalog: workingCatalog, controller, ...(profile ? { profile } : {}) });
  const { checks, risks } = checkCompatibility({ selections, catalog: workingCatalog, controller, ...(profile ? { profile } : {}) });

  const subsystems = buildSubsystems(selections);
  const architecture = buildArchitecture(selections);
  const signalFlow = buildSignalFlow(selections, requirements);

  const supportingComponents = selections
    .filter((selection) => selection.source === 'planner')
    .flatMap((selection) =>
      selection.instances.map((instance) => ({
        instanceId: instance.instanceId,
        componentId: selection.componentId,
        reason: selection.reason,
      })),
    );

  const motorCount = selections.reduce((sum, selection) => (selection.category === 'motor' ? sum + selection.quantity : sum), 0);
  const sensorCount = selections.reduce((sum, selection) => (selection.role === 'sensor' ? sum + selection.quantity : sum), 0);

  const summaryParts = [
    controller ? `${controller.name} as the controller` : 'no controller selected',
    motorCount > 0 ? `${motorCount} motor channel(s)` : null,
    sensorCount > 0 ? `${sensorCount} sensor(s)` : null,
    power.supplyVoltage !== undefined ? `${power.supplyVoltage} V supply` : 'power source unresolved',
    `${selections.length} distinct parts`,
  ].filter(Boolean) as string[];

  const provisionalNotes = provisional.map(
    (component) =>
      `"${component.metadata.requestedAs}" is not a verified catalog part. Wireup recognised it as a ` +
      `${component.metadata.contractFamily} and used that family's worst-case values. Confirm before building: ` +
      `${(component.metadata.verification as string[] | undefined)?.join(' ') ?? 'the datasheet electrical ratings.'}`,
  );

  const notes = [
    ...modelNotes,
    ...defaults.notes,
    ...provisionalNotes,
    ...unmatched.map((entry) => `Model requested "${entry.query}" which is not in the component database (${entry.reason}).`),
    ...power.notes.filter((note) => !power.adequate || /exceed|mismatch|No explicit/i.test(note)),
  ];

  const inactive = selections.filter((selection) => {
    const definition = workingCatalog.find((component) => component.id === selection.componentId);
    return !isElectricallyActive(definition);
  });
  if (inactive.length > 0) {
    notes.push(
      `${inactive.map((selection) => selection.name).join(', ')} are assembly/medium items and are intentionally excluded from the electrical connection graph.`,
    );
  }

  const plan: HardwarePlan = {
    summary: `Hardware architecture: ${summaryParts.join(', ')}.`,
    architecture,
    controller: controller
      ? {
          instanceId: controller.instances[0]?.instanceId ?? controller.componentId,
          componentId: controller.componentId,
          name: controller.name,
          reason: controller.reason,
        }
      : null,
    power,
    subsystems,
    signalFlow,
    compatibility: checks,
    supportingComponents,
    risks: [
      ...new Set([
        ...risks,
        ...power.notes.filter((note) => /exceeds|cannot|mismatch|brown/i.test(note)),
        ...provisional.map(
          (component) =>
            `${component.name} is provisional: ${(component.metadata.unverifiedFields as string[] | undefined)?.join(', ') ?? 'key ratings'} are unverified, so the power budget for it is an estimate.`,
        ),
      ]),
    ],
  };

  events?.emit('hardware_plan_completed', `Hardware plan complete — ${selections.length} parts, ${plan.architecture.length} subsystem block(s)`, {
    stage: 'hardware',
    status: 'completed',
    metadata: {
      parts: selections.length,
      instances: selections.reduce((sum, selection) => sum + selection.instances.length, 0),
      powerAdequate: power.adequate,
      totalPeakMa: power.totalPeakMa ?? null,
      risks: risks.length,
      completedAt: nowIso(),
    },
  });

  return { selections, plan, unmatched, provisional, notes: [...new Set(notes)] };
}

/* ------------------------------------------------------------------------- */
/* Refresh (used by the fixer)                                                */
/*                                                                            */
/* Recomputes everything that is *derived* from the component list — power     */
/* budget, architecture blocks, subsystems, signal flow, compatibility — while */
/* keeping the patched selections exactly as they are. No model call, no        */
/* engineering defaults, no regeneration of the bill of materials.              */
/* ------------------------------------------------------------------------- */

export interface HardwareRefreshInput {
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  requirements: ProjectRequirements;
  /** Previous plan, used to preserve the controller rationale and summary. */
  previous?: HardwarePlan | null;
}

export function refreshHardwarePlan(input: HardwareRefreshInput): HardwarePlan {
  const { selections, catalog, requirements, previous } = input;
  const controller = selections.find((selection) => selection.role === 'controller') ?? null;
  const profile = controller ? getMcuProfile(controller.componentId) : undefined;

  const power = computePowerBudget({ selections, catalog, controller, ...(profile ? { profile } : {}) });
  const { checks, risks } = checkCompatibility({ selections, catalog, controller, ...(profile ? { profile } : {}) });

  const subsystems = buildSubsystems(selections);
  const architecture = buildArchitecture(selections);
  const signalFlow = buildSignalFlow(selections, requirements);

  const supportingComponents = selections
    .filter((selection) => selection.source === 'planner')
    .flatMap((selection) =>
      selection.instances.map((instance) => ({
        instanceId: instance.instanceId,
        componentId: selection.componentId,
        reason: selection.reason,
      })),
    );

  const motorCount = selections.reduce((sum, selection) => (selection.category === 'motor' ? sum + selection.quantity : sum), 0);
  const sensorCount = selections.reduce((sum, selection) => (selection.role === 'sensor' ? sum + selection.quantity : sum), 0);
  const summaryParts = [
    controller ? `${controller.name} as the controller` : 'no controller selected',
    motorCount > 0 ? `${motorCount} motor channel(s)` : null,
    sensorCount > 0 ? `${sensorCount} sensor(s)` : null,
    power.supplyVoltage !== undefined ? `${power.supplyVoltage} V supply` : 'power source unresolved',
    `${selections.length} distinct parts`,
  ].filter(Boolean) as string[];

  return {
    summary: `Hardware architecture: ${summaryParts.join(', ')}.`,
    architecture,
    controller: controller
      ? {
          instanceId: controller.instances[0]?.instanceId ?? controller.componentId,
          componentId: controller.componentId,
          name: controller.name,
          reason: previous?.controller?.reason ?? controller.reason,
        }
      : null,
    power,
    subsystems,
    signalFlow,
    compatibility: checks,
    supportingComponents,
    risks: [...new Set([...risks, ...power.notes.filter((note) => /exceeds|cannot|mismatch|brown/i.test(note))])],
  };
}
