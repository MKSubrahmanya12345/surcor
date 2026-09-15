/**
 * Pin planner.
 *
 * Assigns real MCU pins to every peripheral pin that needs one, using the MCU
 * capability profile: protocol pins (I2C/UART/SPI), PWM-capable pins for speed
 * control, ADC pins for analog sensors, input-only and strapping restrictions,
 * reserved flash pins, and current/protocol sharing rules.
 *
 * Model-suggested pins are honoured when they are legal; otherwise the planner
 * overrides them and records why.
 */

import type { ComponentDefinition, ComponentInstance, ComponentSelection } from '@/types/component';
import type { PinAssignment, SignalType } from '@/types/wiring';
import type { AgentEventLog } from '@/lib/logging/events';
import { assignmentId } from '@/lib/validation/ids';

import {
  getMcuProfile,
  normaliseMcuPin,
  pinSpec,
  usablePins,
  type McuPinSpec,
  type McuProfile,
  type PinCapability,
} from './mcu-profiles';

export interface SerialLink {
  id: string;
  kind: 'hardware' | 'software';
  mcuTxPin: string;
  mcuRxPin: string;
  peripheralInstanceId: string;
  peripheralComponentId: string;
  baud?: number;
  note: string;
}

export interface I2CBus {
  id: string;
  sdaPin: string;
  sclPin: string;
  devices: { instanceId: string; componentId: string; address?: string }[];
}

export interface ModelPinRequest {
  componentId: string;
  instanceIndex: number;
  pin: string;
  mcuPin?: string;
  purpose?: string;
  signal?: string;
  direction?: 'input' | 'output';
  protocol?: string;
  required?: boolean;
}

export interface PinPlanResult {
  assignments: PinAssignment[];
  serialLinks: SerialLink[];
  i2cBuses: I2CBus[];
  notes: string[];
  /** Model pin requests that were overridden, with the reason. */
  overrides: { instanceId: string; pin: string; requested: string; assigned: string; reason: string }[];
  /** Peripheral pins that could not be assigned (out of pins / capability gap). */
  unassigned: { instanceId: string; componentId: string; pin: string; reason: string }[];
}

interface Demand {
  instance: ComponentInstance;
  definition: ComponentDefinition;
  pinName: string;
  /** Direction from the MCU's point of view. */
  mcuDirection: 'input' | 'output';
  signal: SignalType;
  protocol: 'gpio' | 'adc' | 'pwm' | 'uart' | 'i2c' | 'spi' | 'one_wire' | 'other';
  capabilities: PinCapability[];
  /**
   * Capabilities that may never be traded away. `capabilities` can be relaxed
   * when the firmware has a software workaround (a bit-banged PWM, say); these
   * cannot, because the silicon simply does not have the function — an AVR
   * analog-only pin (A6/A7 on a Nano) has no digital input buffer at all.
   */
  hardCapabilities: PinCapability[];
  required: boolean;
  purpose: string;
  scarcity: number;
}

const MCU_CONNECTABLE_TYPES = new Set(['digital', 'analog', 'pwm', 'uart', 'i2c', 'spi', 'one_wire', 'enable']);

function isIntegrated(definition: ComponentDefinition): boolean {
  return definition.metadata.integrated === true || definition.metadata.participatesInWiring === false;
}

/**
 * A matrix keypad is an `input_device`, but its pins are NOT all read the same
 * way: the MCU *drives* the row lines and *reads* the column lines. Treating it
 * like a single-pin switch would wire all eight pins as inputs and make the
 * matrix unscannable.
 */
function isMatrixScanned(definition: ComponentDefinition): boolean {
  return definition.metadata.keypadMatrix !== undefined || definition.metadata.matrixScanned === true;
}

function isPassiveOrMedium(definition: ComponentDefinition): boolean {
  return definition.category === 'prototyping' || definition.category === 'passive' || definition.metadata.electrical === false;
}

