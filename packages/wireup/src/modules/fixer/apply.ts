/**
 * Changeset applier.
 *
 * Takes the typed `FixChange[]` produced by the deterministic strategies and/or
 * the model and applies them to a *copy* of the project state. Nothing is
 * regenerated wholesale: every mutation is scoped to the artifact it names,
 * existing ids are preserved, and derived data (nets, pin map, includes) is
 * re-synchronised so the patched project stays internally consistent.
 */

import type { ComponentDefinition, ComponentRole, LibraryRequirement } from '@/types/component';
import type { FixChange } from '@/types/generation';
import type { AgentEventLog } from '@/lib/logging/events';
import type {
  CodeArtifact,
  HardwarePlan,
  InstructionsArtifact,
  LibrariesArtifact,
  ProjectRequirements,
  ProjectState,
  SoftwarePlan,
} from '@/types/project';
import type { ArtifactKind } from '@/types/validation';
import type { Diagram } from '@/types/diagram';
import type { PinAssignment, WiringConnection, WiringPlan } from '@/types/wiring';
import { pinSpec, type McuProfile } from '@/modules/pin-planner/mcu-profiles';

import { logger } from '@/lib/logging/logger';
import {
  assignmentId as newAssignmentId,
  changeId,
  connectionId as newConnectionId,
  instanceId as buildInstanceId,
} from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import { expandSelections, ROLE_BY_CATEGORY } from '@/modules/hardware-planner';
import type { DraftSelection } from '@/modules/hardware-planner/types';
import { syncPinConstants } from '@/modules/code-generator';
import { applyFirmwareHygiene } from '@/modules/code-generator/hygiene';
import {
  buildIncludesBlock,
  buildPinMapBlock,
  INCLUDES_END,
  INCLUDES_START,
  includeStatement,
  PIN_MAP_END,
  PIN_MAP_START,
} from '@/modules/code-generator/templates';

import { findReplace, regexReplace, replaceBetweenMarkers, removeInclude } from './codePatch';

export type RerunStage = 'pins' | 'wiring' | 'diagram' | 'instructions' | 'libraries' | 'code';

export interface RefreshResult {
  project: ProjectState;
  notes?: string[];
}

/** Deterministic re-derivations the orchestrator can hand to the fixer. */
export interface FixerRefreshers {
  hardware?: (project: ProjectState) => RefreshResult;
  software?: (project: ProjectState) => RefreshResult;
  pins?: (project: ProjectState) => RefreshResult;
  wiring?: (project: ProjectState) => RefreshResult;
  /** The code refresher may re-run the AI-first (async) generation. */
  code?: (project: ProjectState, options?: { force?: boolean }) => RefreshResult | Promise<RefreshResult>;
  libraries?: (project: ProjectState) => RefreshResult;
  diagram?: (project: ProjectState) => RefreshResult;
  instructions?: (project: ProjectState) => RefreshResult;
}

export interface ApplyInput {
  project: ProjectState;
  changes: FixChange[];
  catalog: ComponentDefinition[];
  profile?: McuProfile;
  iteration: number;
  events?: AgentEventLog;
  /** Force the firmware pin-map sync even when no pin change was applied. */
  syncFirmware?: boolean;
  refresh?: FixerRefreshers;
}

export interface AppliedChange {
  id: string;
  op: string;
  artifact: ArtifactKind;
  detail: string;
}

export interface RejectedChange {
  id: string;
  op: string;
  artifact: ArtifactKind;
  reason: string;
}

export interface ApplyOutput {
  project: ProjectState;
  /** Changes actually performed, including the implied re-sync operations. */
  applied: AppliedChange[];
  rejected: RejectedChange[];
  touchedArtifacts: ArtifactKind[];
  notes: string[];
  /** Stages that were requested but could not be executed here. */
  pendingStages: RerunStage[];
  changes: FixChange[];
}

interface Working {
  requirements: ProjectRequirements | null;
  components: ProjectState['components'];
  hardwarePlan: HardwarePlan | null;
  pinAssignments: PinAssignment[];
  wiring: WiringPlan | null;
  softwarePlan: SoftwarePlan | null;
  code: CodeArtifact | null;
  diagram: Diagram | null;
  libraries: LibrariesArtifact | null;
  instructions: InstructionsArtifact | null;
  assembly: ProjectState['assembly'];
}

const POWER_COLOR = '#c62828';
const GROUND_COLOR = '#212121';
const SIGNAL_COLORS = ['#1565c0', '#2e7d32', '#ef6c00', '#6a1b9a', '#00838f', '#4e342e'];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function workingFrom(project: ProjectState): Working {
  return {
    requirements: project.requirements ? clone(project.requirements) : null,
    components: clone(project.components),
    hardwarePlan: project.hardwarePlan ? clone(project.hardwarePlan) : null,
    pinAssignments: clone(project.pinAssignments),
    wiring: project.wiring ? clone(project.wiring) : null,
    softwarePlan: project.softwarePlan ? clone(project.softwarePlan) : null,
    code: project.artifacts.code ? clone(project.artifacts.code) : null,
    diagram: project.artifacts.diagram ? clone(project.artifacts.diagram) : null,
    libraries: project.artifacts.libraries ? clone(project.artifacts.libraries) : null,
    instructions: project.artifacts.instructions ? clone(project.artifacts.instructions) : null,
    assembly: project.assembly ? clone(project.assembly) : null,
  };
}

function definitionOf(catalog: ComponentDefinition[], componentId: string): ComponentDefinition | undefined {
  return catalog.find((component) => component.id === componentId);
}

function isEsp32(componentId: string | undefined, profile: McuProfile | undefined): boolean {
  return /esp32/i.test(componentId ?? '') || /esp32/i.test(profile?.componentId ?? '');
}

