/**
 * Deterministic fix strategies.
 *
 * Each validation issue code maps to the *smallest* set of typed changes that
 * can repair it without regenerating anything. When no safe deterministic
 * repair exists the issue is reported as unresolved and handed to the model
 * fixer (or left for the user) — the fixer never guesses.
 */

import type { ComponentDefinition, ComponentRole, LibraryRequirement } from '@/types/component';
import type { AddConnectionChange, FixChange, RerunStageChange } from '@/types/generation';
import type { ProjectState } from '@/types/project';
import type { ValidationIssue, ValidationIssueCode } from '@/types/validation';
import type { PinAssignment, SignalType, WiringConnection } from '@/types/wiring';
import type { McuPinSpec, McuProfile, PinCapability } from '@/modules/pin-planner/mcu-profiles';

import { changeId } from '@/lib/validation/ids';
import { reassignPin } from '@/modules/pin-planner';
import { normaliseMcuPin, pinSpec, usablePins } from '@/modules/pin-planner/mcu-profiles';
import { ROLE_BY_CATEGORY } from '@/modules/hardware-planner';
import { computePowerBudget, selectSupply } from '@/modules/hardware-planner/power';
import { braceBalance } from '@/modules/code-generator';
import { evaluateQuantityDelivery } from '@/modules/validator/quantities';

/** Keeps a single fix pass reviewable. */
export const MAX_CHANGES_PER_PASS = 40;

const POWER_COLOR = '#c62828';
const GROUND_COLOR = '#212121';
const SIGNAL_COLORS = ['#1565c0', '#2e7d32', '#ef6c00', '#6a1b9a', '#00838f', '#4e342e'];

export type RerunStage = RerunStageChange['stage'];

export interface StrategyInput {
  project: ProjectState;
  issues: ValidationIssue[];
  catalog: ComponentDefinition[];
  profile?: McuProfile;
  iteration: number;
}

export interface UnresolvedIssue {
  issue: ValidationIssue;
  reason: string;
}

export interface StrategyOutcome {
  changes: FixChange[];
  notes: string[];
  handledIssueIds: string[];
  unresolved: UnresolvedIssue[];
  /** Stages the orchestrator must re-derive after the patch is applied. */
  rerunStages: RerunStage[];
}

interface InstanceEntry {
  instanceId: string;
  componentId: string;
  definition?: ComponentDefinition;
  label: string;
}

interface Ctx {
  project: ProjectState;
  catalog: ComponentDefinition[];
  profile?: McuProfile;
  iteration: number;
  changes: FixChange[];
  notes: string[];
  handled: Set<string>;
  unresolved: UnresolvedIssue[];
  seen: Set<string>;
  rerun: Set<RerunStage>;
  /** Pins consumed by moves planned in this pass (so two fixes don't collide). */
  plannedPins: Set<string>;
  signalColorIndex: number;
  controllerInstanceId?: string;
  controllerComponentId?: string;
}

/* ------------------------------------------------------------------------- */
/* Small lookups                                                              */
/* ------------------------------------------------------------------------- */

function definitionFor(catalog: ComponentDefinition[], componentId: string): ComponentDefinition | undefined {
  return catalog.find((component) => component.id === componentId);
}

function instanceEntry(project: ProjectState, catalog: ComponentDefinition[], instanceId: string): InstanceEntry | undefined {
  for (const selection of project.components) {
    const instance = selection.instances.find((entry) => entry.instanceId === instanceId);
    if (!instance) continue;
    return {
      instanceId: instance.instanceId,
      componentId: instance.componentId,
      definition: definitionFor(catalog, instance.componentId),
      label: instance.label ?? instance.name,
    };
  }
  return undefined;
}

function selectionById(project: ProjectState, selectionId: string) {
  return project.components.find((selection) => selection.id === selectionId);
}

function groundPinOf(definition: ComponentDefinition | undefined): string | undefined {
  if (!definition) return undefined;
  const typed = definition.pins.find((pin) => pin.type === 'ground');
  return typed?.name ?? definition.groundPins[0];
}

function supplyPinOf(definition: ComponentDefinition | undefined): string | undefined {
  if (!definition) return undefined;
  const preferred = ['VCC', '5V', '3V3', 'VIN', 'VM', '+', 'IN', 'V+'];
  for (const name of preferred) {
    const found = definition.pins.find((pin) => pin.name.toLowerCase() === name.toLowerCase() && pin.type === 'power');
    if (found) return found.name;
  }
  const typed = definition.pins.find((pin) => pin.type === 'power' && pin.direction !== 'output');
  return typed?.name ?? definition.powerPins[0];
}

/** The controller-side ground pin already used by the wiring graph. */
function controllerGroundPin(ctx: Ctx): string | undefined {
  const connections = ctx.project.wiring?.connections ?? [];
  const controllerId = ctx.controllerInstanceId;
  for (const connection of connections) {
    if (connection.kind !== 'ground') continue;
    if (connection.from.instanceId === controllerId) return connection.from.pin;
    if (connection.to.instanceId === controllerId) return connection.to.pin;
  }
  const anyGround = connections.find((connection) => connection.kind === 'ground');
  return anyGround?.to.pin ?? anyGround?.from.pin ?? 'GND';
}