/** Pins of a peripheral that must land on an MCU pin. */
function mcuFacingPins(definition: ComponentDefinition): { pinName: string; required: boolean }[] {
  const pins = definition.pins.filter((entry) => MCU_CONNECTABLE_TYPES.has(entry.type));

  // Special cases for two/three terminal parts whose other legs go to rails.
  if (definition.id === 'pushbutton-6mm') return [{ pinName: '1', required: true }];
  if (definition.id === 'potentiometer-10k') return [{ pinName: 'WIPER', required: true }];
  if (definition.metadata.requiresVoltageDivider === true) {
    const analogPin = pins.find((entry) => entry.type === 'analog') ?? pins[0];
    return analogPin ? [{ pinName: analogPin.name, required: true }] : [];
  }

  const required = pins.filter((entry) => entry.required).map((entry) => ({ pinName: entry.name, required: true }));
  if (required.length > 0) return required;

  // Nothing marked required: still connect the most informative optional pin.
  const preferred =
    pins.find((entry) => entry.type === 'analog' && entry.direction === 'output') ??
    pins.find((entry) => entry.direction === 'output' && (entry.type === 'digital' || entry.type === 'one_wire')) ??
    pins.find((entry) => entry.type === 'enable') ??
    pins[0];

  return preferred ? [{ pinName: preferred.name, required: false }] : [];
}

interface CapabilityNeed {
  /** Preferred capability; the planner relaxes it when no such pin is free. */
  soft: PinCapability[];
  /** Never relaxed: the pin physically cannot do the job without it. */
  hard: PinCapability[];
}

function capabilitiesFor(definition: ComponentDefinition, pinName: string, signal: SignalType): CapabilityNeed {
  const componentPin = definition.pins.find((entry) => entry.name === pinName);
  const type = componentPin?.type;

  if (type === 'i2c') return { soft: ['i2c'], hard: [] };
  if (type === 'spi') return { soft: ['spi'], hard: [] };
  if (type === 'uart') return { soft: ['uart'], hard: [] };
  if (type === 'analog' || signal === 'analog') return { soft: ['adc'], hard: ['adc'] };

  const needsPwm =
    type === 'pwm' ||
    type === 'enable' ||
    definition.category === 'actuator' && /buzzer-passive|rgb-led|neopixel/i.test(definition.id);
  if (needsPwm) return { soft: ['pwm'], hard: [] };

  /*
   * Plain GPIO still needs a *digital* pin. Without this the planner happily
   * hands a keypad column to A6/A7 on an Arduino Nano, which are analog-only:
   * they have no digital input buffer, so the pin reads nothing and the
   * firmware silently never sees a key press.
   */
  return { soft: [], hard: ['digital'] };
}

function signalFor(definition: ComponentDefinition, pinName: string): SignalType {
  const componentPin = definition.pins.find((entry) => entry.name === pinName);
  switch (componentPin?.type) {
    case 'analog':
      return 'analog';
    case 'pwm':
      return 'pwm';
    case 'uart':
      return 'uart';
    case 'i2c':
      return 'i2c';
    case 'spi':
      return 'spi';
    case 'one_wire':
      return 'one_wire';
    case 'enable':
      return 'enable';
    default:
      return 'digital';
  }
}

function protocolFor(signal: SignalType): Demand['protocol'] {
  switch (signal) {
    case 'analog':
      return 'adc';
    case 'pwm':
    case 'enable':
      return 'pwm';
    case 'uart':
      return 'uart';
    case 'i2c':
      return 'i2c';
    case 'spi':
      return 'spi';
    case 'one_wire':
      return 'one_wire';
    default:
      return 'gpio';
  }
}

function scarcityOf(demand: Omit<Demand, 'scarcity'>): number {
  if (demand.protocol === 'i2c' || demand.protocol === 'spi') return 5;
  if (demand.protocol === 'uart') return 4;
  if (demand.protocol === 'adc') return 3;
  if (demand.protocol === 'pwm') return 2;
  return demand.required ? 1 : 0;
}