function endpointKey(connection: WiringConnection): string {
  return [`${connection.from.instanceId}.${connection.from.pin}`, `${connection.to.instanceId}.${connection.to.pin}`].sort().join('<->');
}

function installCommandsFor(libraries: LibraryRequirement[], previous: string[]): string[] {
  const commands: string[] = [];
  for (const library of libraries) {
    if (library.builtIn) continue;
    if (library.manager === 'arduino' || library.manager === undefined) {
      commands.push(`arduino-cli lib install "${library.name}"`);
    } else if (library.manager === 'platformio') {
      commands.push(`pio pkg install --library "${library.name}"`);
    } else if (library.manager === 'pip') {
      commands.push(`pip install ${library.name}`);
    }
  }
  // Keep the platform core command from the previous manifest (esp32/avr cores).
  for (const command of previous) {
    if (/core install|core update/i.test(command) && !commands.includes(command)) commands.push(command);
  }
  return commands;
}

/** Rebuild `markdown` from the (possibly patched) sections. */
function rebuildMarkdown(instructions: InstructionsArtifact): string {
  const ordered = [...instructions.sections].sort((a, b) => a.order - b.order);
  return ordered.map((section) => `## ${section.title}\n\n${section.body.trim()}`).join('\n\n');
}

/* ------------------------------------------------------------------------- */
/* Applier                                                                    */
/* ------------------------------------------------------------------------- */

