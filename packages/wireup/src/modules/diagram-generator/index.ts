/**
 * Diagram generator — produces `diagram.json`.
 *
 * The diagram is derived from the structured project (component instances, pin
 * assignments and the wiring graph), never written by hand and never hardcoded
 * for a specific build. Keeping it in its own module means the output format can
 * be swapped (see `wokwi.ts`) without touching any planner.
 */

import type { ComponentDefinition, ComponentSelection } from '@/types/component';
import type { Diagram, DiagramComponent, DiagramConnection, DiagramGroup, DiagramRail } from '@/types/diagram';
import type { HardwarePlan, ProjectRequirements } from '@/types/project';
import type { PinAssignment, WiringPlan } from '@/types/wiring';
import type { AgentEventLog } from '@/lib/logging/events';
import { nowIso } from '@/lib/validation/time';

import { resolvePinName } from '@/modules/wiring-planner/conflicts';

import { layoutComponents, GRID_SIZE, type LayoutInput } from './layout';

import { unescapeHtmlEntities } from '@/lib/text/entities';

export const DIAGRAM_GENERATOR = 'wireup-diagram-generator/1.0';

export interface DiagramGeneratorInput {
  projectId: string;
  revision: number;
  projectName: string;
  projectSummary: string;
  requirements: ProjectRequirements;
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  assignments: PinAssignment[];
  wiring: WiringPlan | null;
  hardwarePlan: HardwarePlan | null;
  events?: AgentEventLog;
}

function includeInDiagram(definition: ComponentDefinition | undefined): boolean {
  if (!definition) return true;
  if (definition.metadata.integrated === true) return false;
  return true;
}