/** Existing supply rail endpoint, so a new power wire joins the same rail. */
function railEndpoint(ctx: Ctx): { instanceId: string; componentId: string; pin: string; voltage?: number } | undefined {
  const connections = ctx.project.wiring?.connections ?? [];
  const counts = new Map<string, { instanceId: string; componentId: string; pin: string; voltage?: number; count: number }>();
  for (const connection of connections) {
    if (connection.kind !== 'power') continue;
    const endpoint = connection.from.instanceId === ctx.controllerInstanceId ? connection.to : connection.from;
    const key = `${endpoint.instanceId}.${endpoint.pin}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { instanceId: endpoint.instanceId, componentId: endpoint.componentId, pin: endpoint.pin, voltage: connection.voltage, count: 1 });
  }
  const best = Array.from(counts.values()).sort((a, b) => b.count - a.count)[0];
  if (best) return best;

  const supplyId = ctx.project.hardwarePlan?.power.supplyComponentId;
  if (supplyId) {
    const entry = instanceEntry(ctx.project, ctx.catalog, supplyId);
    const pin = entry?.definition ? outputPinOf(entry.definition) : undefined;
    if (entry && pin) {
      return {
        instanceId: entry.instanceId,
        componentId: entry.componentId,
        pin,
        voltage: ctx.project.hardwarePlan?.power.rails[0]?.voltage,
      };
    }
  }
  return undefined;
}

function outputPinOf(definition: ComponentDefinition): string | undefined {
  const output = definition.pins.find((pin) => pin.type === 'power' && pin.direction === 'output');
  return output?.name ?? definition.powerPins[0];
}

function usedPins(ctx: Ctx): Set<string> {
  const used = new Set<string>(ctx.plannedPins);
  for (const assignment of ctx.project.pinAssignments) used.add(assignment.pin);
  return used;
}

function freePin(ctx: Ctx, options: { direction: 'input' | 'output'; capabilities?: PinCapability[]; signal?: SignalType }): McuPinSpec | undefined {
  if (!ctx.profile) return undefined;
  const exclude = usedPins(ctx);
  const floor: PinCapability[] = options.signal ? hardCapabilitiesFor(options.signal) : ['digital'];
  const wanted = options.capabilities ?? floor;
  const attempts: { allowStrapping: boolean; capabilities: PinCapability[] }[] = [
    { allowStrapping: false, capabilities: wanted },
    { allowStrapping: true, capabilities: wanted },
    // Last resort relaxes the *soft* capability only — never the hard floor.
    { allowStrapping: true, capabilities: floor },
  ];
  for (const attempt of attempts) {
    const candidates = usablePins(ctx.profile, {
      exclude,
      capabilities: attempt.capabilities,
      direction: options.direction,
      allowStrapping: attempt.allowStrapping,
    });
    const pick = candidates[0];
    if (pick) return pick;
  }
  return undefined;
}

/**
 * Capabilities a replacement pin must have for this signal.
 *
 * `digital` is always in the list: an AVR analog-only pin (A6/A7 on a Nano) has
 * no digital input buffer, so "the next free pin" must never be one of those
 * for a GPIO signal, no matter how free it looks.
 */
function capabilitiesFor(signal: SignalType): PinCapability[] {
  if (signal === 'analog') return ['adc'];
  if (signal === 'pwm') return ['pwm', 'digital'];
  return ['digital'];
}

/** The part of the capability list that may never be relaxed. */
function hardCapabilitiesFor(signal: SignalType): PinCapability[] {
  return signal === 'analog' ? ['adc'] : ['digital'];
}

function signalColor(ctx: Ctx): string {
  const color = SIGNAL_COLORS[ctx.signalColorIndex % SIGNAL_COLORS.length] as string;
  ctx.signalColorIndex += 1;
  return color;
}

/* ------------------------------------------------------------------------- */
/* Change bookkeeping                                                         */
/* ------------------------------------------------------------------------- */

/** Stable identity of a change, used to suppress duplicates across sources. */
export function changeSignature(change: FixChange): string {
  switch (change.op) {
    case 'set_pin_assignment':
      return `set_pin_assignment:${change.assignmentId ?? ''}:${change.assignment?.targetInstanceId ?? ''}:${change.assignment?.targetPin ?? ''}`;
    case 'remove_pin_assignment':
      return `remove_pin_assignment:${change.assignmentId}`;
    case 'add_connection':
      return `add_connection:${change.connection.from.instanceId}.${change.connection.from.pin}<->${change.connection.to.instanceId}.${change.connection.to.pin}`;
    case 'replace_connection':
      return `replace_connection:${change.connectionId}:${change.fromPin ?? ''}:${change.toPin ?? ''}`;
    case 'remove_connection':
      return `remove_connection:${change.connectionId}`;
    case 'add_component':
      return `add_component:${change.componentId}:${change.quantity}`;
    case 'replace_component':
      return `replace_component:${change.selectionId}:${change.componentId ?? ''}`;
    case 'remove_component':
      return `remove_component:${change.selectionId}`;
    case 'set_quantity':
      return `set_quantity:${change.selectionId}:${change.quantity}`;
    case 'patch_code_file':
      return `patch_code_file:${change.path}:${change.mode}:${change.find ?? change.content ?? ''}`.slice(0, 200);
    case 'add_code_file':
      return `add_code_file:${change.path}`;
    case 'remove_code_file':
      return `remove_code_file:${change.path}`;
    case 'add_library':
      return `add_library:${change.library.name}`;
    case 'remove_library':
      return `remove_library:${change.libraryName}`;
    case 'set_libraries':
      return `set_libraries:${change.libraries.map((library) => library.name).join(',')}`;
    case 'patch_instructions':
      return `patch_instructions:${change.sectionId}:${change.mode}`;
    case 'prune_assembly':
      return `prune_assembly:${[...(change.roles ?? [])].sort().join(',')}:${[...(change.instanceIds ?? [])].sort().join(',')}`;
    case 'set_field':
      return `set_field:${change.field}`;
    case 'rerun_stage':
      return `rerun_stage:${change.stage}`;
    default:
      return `unknown:${changeId()}`;
  }
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

type ChangeDraft = DistributiveOmit<FixChange, 'id' | 'issueId' | 'issueCode' | 'origin' | 'reason'> & { reason?: string };

function push(ctx: Ctx, issue: ValidationIssue, draft: ChangeDraft): boolean {
  if (ctx.changes.length >= MAX_CHANGES_PER_PASS) {
    ctx.notes.push(`Change budget (${MAX_CHANGES_PER_PASS}) reached — remaining issues are deferred to the next iteration.`);
    return false;
  }

  const change = {
    ...draft,
    id: changeId(),
    issueId: issue.id,
    issueCode: issue.code,
    origin: 'deterministic',
    reason: draft.reason ?? issue.fixHint ?? issue.message,
  } as FixChange;

  const signature = changeSignature(change);
  if (ctx.seen.has(signature)) {
    ctx.handled.add(issue.id);
    return false;
  }
  ctx.seen.add(signature);
  ctx.changes.push(change);
  ctx.handled.add(issue.id);

  if (change.op === 'rerun_stage') ctx.rerun.add(change.stage);
  return true;
}

function giveUp(ctx: Ctx, issue: ValidationIssue, reason: string): void {
  if (ctx.handled.has(issue.id)) return;
  ctx.unresolved.push({ issue, reason });
}

/* ------------------------------------------------------------------------- */
/* Behavioural assertion failures                                             */
/* ------------------------------------------------------------------------- */

interface BehavioralFailure {
  assertionId: string;
  expected: string;
  got: string;
}

/**
 * The validator reports a behavioural failure as structured input
 * ("assertion X failed: expected Y, got Z"). Split it back apart so the fixer
 * can act on the exact value that was wrong instead of "the build broke".
 */
function parseBehavioralFailure(issue: ValidationIssue): BehavioralFailure {
  const assertionId = issue.id.startsWith('behavioral.') ? issue.id.slice('behavioral.'.length) : issue.id;
  const text = `${issue.details ?? ''} ${issue.fixHint ?? ''}`;
  const match = /expected\s+(.+?),\s+got\s+(.+)$/.exec(text);
  return {
    assertionId,
    expected: match?.[1]?.trim() ?? '',
    got: match?.[2]?.trim() ?? '',
  };
}

/* ------------------------------------------------------------------------- */
/* Individual strategies                                                      */
/* ------------------------------------------------------------------------- */

/** Move every assignment off a contested/illegal MCU pin. */
function relocateAssignments(
  ctx: Ctx,
  issue: ValidationIssue,
  pin: string,
  options: {
    keepAssignmentId?: string;
    mode: 'conflict' | 'reserved' | 'input-only' | 'analog-only' | 'uart' | 'capability';
  } = { mode: 'conflict' },
): boolean {
  if (!ctx.profile) {
    giveUp(ctx, issue, 'No MCU profile is available, so a replacement pin cannot be chosen safely.');
    return false;
  }

  const onPin = ctx.project.pinAssignments.filter((assignment) => assignment.pin === pin);
  if (onPin.length === 0) {
    giveUp(ctx, issue, `No pin assignment references ${pin}; the reported problem cannot be located.`);
    return false;
  }

  if (options.mode === 'conflict') {
    const result = reassignPin({
      assignments: ctx.project.pinAssignments,
      profile: ctx.profile,
      pin,
      // Moves already planned in this pass are not in `pinAssignments` yet;
      // without them every issue in the pass picks the same "free" pin.
      alsoExclude: ctx.plannedPins,
      ...(options.keepAssignmentId ? { keepAssignmentId: options.keepAssignmentId } : {}),
    });
    if (result.moves.length === 0) {
      giveUp(ctx, issue, result.notes[0] ?? `No free pin on ${ctx.profile.name} to relocate the conflicting assignment.`);
      return false;
    }
    for (const move of result.moves) {
      const assignment = ctx.project.pinAssignments.find((entry) => entry.id === move.assignmentId);
      ctx.plannedPins.add(move.to);
      push(ctx, issue, {
        artifact: 'pinAssignments',
        op: 'set_pin_assignment',
        assignmentId: move.assignmentId,
        assignment: {
          pin: move.to,
          targetInstanceId: move.instanceId,
          targetPin: move.targetPin,
          ...(assignment ? { pinNumber: pinSpec(ctx.profile, move.to)?.number } : {}),
          rationale: `Fixer: moved off ${move.from} (${move.reason}).`,
          source: 'fixer',
        },
        reason: `Moved ${move.instanceId}.${move.targetPin} from ${move.from} to ${move.to} — ${move.reason}.`,
      });
      emitEndpointMoves(ctx, issue, assignment?.mcuInstanceId ?? ctx.controllerInstanceId, move.from, move.to);
    }
    for (const note of result.notes) ctx.notes.push(note);
    return true;
  }

  /* reserved / input-only / capability: move every assignment on that pin. */
  let moved = 0;
  for (const assignment of onPin) {
    const replacement = freePin(ctx, {
      direction: assignment.direction,
      capabilities: options.mode === 'capability' ? capabilitiesFor(assignment.signal) : hardCapabilitiesFor(assignment.signal),
      signal: assignment.signal,
    });
    if (!replacement) {
      giveUp(ctx, issue, `No free ${assignment.direction} pin${options.mode === 'capability' ? ` with ${capabilitiesFor(assignment.signal).join('/') || 'gpio'} capability` : ''} remains on ${ctx.profile.name}.`);
      continue;
    }
    ctx.plannedPins.add(replacement.name);
    const why =
      options.mode === 'reserved'
        ? `${pin} is reserved on ${ctx.profile.name}`
        : options.mode === 'input-only'
          ? `${pin} is input-only on ${ctx.profile.name} and cannot be driven`
          : options.mode === 'analog-only'
            ? `${pin} is analog-only on ${ctx.profile.name} and has no digital input/output buffer`
            : options.mode === 'uart'
              ? `${pin} carries the hardware serial port on ${ctx.profile.name}, which the firmware is using`
              : `${pin} lacks the capability required by ${assignment.signal}`;
    push(ctx, issue, {
      artifact: 'pinAssignments',
      op: 'set_pin_assignment',
      assignmentId: assignment.id,
      assignment: {
        pin: replacement.name,
        pinNumber: replacement.number,
        targetInstanceId: assignment.targetInstanceId,
        targetPin: assignment.targetPin,
        rationale: `Fixer: ${why}; ${replacement.name} is the next free suitable pin.${replacement.caution ? ` Caution: ${replacement.caution}.` : ''}`,
        source: 'fixer',
      },
      reason: `Moved ${assignment.targetInstanceId}.${assignment.targetPin} from ${pin} to ${replacement.name} — ${why}.`,
    });
    emitEndpointMoves(ctx, issue, assignment.mcuInstanceId, pin, replacement.name);
    moved += 1;
  }
  return moved > 0;
}

/** Re-point the wiring edges that used the old MCU pin. */
function emitEndpointMoves(ctx: Ctx, issue: ValidationIssue, mcuInstanceId: string | undefined, fromPin: string, toPin: string): void {
  if (!mcuInstanceId) return;
  for (const connection of ctx.project.wiring?.connections ?? []) {
    const fromMatches = connection.from.instanceId === mcuInstanceId && connection.from.pin === fromPin;
    const toMatches = connection.to.instanceId === mcuInstanceId && connection.to.pin === fromPin;
    if (!fromMatches && !toMatches) continue;
    push(ctx, issue, {
      artifact: 'wiring',
      op: 'replace_connection',
      connectionId: connection.id,
      ...(fromMatches ? { fromPin: toPin } : {}),
      ...(toMatches ? { toPin: toPin } : {}),
      reason: `Wire ${connection.id} follows the pin move ${fromPin} → ${toPin}.`,
    });
  }
}

function pinOfIssue(ctx: Ctx, issue: ValidationIssue): string | undefined {
  const target = issue.target;
  if (target?.pin && target.pin.trim().length > 0) {
    if (ctx.profile) {
      const normalised = normaliseMcuPin(ctx.profile, target.pin);
      if (normalised) return normalised;
    }
    return target.pin;
  }
  if (target?.assignmentId) {
    return ctx.project.pinAssignments.find((assignment) => assignment.id === target.assignmentId)?.pin;
  }
  if (target?.connectionId) {
    const connection = (ctx.project.wiring?.connections ?? []).find((entry) => entry.id === target.connectionId);
    if (!connection) return undefined;
    const controllerSide =
      connection.from.instanceId === ctx.controllerInstanceId ? connection.from : connection.to.instanceId === ctx.controllerInstanceId ? connection.to : undefined;
    return controllerSide?.pin;
  }
  return undefined;
}

function assignmentOfIssue(ctx: Ctx, issue: ValidationIssue): PinAssignment | undefined {
  const target = issue.target;
  if (target?.assignmentId) return ctx.project.pinAssignments.find((assignment) => assignment.id === target.assignmentId);
  const pin = target?.pin;
  if (pin) {
    const matches = ctx.project.pinAssignments.filter((assignment) => assignment.pin === pin);
    if (target?.componentInstanceId) {
      return matches.find((assignment) => assignment.targetInstanceId === target.componentInstanceId) ?? matches[0];
    }
    return matches[0];
  }
  if (target?.componentInstanceId) {
    return ctx.project.pinAssignments.find((assignment) => assignment.targetInstanceId === target.componentInstanceId);
  }
  return undefined;
}

/** Add the missing ground wire for an instance. */
function addGroundWire(ctx: Ctx, issue: ValidationIssue): boolean {
  const instanceId = issue.target?.componentInstanceId;
  const controllerId = ctx.controllerInstanceId;
  if (!instanceId || !controllerId) {
    giveUp(ctx, issue, 'The instance or the controller is unknown, so no ground wire can be added.');
    return false;
  }
  const entry = instanceEntry(ctx.project, ctx.catalog, instanceId);
  const pin = groundPinOf(entry?.definition);
  if (!entry || !pin) {
    giveUp(ctx, issue, `${instanceId} has no ground pin in the component database.`);
    return false;
  }
  const groundPin = controllerGroundPin(ctx);
  if (!groundPin) {
    giveUp(ctx, issue, 'No ground reference exists in the wiring graph yet.');
    return false;
  }
  const connection: AddConnectionChange['connection'] = {
    from: { componentId: entry.componentId, instanceId: entry.instanceId, pin },
    to: { componentId: ctx.controllerComponentId ?? '', instanceId: controllerId, pin: groundPin },
    kind: 'ground',
    signal: 'ground',
    protocol: 'power',
    direction: 'bidirectional',
    voltage: 0,
    explanation: `Common ground added by the fixer: ${entry.label} ${pin} to the controller ${groundPin} so every part shares one reference.`,
    source: 'fixer',
    wireColor: GROUND_COLOR,
    metadata: { role: 'fixer_patch', issueId: issue.id },
  };
  return push(ctx, issue, { artifact: 'wiring', op: 'add_connection', connection, reason: issue.message });
}

/** Add the missing supply wire for an instance, reusing the existing rail. */
function addPowerWire(ctx: Ctx, issue: ValidationIssue): boolean {
  const instanceId = issue.target?.componentInstanceId;
  if (!instanceId) {
    giveUp(ctx, issue, 'The instance that needs power is unknown.');
    return false;
  }
  const entry = instanceEntry(ctx.project, ctx.catalog, instanceId);
  const pin = supplyPinOf(entry?.definition);
  if (!entry || !pin) {
    giveUp(ctx, issue, `${instanceId} has no supply pin in the component database.`);
    return false;
  }
  const rail = railEndpoint(ctx);
  if (!rail) {
    giveUp(ctx, issue, 'No supply rail exists in the wiring graph; the power architecture needs a human decision.');
    return false;
  }
  const voltage = rail.voltage ?? entry.definition?.voltage;
  if (voltage !== undefined && entry.definition) {
    const min = entry.definition.minVoltage;
    const max = entry.definition.maxVoltage;
    if ((min !== undefined && voltage < min) || (max !== undefined && voltage > max)) {
      giveUp(ctx, issue, `The available rail (${voltage} V) is outside the ${min ?? '?'}–${max ?? '?'} V range of ${entry.label}.`);
      return false;
    }
  }
  const connection: AddConnectionChange['connection'] = {
    from: { componentId: rail.componentId, instanceId: rail.instanceId, pin: rail.pin },
    to: { componentId: entry.componentId, instanceId: entry.instanceId, pin },
    kind: 'power',
    signal: 'power',
    protocol: 'power',
    direction: 'unidirectional',
    ...(voltage !== undefined ? { voltage } : {}),
    explanation: `Supply added by the fixer: ${rail.instanceId}.${rail.pin}${voltage !== undefined ? ` (${voltage} V)` : ''} to ${entry.label} ${pin}.`,
    source: 'fixer',
    wireColor: POWER_COLOR,
    metadata: { role: 'fixer_patch', issueId: issue.id },
  };
  return push(ctx, issue, { artifact: 'wiring', op: 'add_connection', connection, reason: issue.message });
}

/** Remap a pin name that does not exist on the part to the closest real one. */
function closestPinName(definition: ComponentDefinition | undefined, wanted: string): string | undefined {
  if (!definition) return undefined;
  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = normalise(wanted);
  const exact = definition.pins.find((pin) => normalise(pin.name) === target);
  if (exact) return exact.name;
  for (const pin of definition.pins) {
    for (const alias of pin.aliases ?? []) {
      if (normalise(alias) === target) return pin.name;
    }
  }
  const partial = definition.pins.find((pin) => normalise(pin.name).includes(target) || target.includes(normalise(pin.name)));
  return partial?.name;
}

function fixUnknownPin(ctx: Ctx, issue: ValidationIssue): boolean {
  const instanceId = issue.target?.componentInstanceId;
  const badPin = issue.target?.pin;
  if (!instanceId || !badPin) {
    giveUp(ctx, issue, 'The unknown pin could not be located on a specific instance.');
    return false;
  }
  const entry = instanceEntry(ctx.project, ctx.catalog, instanceId);
  const replacement = closestPinName(entry?.definition, badPin);
  if (!replacement || replacement === badPin) {
    giveUp(ctx, issue, `${entry?.definition?.name ?? instanceId} has no pin close enough to "${badPin}" to remap safely.`);
    return false;
  }

  let emitted = false;
  for (const connection of ctx.project.wiring?.connections ?? []) {
    const fromMatches = connection.from.instanceId === instanceId && connection.from.pin === badPin;
    const toMatches = connection.to.instanceId === instanceId && connection.to.pin === badPin;
    if (!fromMatches && !toMatches) continue;
    emitted =
      push(ctx, issue, {
        artifact: 'wiring',
        op: 'replace_connection',
        connectionId: connection.id,
        ...(fromMatches ? { fromPin: replacement } : {}),
        ...(toMatches ? { toPin: replacement } : {}),
        reason: `Pin "${badPin}" does not exist on ${entry?.label ?? instanceId}; remapped to "${replacement}".`,
      }) || emitted;
  }
  for (const assignment of ctx.project.pinAssignments) {
    if (assignment.targetInstanceId !== instanceId || assignment.targetPin !== badPin) continue;
    emitted =
      push(ctx, issue, {
        artifact: 'pinAssignments',
        op: 'set_pin_assignment',
        assignmentId: assignment.id,
        assignment: {
          pin: assignment.pin,
          targetInstanceId: assignment.targetInstanceId,
          targetPin: replacement,
          rationale: `Fixer: catalog pin "${badPin}" does not exist on ${entry?.definition?.name ?? instanceId}; using "${replacement}".`,
          source: 'fixer',
        },
        reason: `Retargeted assignment ${assignment.id} to the real pin "${replacement}".`,
      }) || emitted;
  }
  if (!emitted) giveUp(ctx, issue, `Nothing references ${instanceId}.${badPin} any more.`);
  return emitted;
}

/** Give a required-but-unwired peripheral pin an MCU pin and a wire. */
function fixFloatingPin(ctx: Ctx, issue: ValidationIssue): boolean {
  const instanceId = issue.target?.componentInstanceId;
  const pinName = issue.target?.pin;
  if (!instanceId || !pinName) {
    giveUp(ctx, issue, 'The floating pin could not be located.');
    return false;
  }
  const entry = instanceEntry(ctx.project, ctx.catalog, instanceId);
  const pin = entry?.definition?.pins.find((candidate) => candidate.name === pinName);
  if (!entry || !pin) {
    giveUp(ctx, issue, `${pinName} is not a known pin of ${instanceId}.`);
    return false;
  }
  if (pin.direction === 'output' || pin.type === 'motor' || pin.type === 'power' || pin.type === 'ground') {
    giveUp(ctx, issue, `${entry.label} ${pinName} is a ${pin.direction}/${pin.type} pin — wiring it needs a hardware decision, not a pin patch.`);
    return false;
  }
  if (!ctx.profile || !ctx.controllerInstanceId) {
    giveUp(ctx, issue, 'No controller/profile available to allocate a pin.');
    return false;
  }

  // Never invent a second assignment for a pin the plan already covers: two
  // assignments for one peripheral pin become two `const int` declarations with
  // the SAME name in the sketch, which is a hard compile error.
  const alreadyAssigned = ctx.project.pinAssignments.find(
    (assignment) => assignment.targetInstanceId === instanceId && assignment.targetPin.toLowerCase() === pinName.toLowerCase(),
  );
  if (alreadyAssigned) {
    giveUp(
      ctx,
      issue,
      `${entry.label} ${pinName} is already assigned to ${alreadyAssigned.pin} (assignment ${alreadyAssigned.id}); the reported floating pin is stale rather than real.`,
    );
    return false;
  }

  const direction: 'input' | 'output' = pin.direction === 'input' ? 'output' : 'input';
  const signal: SignalType = pin.type === 'analog' ? 'analog' : pin.type === 'pwm' ? 'pwm' : pin.type === 'enable' ? 'enable' : 'digital';
  const replacement = freePin(ctx, { direction, capabilities: capabilitiesFor(signal), signal });
  if (!replacement) {
    giveUp(ctx, issue, `No free ${direction} pin remains on ${ctx.profile.name} for ${entry.label} ${pinName}.`);
    return false;
  }
  ctx.plannedPins.add(replacement.name);

  const assignment: PinAssignment = {
    id: `assign-${changeId()}`,
    mcuInstanceId: ctx.controllerInstanceId,
    mcuComponentId: ctx.controllerComponentId ?? ctx.profile.componentId,
    pin: replacement.name,
    pinNumber: replacement.number,
    targetInstanceId: entry.instanceId,
    targetComponentId: entry.componentId,
    targetPin: pin.name,
    purpose: pin.signal ?? `Drive ${entry.label} ${pin.name}`,
    signal,
    direction,
    protocol: signal === 'analog' ? 'adc' : signal === 'pwm' ? 'pwm' : 'gpio',
    required: pin.required ?? false,
    rationale: `Fixer: ${pin.name} was left floating; ${replacement.name} is the next free ${direction} pin on ${ctx.profile.name}.`,
    source: 'fixer',
  };

  const pushed = push(ctx, issue, {
    artifact: 'pinAssignments',
    op: 'set_pin_assignment',
    assignment,
    reason: `Assigned ${replacement.name} to the floating required pin ${entry.label} ${pin.name}.`,
  });
  if (!pushed) return false;

  const controllerGroundSide = {
    componentId: ctx.controllerComponentId ?? ctx.profile.componentId,
    instanceId: ctx.controllerInstanceId,
    pin: replacement.name,
  };
  const connection: AddConnectionChange['connection'] = {
    from: direction === 'output' ? controllerGroundSide : { componentId: entry.componentId, instanceId: entry.instanceId, pin: pin.name },
    to: direction === 'output' ? { componentId: entry.componentId, instanceId: entry.instanceId, pin: pin.name } : controllerGroundSide,
    kind: 'signal',
    signal,
    protocol: signal === 'analog' ? 'adc' : signal === 'pwm' ? 'pwm' : 'gpio',
    direction: 'unidirectional',
    voltage: ctx.profile.logicVoltage,
    explanation: `Fixer: ${assignment.purpose} — ${ctx.controllerInstanceId} ${replacement.name} ${direction === 'output' ? '→' : '←'} ${entry.label} ${pin.name}.`,
    source: 'fixer',
    wireColor: signalColor(ctx),
    metadata: { role: 'fixer_patch', issueId: issue.id },
  };
  push(ctx, issue, { artifact: 'wiring', op: 'add_connection', connection, reason: `Wire for the newly assigned pin ${replacement.name}.` });
  return true;
}

/** Find a driver in the catalog that can serve the given motor. */
export function chooseDriverFor(motor: ComponentDefinition | undefined, catalog: ComponentDefinition[], motorCount: number): ComponentDefinition | undefined {
  if (!motor) return undefined;
  const motorType = motor.motorRequirements?.motorType ?? 'dc';
  const neededMa = motor.currentRequirements?.maxMa ?? motor.currentRequirements?.typicalMa;
  const candidates = catalog
    .filter((component) => component.category === 'motor_driver')
    .filter((component) => (component.motorRequirements?.motorType ?? 'dc') === motorType)
    .filter((component) => (component.motorRequirements?.channels ?? 1) >= Math.min(motorCount, component.motorRequirements?.channels ?? 1))
    .filter((component) => {
      const perChannel = component.motorRequirements?.maxCurrentPerChannelMa;
      if (perChannel === undefined || neededMa === undefined) return true;
      return perChannel >= neededMa;
    })
    .sort((a, b) => (b.motorRequirements?.maxCurrentPerChannelMa ?? 0) - (a.motorRequirements?.maxCurrentPerChannelMa ?? 0));
  return candidates[0] ?? catalog.find((component) => component.category === 'motor_driver');
}

/** Find the catalog part that best matches a name the model invented. */
export function closestCatalogMatch(wanted: string, catalog: ComponentDefinition[]): ComponentDefinition | undefined {
  const tokens = wanted
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
  if (tokens.length === 0) return undefined;

  let best: { definition: ComponentDefinition; score: number } | undefined;
  for (const definition of catalog) {
    const haystack = [definition.id, definition.name, ...(definition.aliases ?? []), ...(definition.keywords ?? [])]
      .join(' ')
      .toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) score += 1;
      if (definition.aliases?.some((alias) => alias.toLowerCase() === token)) score += 2;
    }
    const ratio = score / tokens.length;
    if (ratio >= 0.6 && (!best || ratio > best.score)) best = { definition, score: ratio };
  }
  return best?.definition;
}

/** Look up a library requirement by header or name across catalog + plan. */
function findLibrary(ctx: Ctx, needle: string): LibraryRequirement | undefined {
  const header = needle.toLowerCase().replace(/[<>"']/g, '').trim();
  const bare = header.replace(/\.h$/, '');
  const pools: LibraryRequirement[][] = [
    ctx.project.artifacts.libraries?.libraries ?? [],
    ctx.project.softwarePlan?.libraries ?? [],
    ...ctx.project.components.map((selection) => definitionFor(ctx.catalog, selection.componentId)?.libraryRequirements ?? []),
    ctx.catalog.map((component) => component.libraryRequirements ?? []).flat(),
  ];
  for (const pool of pools) {
    const match = pool.find((library) => {
      const libHeader = library.import.toLowerCase().replace(/[<>"']/g, '');
      return libHeader === header || libHeader.replace(/\.h$/, '') === bare || library.name.toLowerCase() === bare;
    });
    if (match) return match;
  }
  return undefined;
}

/* ------------------------------------------------------------------------- */
/* Dispatcher                                                                 */
/* ------------------------------------------------------------------------- */

const RERUN_ARTIFACT: Record<RerunStage, RerunStageChange['artifact']> = {
  pins: 'pinAssignments',
  wiring: 'wiring',
  diagram: 'diagram',
  instructions: 'instructions',
  libraries: 'libraries',
  code: 'code',
};

function rerun(ctx: Ctx, issue: ValidationIssue, stage: RerunStage, reason: string): boolean {
  return push(ctx, issue, { artifact: RERUN_ARTIFACT[stage], op: 'rerun_stage', stage, reason });
}

/** Re-derive a stage fully (skips the in-place re-sync shortcut in the applier). */
function rerunForced(ctx: Ctx, issue: ValidationIssue, stage: RerunStage, reason: string): boolean {
  return push(ctx, issue, { artifact: RERUN_ARTIFACT[stage], op: 'rerun_stage', stage, force: true, reason });
}

function planForIssue(ctx: Ctx, issue: ValidationIssue): void {
  const code: ValidationIssueCode = issue.code;

  switch (code) {
    case 'gpio_conflict': {
      const pin = pinOfIssue(ctx, issue);
      if (!pin) {
        giveUp(ctx, issue, 'The contested GPIO could not be identified.');
        return;
      }
      relocateAssignments(ctx, issue, pin, { mode: 'conflict', keepAssignmentId: issue.target?.assignmentId });
      return;
    }

    case 'reserved_pin_used': {
      const pin = pinOfIssue(ctx, issue);
      if (!pin) {
        giveUp(ctx, issue, 'The reserved pin could not be identified.');
        return;
      }
      relocateAssignments(ctx, issue, pin, { mode: 'reserved' });
      return;
    }

    case 'input_only_pin_driven': {
      const pin = pinOfIssue(ctx, issue);
      if (!pin) {
        giveUp(ctx, issue, 'The input-only pin could not be identified.');
        return;
      }
      relocateAssignments(ctx, issue, pin, { mode: 'input-only' });
      return;
    }

    case 'analog_only_pin_driven': {
      const pin = pinOfIssue(ctx, issue);
      if (!pin) {
        giveUp(ctx, issue, 'The analog-only pin could not be identified.');
        return;
      }
      relocateAssignments(ctx, issue, pin, { mode: 'analog-only' });
      return;
    }

    case 'uart_pin_used_as_gpio': {
      const pin = pinOfIssue(ctx, issue);
      if (!pin) {
        giveUp(ctx, issue, 'The UART pin could not be identified.');
        return;
      }
      relocateAssignments(ctx, issue, pin, { mode: 'uart' });
      return;
    }

    case 'duplicate_pin_assignment': {
      /*
       * Mirror the emitter: the FIRST assignment for a pin is the one
       * uniqueCodeAssignments() keeps, so the repair drops the later claim.
       * remove_pin_assignment also removes the wire that assignment owned;
       * the peripheral it freed becomes a floating required pin, which the
       * next validation pass reports and fixes on its own.
       */
      const assignmentId = issue.target?.assignmentId;
      if (!assignmentId || !ctx.project.pinAssignments.some((assignment) => assignment.id === assignmentId)) {
        giveUp(ctx, issue, 'The duplicate assignment could not be located.');
        return;
      }
      push(ctx, issue, {
        artifact: 'pinAssignments',
        op: 'remove_pin_assignment',
        assignmentId,
        reason: `Removed the duplicate claim on ${issue.target?.pin ?? 'the contested pin'}; the first assignment for that pin is the one the sketch emits.`,
      });
      return;
    }

    case 'capability_mismatch': {
      const pin = pinOfIssue(ctx, issue);
      if (!pin) {
        giveUp(ctx, issue, 'The pin with the missing capability could not be identified.');
        return;
      }
      relocateAssignments(ctx, issue, pin, { mode: 'capability' });
      return;
    }

    case 'missing_ground':
      addGroundWire(ctx, issue);
      return;

    case 'missing_power':
      addPowerWire(ctx, issue);
      return;

    case 'duplicate_connection':
    case 'output_to_output': {
      const connectionId = issue.target?.connectionId;
      if (!connectionId) {
        giveUp(ctx, issue, 'No connection id was reported, so nothing can be removed safely.');
        return;
      }
      push(ctx, issue, {
        artifact: 'wiring',
        op: 'remove_connection',
        connectionId,
        reason: code === 'duplicate_connection' ? `Removed duplicate wire ${connectionId}.` : `Removed wire ${connectionId}: two outputs must never be tied together.`,
      });
      return;
    }

    case 'dangling_reference': {
      const connectionId = issue.target?.connectionId;
      if (connectionId) {
        push(ctx, issue, {
          artifact: 'wiring',
          op: 'remove_connection',
          connectionId,
          reason: `Removed wire ${connectionId}: it references a component instance that is not in the bill of materials.`,
        });
        return;
      }
      giveUp(ctx, issue, 'The dangling reference is not attached to a specific wire.');
      return;
    }

    case 'unknown_pin':
      fixUnknownPin(ctx, issue);
      return;

    case 'floating_required_pin':
      fixFloatingPin(ctx, issue);
      return;

    case 'motor_on_mcu_pin': {
      const motorId = issue.target?.componentId ?? issue.target?.componentInstanceId;
      const motor = motorId
        ? definitionFor(ctx.catalog, motorId) ?? instanceEntry(ctx.project, ctx.catalog, motorId)?.definition
        : undefined;
      const motorCount = ctx.project.components
        .filter((selection) => selection.category === 'motor')
        .reduce((sum, selection) => sum + selection.quantity, 0);
      const driver = chooseDriverFor(motor, ctx.catalog, Math.max(1, motorCount));
      if (!driver) {
        giveUp(ctx, issue, 'The component database has no driver suitable for this motor.');
        return;
      }
      const role: ComponentRole = ROLE_BY_CATEGORY[driver.category] ?? 'driver';
      const added = push(ctx, issue, {
        artifact: 'components',
        op: 'add_component',
        componentId: driver.id,
        quantity: 1,
        role,
        required: true,
        reason: `${motor?.name ?? 'The motor'} must not be driven straight from an MCU pin — adding ${driver.name} from the catalog.`,
      });
      if (!added) return;
      rerun(ctx, issue, 'pins', 'Pin plan must include the new driver channels.');
      rerun(ctx, issue, 'wiring', 'Wiring must route motor outputs through the new driver.');
      return;
    }

    case 'missing_component': {
      const componentId = issue.target?.componentId;
      const needsDriver = /driver/i.test(issue.message) || /H-bridge/i.test(issue.fixHint ?? '');
      if (componentId && needsDriver) {
        const motor = definitionFor(ctx.catalog, componentId);
        const driver = chooseDriverFor(motor, ctx.catalog, 1);
        if (driver) {
          const role: ComponentRole = ROLE_BY_CATEGORY[driver.category] ?? 'driver';
          const added = push(ctx, issue, {
            artifact: 'components',
            op: 'add_component',
            componentId: driver.id,
            quantity: 1,
            role,
            required: true,
            reason: `${motor?.name ?? componentId} requires a driver: adding ${driver.name} from the catalog.`,
          });
          if (added) {
            rerun(ctx, issue, 'pins', 'Pin plan must include the new driver.');
            rerun(ctx, issue, 'wiring', 'Wiring must include the new driver.');
          }
          return;
        }
      }
      if (componentId && !needsDriver && definitionFor(ctx.catalog, componentId)) {
        const definition = definitionFor(ctx.catalog, componentId) as ComponentDefinition;
        const role: ComponentRole = ROLE_BY_CATEGORY[definition.category] ?? 'other';
        push(ctx, issue, {
          artifact: 'components',
          op: 'add_component',
          componentId,
          quantity: 1,
          role,
          required: true,
          reason: issue.message,
        });
        return;
      }
      giveUp(ctx, issue, 'Choosing this component needs an engineering decision (voltage/current/headroom).');
      return;
    }

    case 'quantity_shortfall': {
      /*
       * The brief counted parts the design never selected. The validator
       * already named the catalog part that closes the gap (from the brief's
       * own detected features), so the repair is a single add — no guessing.
       *
       * The count is re-derived rather than parsed out of the message: the
       * fixer and the validator must agree on what "missing" means, and both
       * can compute it from the same design.
       */
      const componentId = issue.target?.componentId;
      const definition = componentId ? definitionFor(ctx.catalog, componentId) : undefined;
      if (!componentId || !definition) {
        giveUp(
          ctx,
          issue,
          'The brief names a part family but no catalog part is close enough to add safely; choosing one needs an engineering decision.',
        );
        return;
      }

      const shortfall = evaluateQuantityDelivery({
        requirements: ctx.project.requirements,
        selections: ctx.project.components,
        catalog: ctx.catalog,
      }).find((entry) => entry.suggestedComponentId === componentId && entry.missing > 0);

      if (!shortfall) {
        giveUp(ctx, issue, 'The shortfall could not be re-derived from the current design.');
        return;
      }

      /*
       * `add_component` reads `quantity` as an ABSOLUTE target, not a delta:
       * for a part already in the build the applier does
       * `max(existing, change.quantity)`. The shortfall is a delta, so it has
       * to be resolved against whatever is already selected — otherwise
       * "asked for 4, built 1" repairs to 3 and stops one short.
       */
      const existing = ctx.project.components.find((selection) => selection.componentId === componentId);
      const target = (existing?.quantity ?? 0) + shortfall.missing;

      const role: ComponentRole = ROLE_BY_CATEGORY[definition.category] ?? 'other';
      const added = push(ctx, issue, {
        artifact: 'components',
        op: 'add_component',
        componentId,
        quantity: target,
        role,
        required: true,
        reason: `The brief asks for ${shortfall.expected} ${shortfall.label}; adding ${shortfall.missing} × ${definition.name}.`,
      });
      if (!added) return;

      /*
       * New hardware changes everything downstream, and the sketch most of
       * all: the behaviour templates are chosen from the parts actually
       * present, so a sensor-less build only grows line-following logic when
       * the firmware is regenerated. `code` is forced for exactly that reason —
       * the applier's default is to re-sync the managed blocks in place, which
       * would tidy the pin map and leave the empty skeleton untouched.
       */
      rerun(ctx, issue, 'pins', 'The new part needs pin assignments.');
      rerun(ctx, issue, 'wiring', 'The new part needs power and signal wiring.');
      rerunForced(ctx, issue, 'code', 'Sketch behaviour is derived from the parts present, so the firmware must be rebuilt.');
      rerun(ctx, issue, 'libraries', 'The new part may need a library.');
      rerun(ctx, issue, 'diagram', 'The diagram must show the new part.');
      rerun(ctx, issue, 'instructions', 'The guide must cover the new part.');
      return;
    }

    case 'unknown_component':
    case 'invented_component': {
      const selectionId = issue.target?.selectionId;
      const selection = selectionId ? selectionById(ctx.project, selectionId) : undefined;
      if (!selection) {
        giveUp(ctx, issue, 'The selection to replace could not be found.');
        return;
      }
      const match = closestCatalogMatch(`${selection.matchedFrom ?? ''} ${selection.name} ${selection.componentId}`, ctx.catalog);
      if (!match || match.id === selection.componentId) {
        giveUp(ctx, issue, `No catalog part is close enough to "${selection.name}" to substitute automatically.`);
        return;
      }
      push(ctx, issue, {
        artifact: 'components',
        op: 'replace_component',
        selectionId: selection.id,
        componentId: match.id,
        quantity: selection.quantity,
        role: selection.role,
        reason: `Replaced ungrounded "${selection.componentId}" with catalog part ${match.id} (${match.name}).`,
      });
      rerun(ctx, issue, 'pins', 'Pin names differ between the substituted parts.');
      rerun(ctx, issue, 'wiring', 'Wiring must follow the substituted part.');
      return;
    }

    case 'code_pin_mismatch': {
      // Handled by the firmware pin-map re-sync performed by the applier.
      ctx.handled.add(issue.id);
      ctx.notes.push(`Firmware pin constants will be re-synchronised with the pin plan (${issue.target?.filePath ?? 'sketch.ino'}).`);
      return;
    }

    case 'code_i2c_address_invalid':
    case 'code_missing_bus_init':
    case 'code_stray_include': {
      // Repaired by the deterministic firmware hygiene pass in the applier.
      ctx.handled.add(issue.id);
      ctx.notes.push(`${issue.code}: firmware hygiene pass will repair ${issue.target?.filePath ?? 'sketch.ino'}.`);
      return;
    }

    case 'code_missing_include': {
      const needle = issue.target?.library ?? '';
      const library = findLibrary(ctx, needle);
      if (library) {
        push(ctx, issue, {
          artifact: 'libraries',
          op: 'add_library',
          library,
          reason: `Ensured ${library.name} is listed so ${library.import} is included.`,
        });
      }
      ctx.handled.add(issue.id);
      ctx.notes.push(`Include block will be re-synchronised for ${needle || 'the reported library'}.`);
      return;
    }

    case 'library_missing': {
      const header = issue.target?.library ?? '';
      const library = findLibrary(ctx, header);
      if (library) {
        push(ctx, issue, {
          artifact: 'libraries',
          op: 'add_library',
          library,
          reason: `libraries.json did not list ${library.name} even though the firmware includes ${library.import}.`,
        });
        return;
      }
      const bare = header.replace(/[<>"']/g, '').replace(/\.h$/i, '');
      push(ctx, issue, {
        artifact: 'libraries',
        op: 'add_library',
        library: {
          name: bare || header,
          import: header.includes('.') ? header.replace(/[<>]/g, '') : `${header}.h`,
          manager: 'arduino',
          purpose: `Added by the fixer because the firmware includes <${header}> (no catalog entry matched).`,
        },
        reason: `Listed ${header} in libraries.json so the include resolves at build time.`,
      });
      return;
    }

    case 'code_missing_setup_loop': {
      const path = issue.target?.filePath ?? ctx.project.artifacts.code?.entryPoint ?? 'sketch.ino';
      const file = (ctx.project.artifacts.code?.files ?? []).find((entry) => entry.path === path);
      if (!file) {
        giveUp(ctx, issue, `${path} is not part of the generated firmware.`);
        return;
      }
      const missingSetup = !/void\s+setup\s*\(/.test(file.content);
      const missingLoop = !/void\s+loop\s*\(/.test(file.content);
      const placeholder = /\b(TODO|FIXME|your code here|placeholder)\b/i.test(file.content);
      if (missingSetup || missingLoop) {
        const stub = [
          missingSetup ? 'void setup() {\n  // Added by the Wireup fixer: initialise pins and peripherals here.\n}' : '',
          missingLoop ? 'void loop() {\n  // Added by the Wireup fixer: main control loop.\n}' : '',
        ]
          .filter((block) => block.length > 0)
          .join('\n\n');
        push(ctx, issue, {
          artifact: 'code',
          op: 'patch_code_file',
          path,
          mode: 'append',
          content: `\n\n${stub}\n`,
          reason: `Added the missing ${[missingSetup ? 'setup()' : '', missingLoop ? 'loop()' : ''].filter(Boolean).join(' and ')} so the sketch is a valid Arduino program.`,
        });
        return;
      }
      if (placeholder) {
        giveUp(ctx, issue, 'Placeholder markers remain in the sketch — filling them in needs application logic, not a patch.');
        return;
      }
      giveUp(ctx, issue, 'No missing setup()/loop() detected any more.');
      return;
    }

    case 'code_unbalanced_braces': {
      const path = issue.target?.filePath ?? ctx.project.artifacts.code?.entryPoint ?? 'sketch.ino';
      const file = (ctx.project.artifacts.code?.files ?? []).find((entry) => entry.path === path);
      if (!file) {
        giveUp(ctx, issue, `${path} is not part of the generated firmware.`);
        return;
      }
      const balance = braceBalance(file.content);
      if (balance > 0) {
        push(ctx, issue, {
          artifact: 'code',
          op: 'patch_code_file',
          path,
          mode: 'append',
          content: `\n${'}\n'.repeat(balance)}`,
          reason: `Closed ${balance} unterminated block(s) in ${path}.`,
        });
        return;
      }
      giveUp(ctx, issue, `${path} has ${-balance} stray closing brace(s) — removing them automatically could delete real logic.`);
      return;
    }

    case 'firmware_compile_error': {
      const details = issue.details ?? issue.message;
      push(ctx, issue, {
        artifact: 'code',
        op: 'rerun_stage',
        stage: 'code',
        reason: `Compiler error reported: ${details.slice(0, 150)}. Re-generating firmware sketch to satisfy compiler.`,
      });
      return;
    }

    case 'behavioral_assertion_failed': {
      const failure = parseBehavioralFailure(issue);
      const path = issue.target?.filePath ?? ctx.project.artifacts.code?.entryPoint ?? 'sketch.ino';
      const file = (ctx.project.artifacts.code?.files ?? []).find((entry) => entry.path === path);
      const content = file?.content ?? '';

      /* Numeric constants the assertion pinned down can be patched directly. */
      if (failure.assertionId === 'pin-min-length' || failure.assertionId === 'pin-max-length') {
        const target = Number.parseInt(failure.expected, 10);
        const constant = failure.assertionId === 'pin-min-length' ? 'PIN_MIN_LENGTH' : 'PIN_MAX_LENGTH';
        const present = file !== undefined && new RegExp(`\\b${constant}\\s*=\\s*\\d+`).test(content);
        if (Number.isFinite(target) && present) {
          push(ctx, issue, {
            artifact: 'code',
            op: 'patch_code_file',
            path,
            mode: 'regex_replace',
            find: `(${constant}\\s*=\\s*)\\d+`,
            replace: `$1${target}`,
            reason: `Behavioural assertion failed: expected ${constant} = ${failure.expected}, got ${failure.got}. Corrected the constant.`,
          });
          return;
        }
        rerunForced(
          ctx,
          issue,
          'code',
          `Behavioural assertion failed: expected ${constant} = ${failure.expected}, got ${failure.got}. Regenerating the firmware deterministically.`,
        );
        return;
      }

      if (failure.assertionId === 'default-pin-covers-min') {
        const min = Number.parseInt(failure.expected, 10);
        const present = file !== undefined && /const\s+char\s*\*\s*fallback\s*=\s*"[0-9]*"/.test(content);
        if (Number.isFinite(min) && present) {
          const digits = '1234567890'.repeat(Math.ceil(min / 10)).slice(0, min);
          push(ctx, issue, {
            artifact: 'code',
            op: 'patch_code_file',
            path,
            mode: 'regex_replace',
            find: '(const\\s+char\\s*\\*\\s*fallback\\s*=\\s*")[0-9]*(")',
            replace: `$1${digits}$2`,
            reason: `Behavioural assertion failed: factory default must be at least ${min} digits, got ${failure.got}.`,
          });
          return;
        }
        rerunForced(
          ctx,
          issue,
          'code',
          `Behavioural assertion failed: factory default too short (expected ≥ ${failure.expected}, got ${failure.got}). Regenerating deterministically.`,
        );
        return;
      }

      /*
       * Logic-level failures (inverted reset, spurious press counter, telemetry
       * shape) can't be repaired with a safe one-line patch; the deterministic
       * template is the source of truth, so re-derive the sketch from it.
       */
      rerunForced(
        ctx,
        issue,
        'code',
        `Behavioural assertion failed: expected ${failure.expected}, got ${failure.got}. Regenerating the firmware deterministically.`,
      );
      return;
    }

    case 'sim_behavior_mismatch': {
      /*
       * Real AVR simulation found a behavior mismatch. This is like
       * behavioral_assertion_failed but from real hardware emulation rather
       * than the host-exec stub. The fix is the same: regenerate the firmware
       * deterministically since there's no safe one-line patch for logic errors.
       *
       * The sim_behavior_mismatch code is NOT in AUTO_FIXABLE_CODES because
       * real sim mismatches usually need code changes the LLM fixer should propose.
       * The deterministic fixer just triggers a rerun; the LLM fixer will
       * handle the actual code changes if needed.
       */
      const details = issue.details ?? issue.message;
      rerunForced(
        ctx,
        issue,
        'code',
        `Real AVR simulation behavior mismatch: ${details.slice(0, 200)}. Regenerating the firmware deterministically.`,
      );
      return;
    }

    case 'diagram_out_of_sync':
    case 'diagram_missing_component':
    case 'diagram_missing_connection':
      rerun(ctx, issue, 'diagram', 'diagram.json is re-derived from the current component list and wiring graph.');
      return;

    case 'instructions_out_of_sync':
    case 'instructions_missing_section':
      rerun(ctx, issue, 'instructions', 'Instructions are re-derived from the patched components, wiring and pin map.');
      return;

    case 'library_unused':
      giveUp(ctx, issue, 'Removing a library can break conditional code paths; left for review.');
      return;

    case 'assembly_unknown_part':
    case 'assembly_bad_placement': {
      const plan = ctx.project.assembly;
      const diagram = ctx.project.artifacts.diagram;
      if (!plan || !diagram) {
        giveUp(ctx, issue, 'There is no 3D assembly to prune.');
        return;
      }
      const valid = new Set(diagram.components.map((component) => component.id));
      const roles = Object.entries(plan.bindings)
        .filter(([, id]) => id && !valid.has(id))
        .map(([role]) => role);
      const instanceIds = new Set<string>();
      for (const [id, seat] of Object.entries(plan.placements)) {
        const bad =
          !valid.has(id) ||
          !seat ||
          !Number.isFinite(seat.x) ||
          !Number.isFinite(seat.y) ||
          !Number.isFinite(seat.z) ||
          Math.abs(seat.x) > 1500 ||
          seat.y < 0 ||
          seat.y > 800 ||
          Math.abs(seat.z) > 1500;
        if (bad) instanceIds.add(id);
      }
      for (const id of plan.parametric) {
        if (!valid.has(id)) instanceIds.add(id);
      }
      if (roles.length === 0 && instanceIds.size === 0) {
        giveUp(ctx, issue, 'The stale 3D seats could not be identified.');
        return;
      }
      push(ctx, issue, {
        artifact: 'assembly',
        op: 'prune_assembly',
        roles,
        instanceIds: [...instanceIds],
        reason: 'Stale 3D seats are pruned so every seat points at a real part; pruned parts fall back to the bench grid.',
      });
      return;
    }

    case 'assembly_overlap':
      giveUp(ctx, issue, 'Only a human (or a fresh 3D re-plan) can judge the intended layout.');
      return;

    /*
     * A missing or malformed CODE artifact has a deterministic repair: the
     * sketch is fully re-derivable from the software plan + pin plan, and the
     * code refresher's `force` path regenerates exactly that. The old
     * behaviour gave up here, so a build that lost its firmware ("No firmware
     * source was generated" + the schema violation on the empty artifact)
     * shipped both errors with nothing in the loop willing to act.
     */
    case 'empty_artifact':
    case 'schema_violation': {
      if (issue.domain === 'code') {
        rerunForced(
          ctx,
          issue,
          'code',
          'The firmware artifact is missing or malformed — rebuilt deterministically from the software plan and pin plan.',
        );
        return;
      }
      giveUp(ctx, issue, 'No deterministic patch exists for this issue code — it needs a model proposal or a human decision.');
      return;
    }

    /*
     * The power budget named the shortfall; the repair is a supply that can
     * actually deliver it. The sustained load is re-derived from the same
     * budget engine (never parsed from the message), the smallest catalog
     * supply with ≥10% headroom over it wins, and everything that depends on
     * the supply (budget, wiring, diagram, instructions) is re-derived. When
     * no catalog supply is big enough the issue stays unresolved — honestly,
     * because guessing a battery that also fails helps nobody.
     */
    case 'power_budget_exceeded': {
      /* The budget engine wants the controller *selection* (with instances). */
      const controllerComponentId = ctx.project.hardwarePlan?.controller?.componentId;
      const controller = controllerComponentId
        ? ctx.project.components.find((selection) => selection.componentId === controllerComponentId) ?? null
        : null;
      const budget = computePowerBudget({
        selections: ctx.project.components,
        catalog: ctx.catalog,
        controller,
        ...(ctx.profile ? { profile: ctx.profile } : {}),
      });
      const neededMa = budget.sustainedPeakMa ?? 0;
      if (neededMa <= 0) {
        giveUp(ctx, issue, 'The sustained load could not be re-derived from the current design.');
        return;
      }
      const supply = selectSupply(ctx.project.components, ctx.catalog);
      if (!supply) {
        giveUp(ctx, issue, 'No power supply selection exists to upgrade — a supply must be chosen first.');
        return;
      }
      const targetMa = Math.ceil(neededMa * 1.1);
      const candidates = ctx.catalog
        .filter((component) => component.category === 'power' && component.powerSourceRequirements?.outputVoltage !== undefined)
        .filter((component) => (component.powerSourceRequirements?.maxCurrentMa ?? 0) >= targetMa)
        .filter((component) => component.id !== supply.componentId)
        .filter((component) => component.metadata.unsuitableForMotors !== true || neededMa <= 300)
        .sort(
          (a, b) =>
            (a.powerSourceRequirements?.maxCurrentMa ?? 0) - (b.powerSourceRequirements?.maxCurrentMa ?? 0) ||
            (a.powerSourceRequirements?.outputVoltage ?? 0) - (b.powerSourceRequirements?.outputVoltage ?? 0),
        );
      const replacement = candidates[0];
      if (!replacement) {
        giveUp(
          ctx,
          issue,
          `No catalog supply can deliver the sustained ~${neededMa} mA load — the design must shed loads or the operator must pick a bigger supply.`,
        );
        return;
      }
      const replaced = push(ctx, issue, {
        artifact: 'components',
        op: 'replace_component',
        selectionId: supply.id,
        componentId: replacement.id,
        quantity: 1,
        role: 'power',
        reason: `The sustained load is ~${neededMa} mA and ${supply.name} cannot deliver it; ${replacement.name} (${replacement.powerSourceRequirements?.maxCurrentMa ?? '?'} mA) covers it with headroom.`,
      });
      if (replaced) {
        rerun(ctx, issue, 'wiring', 'The supply rails and power wiring must be re-derived for the new supply.');
        rerun(ctx, issue, 'diagram', 'The diagram must show the new supply.');
        rerun(ctx, issue, 'instructions', 'The guide must cover the new supply.');
      }
      return;
    }

    case 'missing_controller':
    case 'incompatible_components':
    case 'invalid_voltage':
    case 'requirement_uncovered':
    case 'duplicate_instance_id':
    case 'model_review':
    default:
      giveUp(ctx, issue, 'No deterministic patch exists for this issue code — it needs a model proposal or a human decision.');
      return;
  }
}

/* ------------------------------------------------------------------------- */
/* Entry point                                                                */
/* ------------------------------------------------------------------------- */

export function planDeterministicChanges(input: StrategyInput): StrategyOutcome {
  const controller = input.project.hardwarePlan?.controller;
  const ctx: Ctx = {
    project: input.project,
    catalog: input.catalog,
    ...(input.profile ? { profile: input.profile } : {}),
    iteration: input.iteration,
    changes: [],
    notes: [],
    handled: new Set(),
    unresolved: [],
    seen: new Set(),
    rerun: new Set(),
    plannedPins: new Set(),
    signalColorIndex: (input.project.wiring?.connections ?? []).filter((connection: WiringConnection) => connection.kind === 'signal').length,
    ...(controller ? { controllerInstanceId: controller.instanceId, controllerComponentId: controller.componentId } : {}),
  };

  /* Errors first: they gate the build. Warnings only get patched when there is
     room left in the change budget. */
  const ordered = [...input.issues].sort((a, b) => {
    const rank = { error: 0, warning: 1, info: 2 } as const;
    return rank[a.severity] - rank[b.severity];
  });

  for (const issue of ordered) {
    if (ctx.changes.length >= MAX_CHANGES_PER_PASS) break;
    planForIssue(ctx, issue);
  }

  /* A pin or component change always invalidates derived artifacts. */
  const touchedPins = ctx.changes.some((change) => change.artifact === 'pinAssignments');
  const touchedComponents = ctx.changes.some((change) => change.artifact === 'components');
  const touchedWiring = ctx.changes.some((change) => change.artifact === 'wiring');
  if (touchedComponents) {
    ctx.rerun.add('pins');
    ctx.rerun.add('wiring');
  }
  if (touchedPins || touchedWiring) ctx.rerun.add('diagram');
  if (touchedComponents || touchedPins || touchedWiring) ctx.rerun.add('instructions');

  for (const stage of ctx.rerun) {
    if (!ctx.seen.has(`rerun_stage:${stage}`)) {
      ctx.seen.add(`rerun_stage:${stage}`);
      ctx.changes.push({
        id: changeId(),
        artifact: RERUN_ARTIFACT[stage],
        op: 'rerun_stage',
        stage,
        reason: `Upstream artifacts changed, so ${stage} must be re-derived to stay consistent.`,
        origin: 'deterministic',
      });
    }
  }

  if (ctx.changes.length > 0) {
    ctx.notes.push(
      `${ctx.changes.length} targeted change(s) planned for ${ctx.handled.size} issue(s); ${ctx.unresolved.length} issue(s) have no deterministic repair.`,
    );
  }

  return {
    changes: ctx.changes,
    notes: [...new Set(ctx.notes)],
    handledIssueIds: Array.from(ctx.handled),
    unresolved: ctx.unresolved,
    rerunStages: Array.from(ctx.rerun),
  };
}