function buildDemands(selections: ComponentSelection[], catalog: ComponentDefinition[]): Demand[] {
  const demands: Demand[] = [];

  for (const selection of selections) {
    const definition = catalog.find((component) => component.id === selection.componentId);
    if (!definition) continue;
    if (selection.role === 'controller') continue;
    if (isIntegrated(definition) || isPassiveOrMedium(definition)) continue;

    for (const instance of selection.instances) {
      for (const entry of mcuFacingPins(definition)) {
        const componentPin = definition.pins.find((candidate) => candidate.name === entry.pinName);
        if (!componentPin) continue;

        const signal = signalFor(definition, entry.pinName);
        // Peripheral input => MCU drives it (output). Peripheral output => MCU reads it (input).
        // Switches and other passive input devices are always *read* by the MCU
        // — except a matrix keypad, whose row pins are driven and column pins read.
        const passiveInput =
          !isMatrixScanned(definition) &&
          definition.category === 'input_device' &&
          (definition.communicationProtocols?.length ?? 0) === 0;
        const mcuDirection: 'input' | 'output' = passiveInput
          ? 'input'
          : componentPin.direction === 'output'
            ? 'input'
            : componentPin.direction === 'input'
              ? 'output'
              : signal === 'analog'
                ? 'input'
                : 'output';

        const capabilityNeed = capabilitiesFor(definition, entry.pinName, signal);
        const base = {
          instance,
          definition,
          pinName: entry.pinName,
          mcuDirection,
          signal,
          protocol: protocolFor(signal),
          capabilities: capabilityNeed.soft,
          hardCapabilities: capabilityNeed.hard,
          required: entry.required,
          purpose: componentPin.signal ?? `${definition.name} ${entry.pinName}`,
        };

        demands.push({ ...base, scarcity: scarcityOf(base) });
      }
    }
  }

  return demands.sort((a, b) => b.scarcity - a.scarcity || Number(b.required) - Number(a.required));
}

function findModelRequest(requests: ModelPinRequest[], instance: ComponentInstance, pinName: string): ModelPinRequest | undefined {
  return requests.find(
    (request) =>
      request.componentId.toLowerCase() === instance.componentId.toLowerCase() &&
      request.instanceIndex === instance.index &&
      request.pin.toLowerCase() === pinName.toLowerCase(),
  );
}

interface TakenState {
  /** Pin name -> assignments already using it. */
  map: Map<string, PinAssignment[]>;
}

function markTaken(state: TakenState, assignment: PinAssignment): void {
  const existing = state.map.get(assignment.pin) ?? [];
  existing.push(assignment);
  state.map.set(assignment.pin, existing);
}

function isShareable(protocol: Demand['protocol']): boolean {
  return protocol === 'i2c' || protocol === 'spi';
}

function pinSupports(
  profile: McuProfile,
  pinName: string,
  capabilities: PinCapability[],
  direction: 'input' | 'output',
  hardCapabilities: PinCapability[] = [],
): boolean {
  const spec = pinSpec(profile, pinName);
  if (!spec) return false;
  if (direction === 'output' && spec.capabilities.includes('input-only')) return false;
  return (
    capabilities.every((capability) => spec.capabilities.includes(capability)) &&
    hardCapabilities.every((capability) => spec.capabilities.includes(capability))
  );
}

export interface PinPlanInput {
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  controllerInstanceId?: string;
  modelPinAssignments?: unknown;
  events?: AgentEventLog;
}

const RAW_REQUEST_KEYS = ['mcuPin', 'mcu_pin', 'pin', 'gpio', 'mcuPinName'];