export function generateDiagram(input: DiagramGeneratorInput): Diagram {
  const handle = input.events?.start('diagram_generation_started', 'Generating diagram.json...', {
    stage: 'diagram',
    metadata: { connections: input.wiring?.connections.length ?? 0 },
  });

  const entries: LayoutInput[] = [];
  for (const selection of input.selections) {
    const definition = input.catalog.find((component) => component.id === selection.componentId);
    if (!includeInDiagram(definition)) continue;
    for (const instance of selection.instances) {
      entries.push({ instanceId: instance.instanceId, ...(definition ? { definition } : {}), ...(instance.label ? { label: instance.label } : {}) });
    }
  }

  const layout = layoutComponents(entries);
  const componentsById = new Map(layout.components.map((component) => [component.id, component]));

  // Annotate pins with their MCU binding and connectivity.
  // `assignedTo` records the MCU binding; `connected` is only set from the
  // wiring graph below so a pin is never shown as wired without a wire.
  for (const assignment of input.assignments) {
    const target = componentsById.get(assignment.targetInstanceId);
    const targetPin = target ? findDiagramPin(target, assignment.targetPin, input.catalog) : undefined;
    if (targetPin) targetPin.assignedTo = assignment.pin;
  }

  const connections: DiagramConnection[] = [];
  const skipped: string[] = [];

  const seenConnectionKeys = new Set<string>();
  for (const connection of input.wiring?.connections ?? []) {
    const fromComponent = componentsById.get(connection.from.instanceId);
    const toComponent = componentsById.get(connection.to.instanceId);
    if (!fromComponent || !toComponent) {
      skipped.push(`${connection.id} (${connection.from.instanceId} → ${connection.to.instanceId})`);
      continue;
    }
    // A part wired to itself is never a real wire — drop it rather than draw it.
    if (connection.from.instanceId === connection.to.instanceId) {
      skipped.push(`${connection.id} (self-connection on ${connection.from.instanceId})`);
      continue;
    }
    const key = [`${connection.from.instanceId}:${connection.from.pin}`, `${connection.to.instanceId}:${connection.to.pin}`]
      .map((part) => part.toLowerCase())
      .sort()
      .join('|');
    if (seenConnectionKeys.has(key)) {
      skipped.push(`${connection.id} (duplicate wire)`);
      continue;
    }
    seenConnectionKeys.add(key);

    const fromPin = findDiagramPin(fromComponent, connection.from.pin, input.catalog);
    const toPin = findDiagramPin(toComponent, connection.to.pin, input.catalog);
    if (fromPin) fromPin.connected = true;
    if (toPin) toPin.connected = true;

    const path = routeBetween(fromPin?.x, fromPin?.y, toPin?.x, toPin?.y);

    connections.push({
      id: connection.id,
      from: { component: connection.from.instanceId, pin: connection.from.pin },
      to: { component: connection.to.instanceId, pin: connection.to.pin },
      kind: connection.kind,
      signal: connection.signal,
      ...(connection.explanation ? { label: shorten(connection.explanation, 90) } : {}),
      ...(connection.wireColor ? { wireColor: connection.wireColor } : {}),
      ...(connection.voltage !== undefined ? { voltage: connection.voltage } : {}),
      ...(path ? { path } : {}),
    });
  }

  const rails: DiagramRail[] = (input.wiring?.nets ?? [])
    .filter((net) => net.members.length > 1)
    .map((net) => ({
      id: net.id,
      name: net.name,
      kind: net.kind === 'ground' ? ('ground' as const) : ('power' as const),
      ...(net.voltage !== undefined ? { voltage: net.voltage } : {}),
      members: net.members.map((member) => ({ component: member.instanceId, pin: member.pin })),
    }));

  const groups: DiagramGroup[] = (input.hardwarePlan?.subsystems ?? [])
    .map((subsystem) => ({
      id: subsystem.id,
      name: unescapeHtml(subsystem.name),
      description: unescapeHtml(subsystem.description),
      memberIds: subsystem.instanceIds.filter((instanceId) => componentsById.has(instanceId)),
    }))
    .filter((group) => group.memberIds.length > 0);

  const diagram: Diagram = {
    version: '1.0',
    format: 'wireup-diagram',
    generator: DIAGRAM_GENERATOR,
    createdAt: nowIso(),
    projectId: input.projectId,
    revision: input.revision,
    meta: {
      title: input.projectName,
      description: input.projectSummary || input.requirements.goal,
      ...(input.requirements.detectedPlatform ? { platform: input.requirements.detectedPlatform } : {}),
      ...(input.hardwarePlan?.controller?.instanceId ? { controllerInstanceId: input.hardwarePlan.controller.instanceId } : {}),
      simulatorTarget: 'generic',
      units: 'px',
      gridSize: GRID_SIZE,
    },
    components: layout.components,
    connections,
    rails,
    groups,
    layout: { width: layout.width, height: layout.height, columns: layout.columns, rows: layout.rows },
    stats: {
      components: layout.components.length,
      connections: connections.length,
      powerConnections: connections.filter((connection) => connection.kind === 'power').length,
      groundConnections: connections.filter((connection) => connection.kind === 'ground').length,
      signalConnections: connections.filter((connection) => connection.kind === 'signal').length,
      pins: layout.components.reduce((sum, component) => sum + component.pins.length, 0),
    },
  };

  handle?.complete(
    `diagram.json generated — ${diagram.stats.components} component(s), ${diagram.stats.connections} connection(s), ${diagram.stats.pins} pin(s)`,
    { ...diagram.stats, skipped: skipped.length, rails: rails.length, groups: groups.length },
  );

  return diagram;
}

/** Locate a diagram pin by name, falling back to the catalog aliases. */
function findDiagramPin(component: DiagramComponent, pinName: string, catalog: ComponentDefinition[]) {
  const direct = component.pins.find((pin) => pin.name.toLowerCase() === pinName.toLowerCase());
  if (direct) return direct;
  const definition = catalog.find((entry) => entry.id === component.ref);
  const canonical = definition ? resolvePinName(definition, pinName) : undefined;
  if (!canonical) return undefined;
  return component.pins.find((pin) => pin.name.toLowerCase() === canonical.toLowerCase());
}