export async function applyChanges(input: ApplyInput): Promise<ApplyOutput> {
  const { changes, catalog, events, iteration } = input;
  const working = workingFrom(input.project);
  const applied: AppliedChange[] = [];
  const rejected: RejectedChange[] = [];
  const notes: string[] = [];
  const touched = new Set<ArtifactKind>();
  const requestedStages = new Map<RerunStage, boolean>();
  const requestStage = (stage: RerunStage, force = false): void => {
    requestedStages.set(stage, requestedStages.get(stage) === true || force);
  };
  const executedChanges: FixChange[] = [...changes];

  let pinsChanged = false;
  let componentsChanged = false;
  let wiringChanged = false;
  let librariesChanged = false;
  let codeChanged = false;
  let instructionsChanged = false;
  let colorIndex = (working.wiring?.connections ?? []).filter((connection) => connection.kind === 'signal').length;

  const controllerId = working.hardwarePlan?.controller?.instanceId;
  const controllerComponentId = working.hardwarePlan?.controller?.componentId;

  const record = (change: FixChange, detail: string): void => {
    applied.push({ id: change.id, op: change.op, artifact: change.artifact, detail });
    touched.add(change.artifact);
    events?.emit('fix_change_applied', `${change.op} → ${detail}`, {
      stage: 'fixing',
      metadata: {
        changeId: change.id,
        op: change.op,
        artifact: change.artifact,
        origin: change.origin,
        reason: change.reason,
        ...(change.issueId ? { issueId: change.issueId } : {}),
        ...(change.issueCode ? { issueCode: change.issueCode } : {}),
        detail,
      },
    });
  };

  const refuse = (change: FixChange, reason: string): void => {
    rejected.push({ id: change.id, op: change.op, artifact: change.artifact, reason });
    events?.emit('fix_change_rejected', `${change.op} rejected: ${reason}`, {
      stage: 'fixing',
      metadata: { changeId: change.id, op: change.op, artifact: change.artifact, origin: change.origin, reason },
    });
  };

  const dropInstance = (instanceId: string): void => {
    working.pinAssignments = working.pinAssignments.filter((assignment) => assignment.targetInstanceId !== instanceId);
    if (working.wiring) {
      working.wiring.connections = working.wiring.connections.filter(
        (connection) => connection.from.instanceId !== instanceId && connection.to.instanceId !== instanceId,
      );
    }
  };

  const addInstancesFor = (selection: ProjectState['components'][number], fromIndex: number, toIndex: number): string[] => {
    const created: string[] = [];
    for (let index = fromIndex; index <= toIndex; index += 1) {
      const instanceId = buildInstanceId(selection.componentId, index);
      if (selection.instances.some((instance) => instance.instanceId === instanceId)) continue;
      selection.instances.push({
        instanceId,
        componentId: selection.componentId,
        name: selection.name,
        index,
        label: selection.quantity > 1 ? `${selection.name} ${index}` : selection.name,
        category: selection.category,
      });
      created.push(instanceId);
    }
    return created;
  };

  for (const change of changes) {
    try {
      switch (change.op) {
        /* ------------------------- requirements ------------------------- */
        case 'set_field': {
          if (!working.requirements) {
            refuse(change, 'there is no requirements artifact to patch');
            break;
          }
          const field = change.field as keyof ProjectRequirements;
          const before = working.requirements[field];
          (working.requirements as unknown as Record<string, unknown>)[field] = clone(change.value);
          record(change, `requirements.${field} updated (${summariseValue(before)} → ${summariseValue(change.value)})`);
          break;
        }

        /* --------------------------- components ------------------------- */
        case 'add_component': {
          const definition = definitionOf(catalog, change.componentId);
          if (!definition) {
            refuse(change, `"${change.componentId}" is not in the component database`);
            break;
          }
          const existing = working.components.find((selection) => selection.componentId === change.componentId);
          if (existing) {
            const before = existing.quantity;
            const created = addInstancesFor(existing, existing.instances.length + 1, change.quantity);
            existing.quantity = Math.max(existing.quantity, change.quantity);
            componentsChanged = true;
            record(change, `${definition.name} already present — quantity ${before} → ${existing.quantity}${created.length > 0 ? `, added ${created.join(', ')}` : ''}`);
            break;
          }
          const draft: DraftSelection = {
            componentId: definition.id,
            quantity: change.quantity,
            role: change.role ?? (ROLE_BY_CATEGORY[definition.category] as ComponentRole) ?? 'other',
            reason: change.reason,
            required: change.required ?? true,
            source: 'catalog',
            notes: `Added by the fixer during iteration ${iteration + 1}.`,
          };
          const [selection] = expandSelections([draft], catalog);
          if (!selection) {
            refuse(change, 'the catalog part could not be materialised');
            break;
          }
          working.components.push(selection);
          componentsChanged = true;
          record(change, `added ${selection.quantity} × ${definition.name} (${selection.instances.map((instance) => instance.instanceId).join(', ')})`);
          break;
        }

        case 'replace_component': {
          const index = working.components.findIndex((selection) => selection.id === change.selectionId);
          if (index === -1) {
            refuse(change, `selection "${change.selectionId}" no longer exists`);
            break;
          }
          const previous = working.components[index] as ProjectState['components'][number];
          const targetId = change.componentId ?? previous.componentId;
          const definition = definitionOf(catalog, targetId);
          if (!definition) {
            refuse(change, `replacement "${targetId}" is not in the component database`);
            break;
          }
          for (const instance of previous.instances) dropInstance(instance.instanceId);

          const draft: DraftSelection = {
            componentId: definition.id,
            quantity: change.quantity ?? previous.quantity,
            role: change.role ?? previous.role,
            reason: change.reason ?? `${previous.reason} (substituted with ${definition.name} by the fixer)`,
            required: previous.required,
            source: 'catalog',
            matchedFrom: previous.componentId,
            notes: `Replaced ${previous.componentId} during iteration ${iteration + 1}.`,
          };
          const [selection] = expandSelections([draft], catalog);
          if (!selection) {
            refuse(change, 'the replacement part could not be materialised');
            break;
          }
          working.components[index] = selection;
          componentsChanged = true;
          wiringChanged = true;
          record(change, `${previous.name} (${previous.componentId}) → ${definition.name} (${definition.id}); stale pins/wires dropped`);
          break;
        }

        case 'remove_component': {
          const index = working.components.findIndex((selection) => selection.id === change.selectionId);
          if (index === -1) {
            refuse(change, `selection "${change.selectionId}" no longer exists`);
            break;
          }
          const previous = working.components[index] as ProjectState['components'][number];
          if (previous.role === 'controller') {
            refuse(change, 'the controller cannot be removed');
            break;
          }
          for (const instance of previous.instances) dropInstance(instance.instanceId);
          working.components.splice(index, 1);
          componentsChanged = true;
          wiringChanged = true;
          pinsChanged = true;
          record(change, `removed ${previous.name} (${previous.instances.map((instance) => instance.instanceId).join(', ')}) and its pins/wires`);
          break;
        }

        case 'set_quantity': {
          const selection = working.components.find((entry) => entry.id === change.selectionId);
          if (!selection) {
            refuse(change, `selection "${change.selectionId}" no longer exists`);
            break;
          }
          const before = selection.quantity;
          if (change.quantity > before) {
            const created = addInstancesFor(selection, before + 1, change.quantity);
            selection.quantity = change.quantity;
            componentsChanged = true;
            record(change, `${selection.name} quantity ${before} → ${change.quantity}; added ${created.join(', ') || 'nothing'}`);
          } else if (change.quantity < before) {
            const removed = selection.instances.slice(change.quantity).map((instance) => instance.instanceId);
            for (const instanceId of removed) dropInstance(instanceId);
            selection.instances = selection.instances.slice(0, change.quantity);
            selection.quantity = change.quantity;
            componentsChanged = true;
            wiringChanged = true;
            pinsChanged = true;
            record(change, `${selection.name} quantity ${before} → ${change.quantity}; removed ${removed.join(', ') || 'nothing'}`);
          } else {
            refuse(change, `quantity is already ${before}`);
          }
          break;
        }

        /* ------------------------- pin assignments ---------------------- */
        case 'set_pin_assignment': {
          const patch = change.assignment;
          if (!patch) {
            refuse(change, 'no assignment payload supplied');
            break;
          }
          const existing = change.assignmentId ? working.pinAssignments.find((assignment) => assignment.id === change.assignmentId) : undefined;
          if (change.assignmentId && !existing) {
            refuse(change, `assignment "${change.assignmentId}" no longer exists`);
            break;
          }
          const targetInstance = working.components
            .flatMap((selection) => selection.instances)
            .find((instance) => instance.instanceId === patch.targetInstanceId);
          if (!targetInstance) {
            refuse(change, `target instance "${patch.targetInstanceId}" is not in the bill of materials`);
            break;
          }

          if (existing) {
            const before = existing.pin;
            const merged: PinAssignment = {
              ...existing,
              ...patch,
              id: existing.id,
              source: 'fixer',
            };
            // The Arduino literal (D7 → 7) is derived from the pin name; a
            // stale pinNumber would silently re-point the sketch at the old pin.
            if (patch.pin !== undefined && patch.pin !== before && patch.pinNumber === undefined) {
              const number = input.profile ? pinSpec(input.profile, patch.pin)?.number : undefined;
              if (number !== undefined) merged.pinNumber = number;
              else delete merged.pinNumber;
            }
            const position = working.pinAssignments.findIndex((assignment) => assignment.id === existing.id);
            working.pinAssignments[position] = merged;
            pinsChanged = true;
            wiringChanged = true;
            if (before !== merged.pin) requestStage('wiring');
            record(change, `${merged.targetInstanceId}.${merged.targetPin} moved ${before} → ${merged.pin}`);
          } else {
            const mcuInstanceId = patch.mcuInstanceId ?? controllerId ?? '';
            if (!mcuInstanceId) {
              refuse(change, 'no controller instance is known, so a new assignment cannot be created');
              break;
            }

            /*
             * A "new" assignment for a peripheral pin the plan already covers is
             * not new: it would emit a second `const int PIN_<INSTANCE>_<PIN>`
             * with the same name, which is a redefinition error in C++. Merge it
             * into the existing assignment instead.
             */
            const sameTarget = working.pinAssignments.find(
              (assignment) =>
                assignment.targetInstanceId === patch.targetInstanceId &&
                assignment.targetPin.toLowerCase() === String(patch.targetPin).toLowerCase(),
            );
            if (sameTarget) {
              const before = sameTarget.pin;
              const merged: PinAssignment = { ...sameTarget, ...patch, id: sameTarget.id, source: 'fixer' };
              if (patch.pin !== before && patch.pinNumber === undefined) {
                const number = input.profile ? pinSpec(input.profile, patch.pin)?.number : undefined;
                if (number !== undefined) merged.pinNumber = number;
                else delete merged.pinNumber;
              }
              const position = working.pinAssignments.findIndex((assignment) => assignment.id === sameTarget.id);
              working.pinAssignments[position] = merged;
              pinsChanged = true;
              wiringChanged = true;
              if (before !== merged.pin) requestStage('wiring');
              record(
                change,
                `${merged.targetInstanceId}.${merged.targetPin} is already assigned — updated ${before} → ${merged.pin} instead of adding a duplicate`,
              );
              break;
            }

            /*
             * Two different signals may share a pin only on a shared bus (I2C
             * SDA/SCL, SPI). Anything else is a short circuit, so refuse rather
             * than quietly stack a second signal on a pin that is already driven.
             */
            const sharedBus = (protocol?: string) => protocol === 'i2c' || protocol === 'spi';
            const occupant = working.pinAssignments.find(
              (assignment) => assignment.pin === patch.pin && assignment.mcuInstanceId === mcuInstanceId,
            );
            if (occupant && !(sharedBus(occupant.protocol) && sharedBus(patch.protocol))) {
              refuse(
                change,
                `${patch.pin} already carries ${occupant.targetInstanceId}.${occupant.targetPin}; a second signal on the same pin is a conflict, not a fix`,
              );
              break;
            }

            const derivedNumber = patch.pinNumber ?? (input.profile ? pinSpec(input.profile, patch.pin)?.number : undefined);
            const created: PinAssignment = {
              id: newAssignmentId(),
              mcuInstanceId,
              mcuComponentId: patch.mcuComponentId ?? controllerComponentId ?? '',
              pin: patch.pin,
              ...(derivedNumber !== undefined ? { pinNumber: derivedNumber } : {}),
              targetInstanceId: patch.targetInstanceId,
              targetComponentId: patch.targetComponentId ?? targetInstance.componentId,
              targetPin: patch.targetPin,
              purpose: patch.purpose ?? `Control ${targetInstance.label ?? targetInstance.name} ${patch.targetPin}`,
              signal: patch.signal ?? 'digital',
              direction: patch.direction ?? 'output',
              protocol: patch.protocol ?? 'gpio',
              required: patch.required ?? false,
              rationale: patch.rationale ?? 'Added by the fixer to resolve a validation issue.',
              source: 'fixer',
            };
            working.pinAssignments.push(created);
            pinsChanged = true;
            wiringChanged = true;
            requestStage('wiring');
            record(change, `new assignment ${created.id}: ${mcuInstanceId}.${created.pin} → ${created.targetInstanceId}.${created.targetPin}`);
          }
          break;
        }

        case 'remove_pin_assignment': {
          const existing = working.pinAssignments.find((assignment) => assignment.id === change.assignmentId);
          if (!existing) {
            refuse(change, `assignment "${change.assignmentId}" no longer exists`);
            break;
          }
          working.pinAssignments = working.pinAssignments.filter((assignment) => assignment.id !== change.assignmentId);
          if (working.wiring) {
            const before = working.wiring.connections.length;
            working.wiring.connections = working.wiring.connections.filter((connection) => {
              const touchesMcuPin =
                (connection.from.instanceId === existing.mcuInstanceId && connection.from.pin === existing.pin) ||
                (connection.to.instanceId === existing.mcuInstanceId && connection.to.pin === existing.pin);
              const touchesTarget =
                (connection.from.instanceId === existing.targetInstanceId && connection.from.pin === existing.targetPin) ||
                (connection.to.instanceId === existing.targetInstanceId && connection.to.pin === existing.targetPin);
              return !(touchesMcuPin && touchesTarget);
            });
            if (working.wiring.connections.length !== before) wiringChanged = true;
          }
          pinsChanged = true;
          record(change, `removed assignment ${existing.id} (${existing.mcuInstanceId}.${existing.pin} → ${existing.targetInstanceId}.${existing.targetPin})`);
          break;
        }

        /* ----------------------------- wiring --------------------------- */
        case 'add_connection': {
          if (!working.wiring) {
            refuse(change, 'there is no wiring artifact to patch');
            break;
          }
          const existingKeys = new Set(working.wiring.connections.map(endpointKey));
          const draft = change.connection;
          const key = [`${draft.from.instanceId}.${draft.from.pin}`, `${draft.to.instanceId}.${draft.to.pin}`].sort().join('<->');
          if (existingKeys.has(key)) {
            refuse(change, `${draft.from.instanceId}.${draft.from.pin} ↔ ${draft.to.instanceId}.${draft.to.pin} is already wired`);
            break;
          }
          const known = (instanceId: string) => working.components.some((selection) => selection.instances.some((instance) => instance.instanceId === instanceId));
          if (!known(draft.from.instanceId) || !known(draft.to.instanceId)) {
            refuse(change, 'an endpoint references an instance that is not in the bill of materials');
            break;
          }
          const connection: WiringConnection = {
            id: draft.id ?? newConnectionId(),
            from: draft.from,
            to: draft.to,
            kind: draft.kind,
            signal: draft.signal,
            protocol: draft.protocol,
            direction: draft.direction,
            explanation: draft.explanation,
            source: 'fixer',
            ...(draft.voltage !== undefined ? { voltage: draft.voltage } : {}),
            wireColor:
              draft.wireColor ??
              (draft.kind === 'ground' ? GROUND_COLOR : draft.kind === 'power' ? POWER_COLOR : SIGNAL_COLORS[colorIndex++ % SIGNAL_COLORS.length]),
            ...(draft.metadata ? { metadata: draft.metadata } : {}),
          };
          working.wiring.connections.push(connection);
          wiringChanged = true;
          record(change, `wire ${connection.id}: ${connection.from.instanceId}.${connection.from.pin} → ${connection.to.instanceId}.${connection.to.pin} (${connection.kind})`);
          break;
        }

        case 'replace_connection': {
          const connection = working.wiring?.connections.find((entry) => entry.id === change.connectionId);
          if (!connection) {
            refuse(change, `connection "${change.connectionId}" no longer exists`);
            break;
          }
          const before = `${connection.from.pin}/${connection.to.pin}`;
          if (change.fromPin) connection.from = { ...connection.from, pin: change.fromPin };
          if (change.toPin) connection.to = { ...connection.to, pin: change.toPin };
          if (change.connection) {
            const patch = change.connection;
            if (patch.kind) connection.kind = patch.kind;
            if (patch.signal) connection.signal = patch.signal;
            if (patch.protocol) connection.protocol = patch.protocol;
            if (patch.direction) connection.direction = patch.direction;
            if (patch.explanation) connection.explanation = patch.explanation;
            if (patch.voltage !== undefined) connection.voltage = patch.voltage;
            if (patch.wireColor) connection.wireColor = patch.wireColor;
            if (patch.from) connection.from = { ...connection.from, ...patch.from };
            if (patch.to) connection.to = { ...connection.to, ...patch.to };
          }
          connection.source = 'fixer';
          wiringChanged = true;
          record(change, `connection ${connection.id} endpoints ${before} → ${connection.from.pin}/${connection.to.pin}`);
          break;
        }

        case 'remove_connection': {
          const connection = working.wiring?.connections.find((entry) => entry.id === change.connectionId);
          if (!connection || !working.wiring) {
            refuse(change, `connection "${change.connectionId}" no longer exists`);
            break;
          }
          working.wiring.connections = working.wiring.connections.filter((entry) => entry.id !== change.connectionId);
          wiringChanged = true;
          record(change, `removed wire ${connection.id} (${connection.from.instanceId}.${connection.from.pin} → ${connection.to.instanceId}.${connection.to.pin})`);
          break;
        }

        /* ------------------------------ code ---------------------------- */
        case 'patch_code_file': {
          const files = working.code?.files ?? [];
          const file = files.find((entry) => entry.path === change.path);
          if (!file && change.mode !== 'replace') {
            refuse(change, `${change.path} is not part of the firmware`);
            break;
          }
          if (!working.code) {
            refuse(change, 'there is no code artifact to patch');
            break;
          }
          if (!file) {
            working.code.files.push({
              path: change.path,
              language: change.path.endsWith('.ino') ? 'arduino-cpp' : 'text',
              content: change.content ?? '',
              purpose: change.reason,
              generatedBy: 'fixer',
            });
            codeChanged = true;
            record(change, `created ${change.path} (${(change.content ?? '').length} characters)`);
            break;
          }

          const before = file.content;
          let after = before;
          let detail = '';

          switch (change.mode) {
            case 'replace':
              if (change.content === undefined) {
                refuse(change, 'replace mode needs content');
                break;
              }
              after = change.content;
              detail = `replaced ${change.path} (${before.length} → ${after.length} characters)`;
              break;
            case 'append':
              after = `${before}${before.endsWith('\n') ? '' : '\n'}${change.content ?? ''}`;
              detail = `appended ${(change.content ?? '').length} characters to ${change.path}`;
              break;
            case 'prepend':
              after = `${change.content ?? ''}\n${before}`;
              detail = `prepended ${(change.content ?? '').length} characters to ${change.path}`;
              break;
            case 'find_replace': {
              const edit = findReplace(before, change.find ?? '', change.replace ?? '');
              if (!edit.changed) {
                refuse(change, edit.detail ?? 'search text not found');
                break;
              }
              after = edit.content;
              detail = `find/replace in ${change.path}: "${truncateInline(change.find ?? '')}" → "${truncateInline(change.replace ?? '')}"`;
              break;
            }
            case 'regex_replace': {
              const edit = regexReplace(before, change.find ?? '', change.replace ?? '');
              if (!edit.changed) {
                refuse(change, edit.detail ?? 'pattern did not match');
                break;
              }
              after = edit.content;
              detail = `regex replace in ${change.path}: /${truncateInline(change.find ?? '')}/ → "${truncateInline(change.replace ?? '')}"`;
              break;
            }
            default:
              refuse(change, 'unsupported patch mode');
              break;
          }

          if (after !== before) {
            file.content = after;
            file.generatedBy = 'fixer';
            codeChanged = true;
            record(change, detail);
          }
          break;
        }

        case 'add_code_file': {
          if (!working.code) {
            refuse(change, 'there is no code artifact to patch');
            break;
          }
          if (working.code.files.some((entry) => entry.path === change.path)) {
            refuse(change, `${change.path} already exists`);
            break;
          }
          working.code.files.push({
            path: change.path,
            language: change.language,
            content: change.content,
            purpose: change.purpose ?? change.reason,
            generatedBy: 'fixer',
          });
          codeChanged = true;
          record(change, `added ${change.path} (${change.content.length} characters, ${change.language})`);
          break;
        }

        case 'remove_code_file': {
          if (!working.code) {
            refuse(change, 'there is no code artifact to patch');
            break;
          }
          if (change.path === working.code.entryPoint) {
            refuse(change, 'the entry point cannot be removed');
            break;
          }
          const before = working.code.files.length;
          working.code.files = working.code.files.filter((entry) => entry.path !== change.path);
          if (working.code.files.length === before) {
            refuse(change, `${change.path} is not part of the firmware`);
            break;
          }
          codeChanged = true;
          record(change, `removed ${change.path}`);
          break;
        }

        /* --------------------------- libraries -------------------------- */
        case 'add_library': {
          const library = change.library;
          if (!working.libraries) {
            working.libraries = { libraries: [], installCommands: [], notes: [], generatedAt: nowIso() };
          }
          const exists = working.libraries.libraries.some(
            (entry) => entry.name.toLowerCase() === library.name.toLowerCase() || entry.import.toLowerCase() === library.import.toLowerCase(),
          );
          if (exists) {
            refuse(change, `${library.name} is already listed`);
            break;
          }
          working.libraries.libraries.push(library);
          working.libraries.installCommands = installCommandsFor(working.libraries.libraries, working.libraries.installCommands);
          working.libraries.notes.push(`Added ${library.name} during fix iteration ${iteration + 1}.`);
          working.libraries.generatedAt = nowIso();
          librariesChanged = true;
          record(change, `libraries.json += ${library.name} (${library.import})`);
          break;
        }

        case 'remove_library': {
          if (!working.libraries) {
            refuse(change, 'there is no libraries artifact');
            break;
          }
          const match = working.libraries.libraries.find(
            (entry) => entry.name.toLowerCase() === change.libraryName.toLowerCase() || entry.import.toLowerCase() === change.libraryName.toLowerCase(),
          );
          if (!match) {
            refuse(change, `${change.libraryName} is not listed`);
            break;
          }
          working.libraries.libraries = working.libraries.libraries.filter((entry) => entry !== match);
          working.libraries.installCommands = installCommandsFor(working.libraries.libraries, working.libraries.installCommands);
          working.libraries.notes.push(`Removed ${match.name} during fix iteration ${iteration + 1}.`);
          working.libraries.generatedAt = nowIso();
          librariesChanged = true;

          // Drop the include as well, otherwise the firmware no longer compiles.
          let removedIncludes = 0;
          for (const file of working.code?.files ?? []) {
            const edit = removeInclude(file.content, match.import);
            if (edit.changed) {
              file.content = edit.content;
              file.generatedBy = 'fixer';
              removedIncludes += 1;
            }
          }
          if (removedIncludes > 0) codeChanged = true;
          record(change, `libraries.json -= ${match.name}${removedIncludes > 0 ? `; removed ${match.import} from ${removedIncludes} file(s)` : ''}`);
          break;
        }

        case 'set_libraries': {
          if (!working.libraries) {
            working.libraries = { libraries: [], installCommands: [], notes: [], generatedAt: nowIso() };
          }
          const before = working.libraries.libraries.length;
          working.libraries.libraries = clone(change.libraries);
          working.libraries.installCommands = installCommandsFor(working.libraries.libraries, working.libraries.installCommands);
          working.libraries.notes.push(`Library manifest rewritten by the fixer during iteration ${iteration + 1}.`);
          working.libraries.generatedAt = nowIso();
          librariesChanged = true;
          record(change, `libraries.json rewritten (${before} → ${change.libraries.length} entries)`);
          break;
        }

        /* -------------------------- instructions ------------------------ */
        case 'patch_instructions': {
          if (!working.instructions) {
            refuse(change, 'there is no instructions artifact');
            break;
          }
          const section = working.instructions.sections.find((entry) => entry.id === change.sectionId);
          if (!section) {
            refuse(change, `section "${change.sectionId}" does not exist`);
            break;
          }
          const before = section.body.length;
          section.body = change.mode === 'append' ? `${section.body.trimEnd()}\n\n${change.content}` : change.content;
          working.instructions.markdown = rebuildMarkdown(working.instructions);
          working.instructions.generatedAt = nowIso();
          instructionsChanged = true;
          record(change, `instructions §${section.title} ${change.mode}d (${before} → ${section.body.length} characters)`);
          break;
        }

        /* --------------------------- assembly --------------------------- */
        case 'prune_assembly': {
          if (!working.assembly) {
            refuse(change, 'there is no 3D assembly to prune');
            break;
          }
          const roles = change.roles ?? [];
          const ids = new Set(change.instanceIds ?? []);
          let cut = 0;
          for (const role of roles) {
            if (working.assembly.bindings[role as keyof typeof working.assembly.bindings] !== undefined) {
              delete working.assembly.bindings[role as keyof typeof working.assembly.bindings];
              cut += 1;
            }
          }
          for (const id of ids) {
            if (working.assembly.placements[id] !== undefined) {
              delete working.assembly.placements[id];
              cut += 1;
            }
          }
          const before = working.assembly.parametric.length;
          working.assembly.parametric = working.assembly.parametric.filter((id) => !ids.has(id));
          cut += before - working.assembly.parametric.length;
          // Keep the pushed spec's bindings identical to the pruned map.
          working.assembly.spec = { ...working.assembly.spec, bindings: { ...working.assembly.bindings } };
          if (cut === 0) {
            refuse(change, 'no stale 3D seats matched');
            break;
          }
          record(change, `pruned ${cut} stale 3D seat(s); the parts fall back to the bench grid`);
          break;
        }

        /* --------------------------- rerun stage ------------------------ */
        case 'rerun_stage': {
          requestStage(change.stage, change.force === true);
          record(change, `queued deterministic re-derivation of ${change.stage}${change.force ? ' (forced)' : ''}`);
          break;
        }

        default:
          refuse(change, 'unsupported change op');
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      refuse(change, `applier error: ${message}`);
      logger.error({ err: error, changeId: change.id, op: change.op }, 'fixer: failed to apply a change');
    }
  }

  /* --------------------------------------------------------------------- */
  /* Implied re-synchronisation                                            */
  /* --------------------------------------------------------------------- */

  if (pinsChanged || librariesChanged || input.syncFirmware === true) {
    const synced = syncFirmware(working, input.profile, controllerComponentId, executedChanges, catalog);
    for (const entry of synced) {
      codeChanged = true;
      applied.push(entry.applied);
      touched.add('code');
      events?.emit('fix_change_applied', `pin/include sync → ${entry.applied.detail}`, {
        stage: 'fixing',
        metadata: { changeId: entry.applied.id, op: entry.applied.op, artifact: 'code', origin: 'deterministic', implied: true },
      });
    }
    if (synced.length > 0) notes.push('Firmware pin constants and includes were re-synchronised with the patched pin plan.');
  }

  /* Deterministic re-derivations, in dependency order. */
  const stageOrder: RerunStage[] = ['pins', 'wiring', 'code', 'libraries', 'diagram', 'instructions'];
  const pending: RerunStage[] = [];

  if (componentsChanged && input.refresh?.hardware) {
    const outcome = await runRefresh(input.refresh.hardware, snapshot(working, input.project), 'hardware plan');
    if (outcome) {
      adopt(working, outcome.project);
      notes.push('Hardware plan re-derived from the patched component list.');
    }
  }

  if (componentsChanged && input.refresh?.software) {
    const outcome = await runRefresh(input.refresh.software, snapshot(working, input.project), 'software plan');
    if (outcome) {
      adopt(working, outcome.project);
      notes.push('Software plan re-derived from the patched component list.');
    }
  }

  /*
   * Downstream artifacts are derived from upstream ones, so a re-run of an
   * early stage implies the later ones: a moved pin changes the wiring graph,
   * which changes diagram.json and the assembly instructions, and the sketch
   * must be re-synchronised with the final pin plan. Without this cascade a
   * pin fix left the diagram showing the old pin and the firmware the new one.
   */
  const cascade = (from: RerunStage, to: RerunStage[]) => {
    if (!requestedStages.has(from)) return;
    for (const stage of to) if (input.refresh?.[stage]) requestStage(stage);
  };
  if (pinsChanged || wiringChanged || componentsChanged) {
    for (const stage of ['diagram', 'instructions'] as RerunStage[]) if (input.refresh?.[stage]) requestStage(stage);
  }
  cascade('pins', ['wiring', 'diagram', 'instructions']);
  cascade('wiring', ['diagram', 'instructions']);

  let pinsRederived = false;
  for (const stage of stageOrder) {
    if (!requestedStages.has(stage)) continue;
    const refresher = input.refresh?.[stage];
    if (!refresher) {
      pending.push(stage);
      continue;
    }
    // Re-sync the sketch with the final pin plan before code/diagram are rebuilt.
    if ((stage === 'code' || stage === 'diagram') && pinsRederived) {
      const synced = syncFirmware(working, input.profile, controllerComponentId, executedChanges, catalog);
      for (const entry of synced) {
        codeChanged = true;
        applied.push(entry.applied);
        touched.add('code');
      }
      pinsRederived = false;
    }
    const outcome = await runRefresh(refresher, snapshot(working, input.project), stage, {
      force: requestedStages.get(stage) === true,
    });
    if (!outcome) {
      pending.push(stage);
      continue;
    }
    adopt(working, outcome.project);
    for (const note of outcome.notes ?? []) notes.push(note);
    notes.push(`${stage} re-derived deterministically from the patched project state.`);
    if (stage === 'pins') {
      pinsChanged = true;
      pinsRederived = true;
      for (const next of ['wiring', 'diagram', 'instructions'] as RerunStage[]) if (input.refresh?.[next]) requestStage(next);
    }
    if (stage === 'wiring') {
      wiringChanged = true;
      for (const next of ['diagram', 'instructions'] as RerunStage[]) if (input.refresh?.[next]) requestStage(next);
    }
    if (stage === 'diagram') touched.add('diagram');
    if (stage === 'instructions') touched.add('instructions');
    if (stage === 'libraries') touched.add('libraries');
    if (stage === 'code') touched.add('code');
  }
  if (pinsRederived) {
    const synced = syncFirmware(working, input.profile, controllerComponentId, executedChanges, catalog);
    for (const entry of synced) {
      codeChanged = true;
      applied.push(entry.applied);
      touched.add('code');
    }
  }

  if (componentsChanged) touched.add('components');
  if (pinsChanged) touched.add('pinAssignments');
  if (wiringChanged) touched.add('wiring');
  if (librariesChanged) touched.add('libraries');
  if (codeChanged) touched.add('code');
  if (instructionsChanged) touched.add('instructions');

  const project = snapshot(working, input.project);
  return {
    project,
    applied,
    rejected,
    touchedArtifacts: Array.from(touched),
    notes: [...new Set(notes)],
    pendingStages: pending,
    changes: executedChanges,
  };
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* ------------------------------------------------------------------------- */

function truncateInline(value: string, max = 60): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function summariseValue(value: unknown): string {
  if (value === undefined || value === null) return 'empty';
  if (Array.isArray(value)) return `${value.length} item(s)`;
  if (typeof value === 'object') return `${Object.keys(value as object).length} field(s)`;
  return truncateInline(String(value), 40);
}

function snapshot(working: Working, base: ProjectState): ProjectState {
  return {
    ...base,
    requirements: working.requirements,
    components: working.components,
    hardwarePlan: working.hardwarePlan,
    pinAssignments: working.pinAssignments,
    wiring: working.wiring,
    softwarePlan: working.softwarePlan,
    artifacts: {
      code: working.code,
      diagram: working.diagram,
      libraries: working.libraries,
      instructions: working.instructions,
    },
    assembly: working.assembly,
    updatedAt: nowIso(),
  };
}

function adopt(working: Working, project: ProjectState): void {
  working.requirements = project.requirements;
  working.components = project.components;
  working.hardwarePlan = project.hardwarePlan;
  working.pinAssignments = project.pinAssignments;
  working.wiring = project.wiring;
  working.softwarePlan = project.softwarePlan;
  working.code = project.artifacts.code;
  working.diagram = project.artifacts.diagram;
  working.libraries = project.artifacts.libraries;
  working.instructions = project.artifacts.instructions;
  working.assembly = project.assembly;
}

async function runRefresh(
  refresher: (project: ProjectState, options?: { force?: boolean }) => RefreshResult | Promise<RefreshResult>,
  project: ProjectState,
  label: string,
  options?: { force?: boolean },
): Promise<RefreshResult | undefined> {
  try {
    return await refresher(project, options);
  } catch (error) {
    logger.error({ err: error, stage: label }, 'fixer: deterministic re-derivation failed');
    return undefined;
  }
}

/**
 * Re-inject the managed pin-map block and re-point stray pin constants so the
 * firmware always agrees with the (possibly moved) pin plan.
 */
function syncFirmware(
  working: Working,
  profile: McuProfile | undefined,
  controllerComponentId: string | undefined,
  executedChanges: FixChange[],
  catalog: ComponentDefinition[],
): { applied: AppliedChange; change: FixChange }[] {
  if (!working.code) return [];
  const assignments = working.pinAssignments;
  const libraries = working.libraries?.libraries ?? [];
  const esp32 = isEsp32(controllerComponentId, profile);
  const results: { applied: AppliedChange; change: FixChange }[] = [];

  for (const file of working.code.files) {
    if (!/\.(ino|cpp|c|h|hpp)$/i.test(file.path)) continue;

    const original = file.content;
    let content = original;
    const details: string[] = [];

    /* 1. Managed pin map block ------------------------------------------- */
    const block = buildPinMapBlock(assignments, profile);
    const markerEdit = replaceBetweenMarkers(content, PIN_MAP_START, PIN_MAP_END, block);
    let mode: 'find_replace' | 'append' = 'find_replace';
    let find: string | undefined = markerEdit.find;
    let replace: string | undefined = markerEdit.replace;
    if (markerEdit.changed) {
      content = markerEdit.content;
      details.push('pin map block refreshed');
    } else if (!content.includes(PIN_MAP_START) && assignments.length > 0) {
      content = `${content.trimEnd()}\n\n${block}\n`;
      mode = 'append';
      find = undefined;
      replace = block;
      details.push('pin map block appended');
    }

    /* 2. Constants declared outside the managed block --------------------- */
    const constantSync = syncPinConstants(content, assignments);
    if (constantSync.synced.length > 0) {
      content = constantSync.content;
      details.push(
        `${constantSync.synced.length} pin constant(s) re-pointed: ${constantSync.synced
          .slice(0, 4)
          .map((entry) => `${entry.name} ${entry.from}→${entry.to}`)
          .join(', ')}`,
      );
    }

    /* 3. Includes for the current library manifest ------------------------ */
    const missingIncludes: string[] = [];
    for (const library of libraries) {
      const statement = includeStatement(library);
      if (!statement) continue;
      if (/BluetoothSerial\.h|BLEDevice\.h|WiFi\.h/i.test(library.import) && !esp32) continue;
      if (content.includes(library.import)) continue;
      missingIncludes.push(statement);
    }
    if (missingIncludes.length > 0) {
      /*
       * Rebuild the WHOLE managed block from the manifest. Writing only the
       * missing lines into it used to replace the block outright, which threw
       * away <Arduino.h>, <Wire.h>, <Servo.h> and the display headers — the
       * sketch then failed to compile with "'Adafruit_SSD1306' was not declared"
       * and nothing in the report explained why.
       */
      const includeBlock = buildIncludesBlock(libraries, esp32);
      const includeEdit = replaceBetweenMarkers(content, INCLUDES_START, INCLUDES_END, includeBlock);
      if (includeEdit.changed) {
        content = includeEdit.content;
      } else {
        // No managed block: append only what is genuinely absent.
        const additions = missingIncludes.filter((statement) => !content.includes(statement));
        if (additions.length > 0) {
          const block = [INCLUDES_START, ...additions, INCLUDES_END].join('\n');
          const lastInclude = content.lastIndexOf('#include');
          const lineEnd = lastInclude === -1 ? -1 : content.indexOf('\n', lastInclude);
          content = lineEnd === -1 ? `${content.trimEnd()}\n\n${block}\n` : `${content.slice(0, lineEnd + 1)}${block}\n${content.slice(lineEnd + 1)}`;
        }
      }
      details.push(`added include(s): ${missingIncludes.join(', ')}`);
    }

    /* 4. Hygiene: hex I2C addresses, Wire.begin(), stray includes ---------- */
    const hygiene = applyFirmwareHygiene(content, { selections: working.components, catalog, libraries });
    if (hygiene.content !== content) {
      content = hygiene.content;
      details.push(...hygiene.notes);
    }

    if (content === original) continue;

    file.content = content;
    file.generatedBy = 'fixer';

    const change: FixChange = {
      id: changeId(),
      artifact: 'code',
      op: 'patch_code_file',
      path: file.path,
      mode,
      ...(find !== undefined ? { find } : {}),
      ...(replace !== undefined ? { replace } : {}),
      reason: `Firmware re-synchronised with the patched pin plan and library manifest: ${details.join('; ')}.`,
      origin: 'deterministic',
    };
    executedChanges.push(change);
    results.push({
      applied: { id: change.id, op: change.op, artifact: 'code', detail: `${file.path}: ${details.join('; ')}` },
      change,
    });
  }

  return results;
}