function parseModelRequests(raw: unknown): ModelPinRequest[] {
  const list = Array.isArray(raw) ? raw : [];
  const requests: ModelPinRequest[] = [];

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const componentId = String(record.componentId ?? record.component_id ?? record.component ?? '').trim();
    const pin = String(record.pin ?? record.peripheralPin ?? record.targetPin ?? '').trim();
    if (!componentId || !pin) continue;

    let mcuPin: string | undefined;
    for (const key of RAW_REQUEST_KEYS) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        mcuPin = candidate.trim();
        break;
      }
    }

    const instanceIndexRaw = record.instanceIndex ?? record.instance ?? record.index ?? 1;
    const instanceIndex = typeof instanceIndexRaw === 'number' ? instanceIndexRaw : Number.parseInt(String(instanceIndexRaw), 10) || 1;

    requests.push({
      componentId,
      instanceIndex,
      pin,
      ...(mcuPin ? { mcuPin } : {}),
      ...(typeof record.purpose === 'string' ? { purpose: record.purpose } : {}),
      ...(typeof record.signal === 'string' ? { signal: record.signal } : {}),
      ...(record.direction === 'input' || record.direction === 'output' ? { direction: record.direction } : {}),
      ...(typeof record.protocol === 'string' ? { protocol: record.protocol } : {}),
      ...(typeof record.required === 'boolean' ? { required: record.required } : {}),
    });
  }

  return requests;
}