/** Text that reached the plan through an LLM may carry HTML entities. */
const unescapeHtml = unescapeHtmlEntities;

function routeBetween(x1?: number, y1?: number, x2?: number, y2?: number): { x: number; y: number }[] | undefined {
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return undefined;
  const midX = Math.round((x1 + x2) / 2);
  return [
    { x: x1, y: y1 },
    { x: midX, y: y1 },
    { x: midX, y: y2 },
    { x: x2, y: y2 },
  ];
}

function shorten(value: string, max: number): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/* ------------------------------------------------------------------------- */
/* Integrity check (used by the validator)                                    */
/* ------------------------------------------------------------------------- */

export interface DiagramIntegrityReport {
  ok: boolean;
  problems: string[];
}

/**
 * Verify the diagram is internally consistent: unique ids, no dangling
 * references, every connection endpoint resolves to an existing component pin,
 * and stats match the actual content.
 */
export function checkDiagramIntegrity(diagram: Diagram | null | undefined): DiagramIntegrityReport {
  const problems: string[] = [];
  if (!diagram) return { ok: false, problems: ['diagram.json is missing'] };

  const ids = new Set<string>();
  for (const component of diagram.components) {
    if (ids.has(component.id)) problems.push(`duplicate component id "${component.id}" in diagram.json`);
    ids.add(component.id);

    const pinNames = new Set<string>();
    for (const pin of component.pins) {
      if (pinNames.has(pin.name)) problems.push(`duplicate pin "${pin.name}" on diagram component ${component.id}`);
      pinNames.add(pin.name);
    }
  }

  const connectionIds = new Set<string>();
  for (const connection of diagram.connections) {
    if (connectionIds.has(connection.id)) problems.push(`duplicate connection id "${connection.id}" in diagram.json`);
    connectionIds.add(connection.id);

    for (const endpoint of [connection.from, connection.to]) {
      const component = diagram.components.find((candidate) => candidate.id === endpoint.component);
      if (!component) {
        problems.push(`connection ${connection.id} references unknown component "${endpoint.component}"`);
        continue;
      }
      const exists = component.pins.some((pin) => pin.name.toLowerCase() === endpoint.pin.toLowerCase());
      if (!exists) problems.push(`connection ${connection.id} references unknown pin "${endpoint.pin}" on ${component.id}`);
    }
  }

  if (diagram.stats.components !== diagram.components.length) {
    problems.push(`stats.components (${diagram.stats.components}) does not match the ${diagram.components.length} components present`);
  }
  if (diagram.stats.connections !== diagram.connections.length) {
    problems.push(`stats.connections (${diagram.stats.connections}) does not match the ${diagram.connections.length} connections present`);
  }

  for (const rail of diagram.rails) {
    for (const member of rail.members) {
      if (!ids.has(member.component)) problems.push(`rail ${rail.id} references unknown component "${member.component}"`);
    }
  }

  for (const group of diagram.groups) {
    for (const memberId of group.memberIds) {
      if (!ids.has(memberId)) problems.push(`group ${group.id} references unknown component "${memberId}"`);
    }
  }

  return { ok: problems.length === 0, problems };
}

/** Components present in the plan but missing from the diagram. */
export function findMissingDiagramComponents(diagram: Diagram | null, selections: ComponentSelection[], catalog: ComponentDefinition[]): string[] {
  if (!diagram) return [];
  const missing: string[] = [];
  for (const selection of selections) {
    const definition = catalog.find((component) => component.id === selection.componentId);
    if (!includeInDiagram(definition)) continue;
    for (const instance of selection.instances) {
      if (!diagram.components.some((component) => component.id === instance.instanceId)) missing.push(instance.instanceId);
    }
  }
  return missing;
}

export type { DiagramComponent, DiagramConnection };