/** Authoritative pin assignment pass. */
export function planPins(input: PinPlanInput): PinPlanResult {
  const { selections, catalog, events } = input;
  const notes: string[] = [];
  const overrides: PinPlanResult['overrides'] = [];
  const unassigned: PinPlanResult['unassigned'] = [];
  const assignments: PinAssignment[] = [];
  const serialLinks: SerialLink[] = [];
  const i2cBuses: I2CBus[] = [];

  const controller = selections.find((selection) => selection.role === 'controller');
  const controllerInstance =
    (input.controllerInstanceId
      ? controller?.instances.find((instance) => instance.instanceId === input.controllerInstanceId)
      : undefined) ?? controller?.instances[0];

  if (!controller || !controllerInstance) {
    return {
      assignments,
      serialLinks,
      i2cBuses,
      notes: ['No microcontroller instance was found, so no pins could be assigned.'],
      overrides,
      unassigned,
    };
  }

  const profile = getMcuProfile(controller.componentId);
  if (!profile) {
    return {
      assignments,
      serialLinks,
      i2cBuses,
      notes: [`No pin capability profile exists for ${controller.name} (${controller.componentId}); add one in modules/pin-planner/mcu-profiles.ts.`],
      overrides,
      unassigned,
    };
  }

  const handle = events?.start('pin_assignment_started', `Assigning ${profile.name} pins...`, {
    stage: 'pins',
    metadata: { mcu: controller.componentId, mcuInstance: controllerInstance.instanceId },
  });

  const requests = parseModelRequests(input.modelPinAssignments);
  const taken: TakenState = { map: new Map() };
  const demands = buildDemands(selections, catalog);

  /* --- Buses first: I2C ---------------------------------------------------- */
  const i2cDemands = demands.filter((demand) => demand.protocol === 'i2c');
  if (i2cDemands.length > 0) {
    const bus: I2CBus = { id: 'i2c0', sdaPin: profile.i2c.sda, sclPin: profile.i2c.scl, devices: [] };
    const knownDevices = new Set<string>();

    for (const demand of i2cDemands) {
      const isSda = demand.pinName.toUpperCase().includes('SDA');
      const mcuPin = isSda ? bus.sdaPin : bus.sclPin;
      const existing = taken.map.get(mcuPin);
      if (existing && !isShareable(demand.protocol)) continue;

      const assignment: PinAssignment = {
        id: assignmentId(),
        mcuInstanceId: controllerInstance.instanceId,
        mcuComponentId: controller.componentId,
        pin: mcuPin,
        pinNumber: pinSpec(profile, mcuPin)?.number,
        targetInstanceId: demand.instance.instanceId,
        targetComponentId: demand.definition.id,
        targetPin: demand.pinName,
        purpose: demand.purpose,
        signal: 'i2c',
        direction: 'output',
        protocol: 'i2c',
        required: demand.required,
        rationale: `${mcuPin} is the default I2C ${isSda ? 'SDA' : 'SCL'} pin on ${profile.name}. I2C is a shared bus, so every device uses the same two pins with distinct addresses.`,
        source: 'planner',
      };
      assignments.push(assignment);
      markTaken(taken, assignment);

      if (!knownDevices.has(demand.instance.instanceId)) {
        knownDevices.add(demand.instance.instanceId);
        const address = demand.definition.metadata.i2cAddress;
        bus.devices.push({
          instanceId: demand.instance.instanceId,
          componentId: demand.definition.id,
          ...(typeof address === 'string' ? { address } : {}),
        });
      }
    }

    if (bus.devices.length > 0) {
      i2cBuses.push(bus);
      notes.push(
        `I2C bus on ${bus.sdaPin}/${bus.sclPin} shared by ${bus.devices.map((device) => `${device.instanceId}${device.address ? ` @ ${device.address}` : ''}`).join(', ')}.`,
      );
    }
  }

  /* --- UART links ---------------------------------------------------------- */
  const uartDemands = demands.filter((demand) => demand.protocol === 'uart');
  const uartByInstance = new Map<string, Demand[]>();
  for (const demand of uartDemands) {
    const list = uartByInstance.get(demand.instance.instanceId) ?? [];
    list.push(demand);
    uartByInstance.set(demand.instance.instanceId, list);
  }

  let uartIndex = 0;
  for (const [instanceId, instanceDemands] of uartByInstance) {
    const definition = instanceDemands[0]?.definition;
    if (!definition) continue;

    const txDemand = instanceDemands.find((demand) => demand.pinName.toUpperCase().includes('RX'));
    const rxDemand = instanceDemands.find((demand) => demand.pinName.toUpperCase().includes('TX'));

    const hardwarePort = profile.uarts.find((uart) => uart.recommended);
    const useHardware = profile.logicVoltage <= 3.3 && hardwarePort !== undefined;
    const linkId = useHardware ? (hardwarePort?.id ?? 'Serial2') : 'SoftwareSerial';

    const exclude = new Set(taken.map.keys());
    const txCandidates = usablePins(profile, { exclude, direction: 'output', capabilities: useHardware ? ['uart'] : [] });
    const txPin =
      (useHardware ? normaliseMcuPin(profile, hardwarePort?.tx ?? '') : undefined) ?? txCandidates[0]?.name ?? undefined;

    if (txPin) exclude.add(txPin);
    const rxCandidates = usablePins(profile, {
      exclude,
      direction: 'input',
      capabilities: useHardware ? ['uart'] : [],
      allowStrapping: true,
    });
    const rxPin = (useHardware ? normaliseMcuPin(profile, hardwarePort?.rx ?? '') : undefined) ?? rxCandidates[0]?.name ?? undefined;

    if (!txPin || !rxPin) {
      for (const demand of instanceDemands) {
        unassigned.push({
          instanceId: demand.instance.instanceId,
          componentId: demand.definition.id,
          pin: demand.pinName,
          reason: 'No free UART-capable pin pair remained on the microcontroller.',
        });
      }
      continue;
    }

    // MCU TX drives the module RXD; MCU RX listens to the module TXD.
    const pair: { demand: Demand | undefined; mcuPin: string; mcuDirection: 'input' | 'output'; purpose: string }[] = [
      { demand: txDemand, mcuPin: txPin, mcuDirection: 'output', purpose: `UART TX → ${definition.name} RXD` },
      { demand: rxDemand, mcuPin: rxPin, mcuDirection: 'input', purpose: `UART RX ← ${definition.name} TXD` },
    ];

    for (const entry of pair) {
      if (!entry.demand) continue;
      const assignment: PinAssignment = {
        id: assignmentId(),
        mcuInstanceId: controllerInstance.instanceId,
        mcuComponentId: controller.componentId,
        pin: entry.mcuPin,
        pinNumber: pinSpec(profile, entry.mcuPin)?.number,
        targetInstanceId: entry.demand.instance.instanceId,
        targetComponentId: definition.id,
        targetPin: entry.demand.pinName,
        purpose: entry.purpose,
        signal: 'uart',
        direction: entry.mcuDirection,
        protocol: 'uart',
        required: entry.demand.required,
        rationale: useHardware
          ? `${entry.mcuPin} belongs to the free hardware UART (${linkId}) on ${profile.name}; TX and RX are cross-connected to the module.`
          : `${profile.name} only has one hardware UART and it is shared with the USB serial bridge, so ${linkId} is used on free digital pins ${txPin}/${rxPin}.`,
        source: 'planner',
      };
      assignments.push(assignment);
      markTaken(taken, assignment);
    }

    const defaultBaud = definition.metadata.defaultBaud;
    serialLinks.push({
      id: uartIndex === 0 ? linkId : `${linkId}${uartIndex + 1}`,
      kind: useHardware ? 'hardware' : 'software',
      mcuTxPin: txPin,
      mcuRxPin: rxPin,
      peripheralInstanceId: instanceId,
      peripheralComponentId: definition.id,
      ...(typeof defaultBaud === 'number' ? { baud: defaultBaud } : {}),
      note: useHardware
        ? `Hardware UART ${linkId} cross-connected to ${definition.name}.`
        : `${linkId} on ${txPin} (TX) / ${rxPin} (RX); remember that SoftwareSerial shares pin-change interrupts with other libraries.`,
    });
    uartIndex += 1;
  }

  /* --- Everything else ----------------------------------------------------- */
  const remaining = demands.filter((demand) => demand.protocol !== 'i2c' && demand.protocol !== 'uart' && demand.protocol !== 'spi');

  for (const demand of remaining) {
    const request = findModelRequest(requests, demand.instance, demand.pinName);
    const requestedPin = request?.mcuPin ? normaliseMcuPin(profile, request.mcuPin) : undefined;

    const useRequested =
      requestedPin !== undefined &&
      !taken.map.has(requestedPin) &&
      pinSupports(profile, requestedPin, demand.capabilities, demand.mcuDirection, demand.hardCapabilities);

    let chosen: McuPinSpec | undefined;
    let rationale = '';
    let source: PinAssignment['source'] = 'planner';

    if (useRequested && requestedPin) {
      chosen = pinSpec(profile, requestedPin);
      const caution = chosen?.caution ? ` Caution: ${chosen.caution}.` : '';
      rationale = `Model requested ${requestedPin} and the MCU profile confirms it supports ${
        demand.capabilities.length > 0 ? demand.capabilities.join('+') : 'general GPIO'
      } as ${demand.mcuDirection}.${caution}`;
      source = 'model';
    } else {
      const exclude = new Set(taken.map.keys());
      const preferred = usablePins(profile, {
        exclude,
        capabilities: [...demand.hardCapabilities, ...demand.capabilities],
        direction: demand.mcuDirection,
        allowStrapping: false,
      });
      chosen = preferred[0];

      if (!chosen) {
        const relaxed = usablePins(profile, {
          exclude,
          capabilities: [...demand.hardCapabilities, ...demand.capabilities],
          direction: demand.mcuDirection,
          allowStrapping: true,
        });
        chosen = relaxed[0];
        if (chosen) rationale = `All non-strapping pins with the required capability were used, so strapping pin ${chosen.name} was assigned. ${chosen.caution ?? ''}`;
      }

      if (!chosen && demand.capabilities.length > 0) {
        // Soft capabilities may be traded away (with a note); hard ones may not.
        const fallback = usablePins(profile, {
          exclude,
          capabilities: demand.hardCapabilities,
          direction: demand.mcuDirection,
          allowStrapping: true,
        });
        chosen = fallback[0];
        if (chosen) {
          rationale = `No ${demand.capabilities.join('+')}-capable pin was free; ${chosen.name} was assigned instead, so the firmware must use a software/timer alternative.`;
          notes.push(`${demand.instance.label ?? demand.instance.name} ${demand.pinName}: no ${demand.capabilities.join('+')} pin available — assigned ${chosen.name} with a software workaround.`);
        }
      }

      if (!chosen) {
        unassigned.push({
          instanceId: demand.instance.instanceId,
          componentId: demand.definition.id,
          pin: demand.pinName,
          reason: 'The microcontroller ran out of usable pins for this signal.',
        });
        continue;
      }

      if (!rationale) {
        rationale = `${chosen.name} is the highest-preference free pin supporting ${
          demand.capabilities.length > 0 ? demand.capabilities.join('+') : 'general GPIO'
        } as an ${demand.mcuDirection}${demand.mcuDirection === 'output' ? ' (output-capable, not input-only)' : ''}.${
          chosen.caution ? ` Caution: ${chosen.caution}.` : ''
        }`;
      }

      if (request?.mcuPin && requestedPin !== undefined && requestedPin !== chosen.name) {
        const reason = taken.map.has(requestedPin)
          ? `${requestedPin} was already assigned to ${taken.map.get(requestedPin)?.[0]?.targetInstanceId ?? 'another signal'}`
          : `${requestedPin} cannot be used as ${demand.mcuDirection} with capability ${
              [...demand.hardCapabilities, ...demand.capabilities].join('+') || 'gpio'
            } on ${profile.name}`;
        overrides.push({ instanceId: demand.instance.instanceId, pin: demand.pinName, requested: request.mcuPin, assigned: chosen.name, reason });
      } else if (request?.mcuPin && requestedPin === undefined) {
        overrides.push({
          instanceId: demand.instance.instanceId,
          pin: demand.pinName,
          requested: request.mcuPin,
          assigned: chosen.name,
          reason: `"${request.mcuPin}" is not a valid pin on ${profile.name} (reserved or non-existent)`,
        });
      }
    }

    if (!chosen) continue;

    const assignment: PinAssignment = {
      id: assignmentId(),
      mcuInstanceId: controllerInstance.instanceId,
      mcuComponentId: controller.componentId,
      pin: chosen.name,
      ...(chosen.number !== undefined ? { pinNumber: chosen.number } : {}),
      targetInstanceId: demand.instance.instanceId,
      targetComponentId: demand.definition.id,
      targetPin: demand.pinName,
      purpose: request?.purpose?.trim() || demand.purpose,
      signal: demand.signal,
      direction: demand.mcuDirection,
      protocol: demand.protocol,
      required: demand.required,
      rationale: rationale.trim(),
      source,
    };

    assignments.push(assignment);
    markTaken(taken, assignment);
  }

  /* --- Reporting ----------------------------------------------------------- */
  if (unassigned.length > 0) {
    notes.push(`${unassigned.length} peripheral pin(s) could not be assigned: ${unassigned.map((entry) => `${entry.instanceId}.${entry.pin}`).join(', ')}.`);
  }
  const usedPins = new Set(assignments.map((assignment) => assignment.pin));
  notes.push(
    `${assignments.length} pin assignment(s) across ${usedPins.size} MCU pin(s); ${profile.pins.length - usedPins.size} usable pin(s) remain free.`,
  );
  if (profile.reserved.length > 0) {
    notes.push(`Reserved and never assignable: ${profile.reserved.map((entry) => `${entry.pin} (${entry.reason})`).join('; ')}.`);
  }

  handle?.complete(`Pin assignment complete — ${assignments.length} assignment(s), ${overrides.length} model override(s)`, {
    assignments: assignments.length,
    overrides: overrides.length,
    unassigned: unassigned.length,
    pinsUsed: usedPins.size,
    serialLinks: serialLinks.length,
    i2cBuses: i2cBuses.length,
  });

  return { assignments, serialLinks, i2cBuses, notes, overrides, unassigned };
}

/* ------------------------------------------------------------------------- */
/* Conflict handling used by the fixer                                        */
/* ------------------------------------------------------------------------- */

export interface PinConflict {
  pin: string;
  assignments: PinAssignment[];
}

/** Same MCU pin used for more than one purpose (I2C/SPI buses excluded). */
export function findPinConflicts(assignments: PinAssignment[]): PinConflict[] {
  const byPin = new Map<string, PinAssignment[]>();
  for (const assignment of assignments) {
    const list = byPin.get(assignment.pin) ?? [];
    list.push(assignment);
    byPin.set(assignment.pin, list);
  }

  const conflicts: PinConflict[] = [];
  for (const [pin, list] of byPin) {
    if (list.length <= 1) continue;
    const allSharedBus = list.every((assignment) => assignment.protocol === 'i2c' || assignment.protocol === 'spi');
    if (allSharedBus) continue;
    conflicts.push({ pin, assignments: list });
  }
  return conflicts;
}

export interface ReassignInput {
  assignments: PinAssignment[];
  profile: McuProfile;
  pin: string;
  /** Assignment that keeps the pin; the others are moved. */
  keepAssignmentId?: string;
  /**
   * Pins to treat as already taken *in addition* to `assignments`. The fixer
   * plans several moves before any of them are applied, so without this every
   * pass re-reads the same stale snapshot and picks the same "free" pin — which
   * is how nine signals once ended up stacked on A2.
   */
  alsoExclude?: Iterable<string>;
}

export interface ReassignResult {
  assignments: PinAssignment[];
  moves: { assignmentId: string; instanceId: string; targetPin: string; from: string; to: string; reason: string }[];
  notes: string[];
}

/** Move conflicting assignments off a pin — the targeted fix for `gpio_conflict`. */
export function reassignPin(input: ReassignInput): ReassignResult {
  const moves: ReassignResult['moves'] = [];
  const notes: string[] = [];
  const next = input.assignments.map((assignment) => ({ ...assignment }));

  const conflicting = next.filter((assignment) => assignment.pin === input.pin);
  const keep =
    (input.keepAssignmentId ? conflicting.find((assignment) => assignment.id === input.keepAssignmentId) : undefined) ??
    conflicting.find((assignment) => assignment.required) ??
    conflicting[0];

  const extraExcluded = new Set(input.alsoExclude ?? []);

  for (const assignment of conflicting) {
    if (!keep || assignment.id === keep.id) continue;

    const exclude = new Set(next.filter((entry) => entry.id !== assignment.id).map((entry) => entry.pin));
    for (const pin of extraExcluded) exclude.add(pin);
    /*
     * A digital signal may only land on a *digital* pin: an AVR analog-only pin
     * (A6/A7 on a Nano) has no digital input buffer, so relocating a keypad
     * column there would silence it forever.
     */
    const capabilities: PinCapability[] =
      assignment.protocol === 'adc' ? ['adc'] : assignment.protocol === 'pwm' ? ['pwm', 'digital'] : ['digital'];

    const candidates =
      usablePins(input.profile, { exclude, capabilities, direction: assignment.direction, allowStrapping: false })[0] ??
      usablePins(input.profile, { exclude, capabilities, direction: assignment.direction, allowStrapping: true })[0] ??
      usablePins(input.profile, { exclude, direction: assignment.direction, allowStrapping: true })[0];

    if (!candidates) {
      notes.push(`Could not relocate ${assignment.targetInstanceId}.${assignment.targetPin}: no free pin on ${input.profile.name}.`);
      continue;
    }

    const from = assignment.pin;
    assignment.pin = candidates.name;
    assignment.pinNumber = candidates.number;
    assignment.source = 'fixer';
    assignment.rationale = `Relocated from ${from} to resolve a GPIO conflict with ${keep.targetInstanceId}.${keep.targetPin}; ${candidates.name} is the next free pin with the required capability.${
      candidates.caution ? ` Caution: ${candidates.caution}.` : ''
    }`;
    moves.push({
      assignmentId: assignment.id,
      instanceId: assignment.targetInstanceId,
      targetPin: assignment.targetPin,
      from,
      to: candidates.name,
      reason: `GPIO conflict on ${from}`,
    });
  }

  return { assignments: next, moves, notes };
}
