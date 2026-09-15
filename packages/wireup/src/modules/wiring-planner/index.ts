/**
 * Wiring planner.
 *
 * Builds the explicit connection graph: every signal wire from the pin
 * assignments, every motor/driver output pair, every power and ground
 * connection, plus the supporting passive network (series resistors, dividers,
 * decoupling, bulk capacitance, level shifting) derived from the catalog.
 *
 * Nothing here is hardcoded for a specific project — the graph falls out of the
 * selected components, their pin definitions and the pin plan.
 */

import type { ComponentDefinition, ComponentInstance, ComponentSelection, PowerBudget } from '@/types/component';
import type {
  ConnectionProtocol,
  PinAssignment,
  SignalType,
  WiringConnection,
  WiringEndpoint,
  WiringNet,
  WiringPlan,
} from '@/types/wiring';
import type { AgentEventLog } from '@/lib/logging/events';
import { connectionId as newConnectionId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';
import type { SerialLink } from '@/modules/pin-planner';

import { detectConflicts, indexInstances, resolvePinName, type InstanceIndexEntry } from './conflicts';

export interface WiringPlannerInput {
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  assignments: PinAssignment[];
  power: PowerBudget;
  controllerInstanceId?: string;
  profile?: McuProfile;
  serialLinks?: SerialLink[];
  modelWiring?: unknown;
  events?: AgentEventLog;
}

const SIGNAL_COLORS = ['#1565c0', '#2e7d32', '#ef6c00', '#6a1b9a', '#00838f', '#4e342e', '#0277bd', '#558b2f'];
const POWER_COLOR = '#c62828';
const GROUND_COLOR = '#212121';

interface RailSource {
  instanceId: string;
  pin: string;
  voltage: number;
  label: string;
  definition?: ComponentDefinition;
}

interface BuilderState {
  connections: WiringConnection[];
  keys: Set<string>;
  notes: string[];
  colorIndex: number;
}

function endpoint(instance: ComponentInstance, pin: string): WiringEndpoint {
  return { componentId: instance.componentId, instanceId: instance.instanceId, pin };
}

function keyFor(from: WiringEndpoint, to: WiringEndpoint): string {
  return [`${from.instanceId}.${from.pin}`, `${to.instanceId}.${to.pin}`].sort().join('<->');
}

function nextSignalColor(state: BuilderState): string {
  const color = SIGNAL_COLORS[state.colorIndex % SIGNAL_COLORS.length] as string;
  state.colorIndex += 1;
  return color;
}

interface AddOptions {
  kind: WiringConnection['kind'];
  signal: SignalType;
  protocol: ConnectionProtocol;
  explanation: string;
  voltage?: number;
  source?: WiringConnection['source'];
  direction?: WiringConnection['direction'];
  metadata?: Record<string, unknown>;
}

function addConnection(
  state: BuilderState,
  from: WiringEndpoint,
  to: WiringEndpoint,
  options: AddOptions,
): WiringConnection | null {
  // A part can never be wired to itself — a self-loop is always a planner bug
  // (e.g. grounding the MCU to its own GND pin), never a real wire.
  if (from.instanceId === to.instanceId) return null;
  const key = keyFor(from, to);
  if (state.keys.has(key)) return null;
  state.keys.add(key);

  const connection: WiringConnection = {
    id: newConnectionId(),
    from,
    to,
    kind: options.kind,
    signal: options.signal,
    protocol: options.protocol,
    direction: options.direction ?? 'unidirectional',
    explanation: options.explanation,
    source: options.source ?? 'planner',
    wireColor:
      options.kind === 'ground' ? GROUND_COLOR : options.kind === 'power' ? POWER_COLOR : nextSignalColor(state),
    ...(options.voltage !== undefined ? { voltage: options.voltage } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };

  state.connections.push(connection);
  return connection;
}

/* ------------------------------------------------------------------------- */
/* Rail resolution                                                            */
/* ------------------------------------------------------------------------- */

function positivePinOf(definition: ComponentDefinition | undefined): string | undefined {
  if (!definition) return undefined;
  const candidates = definition.pins.filter((entry) => entry.type === 'power');
  const explicit = candidates.find((entry) => ['+', 'VIN', 'VM', 'VMOT', 'IN', 'IN+'].includes(entry.name));
  return (explicit ?? candidates[0])?.name;
}

function negativePinOf(definition: ComponentDefinition | undefined): string | undefined {
  if (!definition) return undefined;
  const candidates = definition.pins.filter((entry) => entry.type === 'ground');
  const explicit = candidates.find((entry) => ['-', 'GND', 'IN-', 'GND_IN', 'OUT-', 'GND_OUT'].includes(entry.name));
  return (explicit ?? candidates[0])?.name;
}

function outputPinOf(definition: ComponentDefinition | undefined, voltage?: number): string | undefined {
  if (!definition) return undefined;
  const outputs = definition.pins.filter((entry) => entry.direction === 'output' && entry.type === 'power');
  if (outputs.length > 0) return outputs[0]?.name;
  const byVoltage = definition.pins.find(
    (entry) => entry.type === 'power' && voltage !== undefined && entry.voltage === voltage,
  );
  return byVoltage?.name ?? definition.powerPins[0];
}

function logicPinOf(definition: ComponentDefinition | undefined, voltage: number): string | undefined {
  if (!definition) return undefined;
  const wanted = voltage <= 3.4 ? ['3V3', '3.3V'] : ['5V', 'VCC'];
  for (const candidate of wanted) {
    const found = definition.pins.find((entry) => entry.name.toLowerCase() === candidate.toLowerCase());
    if (found) return found.name;
  }
  return definition.powerPins[0];
}

interface RailPlan {
  ground: { instanceId: string; pin: string };
  supply?: RailSource;
  logic?: RailSource;
  motorRail?: RailSource;
  notes: string[];
}

function resolveRails(
  index: Map<string, InstanceIndexEntry>,
  selections: ComponentSelection[],
  catalog: ComponentDefinition[],
  power: PowerBudget,
  controllerInstanceId?: string,
): RailPlan {
  const notes: string[] = [];

  const controllerEntry = controllerInstanceId ? index.get(controllerInstanceId) : undefined;
  const controllerDefinition = controllerEntry?.definition;
  const groundPin = negativePinOf(controllerDefinition) ?? controllerDefinition?.groundPins[0] ?? 'GND';

  const plan: RailPlan = {
    ground: { instanceId: controllerInstanceId ?? '', pin: groundPin },
    notes,
  };

  // Supply rail.
  const supplyEntry = power.supplyInstanceId ? index.get(power.supplyInstanceId) : undefined;
  if (supplyEntry?.definition) {
    /*
     * When the controller itself is the supply (a USB-powered dev board), VIN is
     * an *input* — the board sources its 5 V rail, so that is the pin other
     * parts can be fed from.
     */
    const boardIsSupply =
      supplyEntry.instanceId === controllerInstanceId && supplyEntry.definition.metadata.usbPowered === true;
    const boardLogicVoltage = supplyEntry.definition.voltage ?? 5;
    const pin = boardIsSupply
      ? (logicPinOf(supplyEntry.definition, boardLogicVoltage) ?? positivePinOf(supplyEntry.definition) ?? '3V3')
      : (positivePinOf(supplyEntry.definition) ?? '+');
    const voltage = boardIsSupply
      ? boardLogicVoltage
      : (supplyEntry.definition.powerSourceRequirements?.outputVoltage ?? supplyEntry.definition.voltage);
    plan.supply = {
      instanceId: supplyEntry.instanceId,
      pin,
      voltage: voltage ?? 0,
      label: boardIsSupply
        ? `${voltage ?? '?'} V board rail (USB powered)`
        : `${voltage ?? '?'} V supply`,
      definition: supplyEntry.definition,
    };
  } else if (selections.some((selection) => selection.category === 'motor' || selection.role === 'driver')) {
    notes.push('No supply component could be resolved for the motor rail.');
  }

  /*
   * Regulator / converter output becomes the logic rail when present.
   *
   * A battery also has `powerSourceRequirements.outputVoltage`, and treating it
   * as "the regulator" made the raw pack voltage the logic rail — so 5 V parts
   * were fed 7.4 V and validation failed every battery-powered design. A
   * regulator converts; a cell only supplies.
   */
  const describes = (definition: ComponentDefinition): string => `${definition.id} ${definition.name}`.toLowerCase();
  const isRegulatorLike = (definition: ComponentDefinition | undefined): boolean =>
    definition?.category === 'power' &&
    definition.powerSourceRequirements?.outputVoltage !== undefined &&
    !/batter|lipo|li-po|li-ion|cell|holder|usb|power\s*bank|bench/i.test(describes(definition)) &&
    /regulat|buck|boost|converter|ldo|lm7805|lm2596|ams1117|mb102/i.test(describes(definition));

  const regulator = selections.find((selection) =>
    isRegulatorLike(catalog.find((component) => component.id === selection.componentId)),
  );

  const logicVoltage = controllerDefinition?.voltage ?? 5;

  if (regulator) {
    const definition = catalog.find((component) => component.id === regulator.componentId);
    const instance = regulator.instances[0];
    const outputVoltage = definition?.powerSourceRequirements?.outputVoltage;
    if (instance && definition && outputVoltage !== undefined) {
      plan.logic = {
        instanceId: instance.instanceId,
        pin: outputPinOf(definition, outputVoltage) ?? 'OUT',
        voltage: outputVoltage,
        label: `${outputVoltage} V regulated rail`,
        definition,
      };
    }
  }

  // Driver on-board regulator (e.g. L298N 78M05) can serve the 5 V rail.
  if (!plan.logic) {
    const driverWithRegulator = selections.find((selection) => {
      const definition = catalog.find((component) => component.id === selection.componentId);
      // The controller's own regulator is handled by the MCU-board-rail branch
      // below; matching it here would make the board's VIN *input* a 5 V source.
      return definition?.category !== 'microcontroller' && typeof definition?.metadata.onboardRegulator === 'string';
    });
    const definition = driverWithRegulator ? catalog.find((component) => component.id === driverWithRegulator.componentId) : undefined;
    const threshold = typeof definition?.metadata.regulatorInputThresholdV === 'number' ? definition.metadata.regulatorInputThresholdV : undefined;
    const supplyVoltage = plan.supply?.voltage;

    if (driverWithRegulator && definition && supplyVoltage !== undefined && (threshold === undefined || supplyVoltage >= threshold)) {
      const instance = driverWithRegulator.instances[0];
      const fiveVoltPin = definition.pins.find((entry) => entry.name === '5V' || (entry.voltage === 5 && entry.type === 'power'));
      if (instance && fiveVoltPin) {
        plan.logic = {
          instanceId: instance.instanceId,
          pin: fiveVoltPin.name,
          voltage: 5,
          label: '5 V from the driver on-board regulator',
          definition,
        };
        notes.push(
          `${definition.name} provides the 5 V logic rail through its on-board ${String(definition.metadata.onboardRegulator)} regulator (supply ${supplyVoltage} V ≥ ${threshold ?? 'threshold'} V).`,
        );
      }
    }
  }

  // Otherwise the MCU board regulator feeds low-current peripherals.
  if (!plan.logic && controllerEntry && controllerDefinition) {
    const pin = logicPinOf(controllerDefinition, logicVoltage);
    if (controllerInstanceId && pin) {
      plan.logic = {
        instanceId: controllerInstanceId,
        pin,
        voltage: logicVoltage,
        label: `${logicVoltage} V MCU board rail`,
        definition: controllerDefinition,
      };
    }
  }

  plan.motorRail = plan.supply;
  if (!plan.ground.instanceId) notes.push('No controller instance available to anchor the common ground net.');

  return plan;
}

/* ------------------------------------------------------------------------- */
/* Passive allocation                                                         */
/* ------------------------------------------------------------------------- */

interface PassivePool {
  seriesResistors: ComponentInstance[];
  dividerResistors: ComponentInstance[];
  bulkCapacitors: ComponentInstance[];
  decouplingCapacitors: ComponentInstance[];
  diodes: ComponentInstance[];
  levelShifterChannels: { instance: ComponentInstance; channel: number }[];
}

function collectPassives(selections: ComponentSelection[], catalog: ComponentDefinition[]): PassivePool {
  const pool: PassivePool = {
    seriesResistors: [],
    dividerResistors: [],
    bulkCapacitors: [],
    decouplingCapacitors: [],
    diodes: [],
    levelShifterChannels: [],
  };

  for (const selection of selections) {
    const definition = catalog.find((component) => component.id === selection.componentId);
    if (!definition) continue;

    if (definition.category === 'passive' && typeof definition.metadata.resistanceOhm === 'number') {
      const value = definition.metadata.resistanceOhm as number;
      if (value <= 1000) pool.seriesResistors.push(...selection.instances);
      else pool.dividerResistors.push(...selection.instances);
      continue;
    }
    if (/capacitor/i.test(definition.id)) {
      const capacitance = typeof definition.metadata.capacitanceF === 'number' ? (definition.metadata.capacitanceF as number) : 0;
      if (capacitance >= 0.0001) pool.bulkCapacitors.push(...selection.instances);
      else pool.decouplingCapacitors.push(...selection.instances);
      continue;
    }
    if (/diode/i.test(definition.id)) {
      pool.diodes.push(...selection.instances);
      continue;
    }
    if (/level\s*shifter/i.test(definition.name)) {
      const channels = typeof definition.metadata.channels === 'number' ? (definition.metadata.channels as number) : 4;
      for (let channel = 1; channel <= channels; channel += 1) {
        for (const instance of selection.instances) pool.levelShifterChannels.push({ instance, channel });
      }
    }
  }

  return pool;
}

/* ------------------------------------------------------------------------- */
/* Driver ↔ motor linking                                                     */
/* ------------------------------------------------------------------------- */

interface ChannelMapEntry {
  channel: string;
  outputs: string[];
}

function channelMapOf(definition: ComponentDefinition | undefined): ChannelMapEntry[] {
  const raw = definition?.metadata.channelMap;
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => {
        const record = entry as Record<string, unknown>;
        const outputs = Array.isArray(record.outputs) ? record.outputs.map((value) => String(value)) : [];
        return { channel: String(record.channel ?? ''), outputs };
      })
      .filter((entry) => entry.outputs.length > 0);
  }
  if (!definition) return [];

  const outputs = definition.pins.filter((entry) => entry.type === 'motor' && entry.direction === 'output').map((entry) => entry.name);
  const channels: ChannelMapEntry[] = [];
  for (let i = 0; i + 1 < outputs.length; i += 2) {
    channels.push({ channel: String.fromCharCode(65 + channels.length), outputs: [outputs[i] as string, outputs[i + 1] as string] });
  }
  return channels;
}

function motorTerminalsOf(definition: ComponentDefinition | undefined): string[] {
  if (!definition) return [];
  const motorPins = definition.pins.filter((entry) => entry.type === 'motor').map((entry) => entry.name);
  if (motorPins.length >= 2) return motorPins;
  const bipolar = definition.pins.filter((entry) => /COIL/.test(entry.name)).map((entry) => entry.name);
  return bipolar.length > 0 ? bipolar : motorPins;
}

/* ------------------------------------------------------------------------- */
/* Main planner                                                               */
/* ------------------------------------------------------------------------- */

export function planWiring(input: WiringPlannerInput): WiringPlan {
  const { selections, catalog, assignments, power, profile, events } = input;
  const handle = events?.start('wiring_started', 'Planning wiring and connections...', {
    stage: 'wiring',
    metadata: { assignments: assignments.length },
  });

  const state: BuilderState = { connections: [], keys: new Set(), notes: [], colorIndex: 0 };
  const index = indexInstances(selections, catalog);

  const controllerSelection = selections.find((selection) => selection.role === 'controller');
  const controllerInstance =
    (input.controllerInstanceId ? index.get(input.controllerInstanceId) : undefined) ??
    (controllerSelection ? index.get(controllerSelection.instances[0]?.instanceId ?? '') : undefined);
  const controllerInstanceId = controllerInstance?.instanceId;

  const rails = resolveRails(index, selections, catalog, power, controllerInstanceId);
  state.notes.push(...rails.notes);

  const passives = collectPassives(selections, catalog);
  const seriesResistorQueue = [...passives.seriesResistors];
  const dividerResistorQueue = [...passives.dividerResistors];
  const decouplingQueue = [...passives.decouplingCapacitors];
  const levelShifterQueue = [...passives.levelShifterChannels];

  const controllerDefinition = controllerInstance?.definition;
  const mcuLogicVoltage = rails.logic?.voltage ?? controllerDefinition?.voltage ?? 5;
  const groundEndpoint = (): WiringEndpoint | null => {
    if (!controllerInstanceId) return null;
    const entry = index.get(controllerInstanceId);
    return { componentId: entry?.componentId ?? '', instanceId: controllerInstanceId, pin: rails.ground.pin };
  };

  const needsLevelShift = (peripheralDefinition: ComponentDefinition | undefined): boolean => {
    if (!peripheralDefinition) return false;
    const partLogic = typeof peripheralDefinition.metadata.logicVoltage === 'number'
      ? (peripheralDefinition.metadata.logicVoltage as number)
      : peripheralDefinition.voltage;
    const outputsFive = peripheralDefinition.metadata.echoOutputVoltage === 5 || peripheralDefinition.metadata.outputLogicVoltage === 5;
    if (partLogic === undefined) return false;
    return Math.abs(partLogic - mcuLogicVoltage) > 0.4 || outputsFive === true;
  };

  /* --- 1. Signal connections from pin assignments -------------------------- */
  for (const assignment of assignments) {
    const mcuEntry = index.get(assignment.mcuInstanceId);
    const targetEntry = index.get(assignment.targetInstanceId);
    if (!mcuEntry || !targetEntry) {
      state.notes.push(`Pin assignment ${assignment.id} references an unknown instance and was skipped.`);
      continue;
    }

    const targetPin = resolvePinName(targetEntry.definition, assignment.targetPin) ?? assignment.targetPin;
    const mcuPin = assignment.pin;
    const from: WiringEndpoint = { componentId: mcuEntry.componentId, instanceId: mcuEntry.instanceId, pin: mcuPin };
    const to: WiringEndpoint = { componentId: targetEntry.componentId, instanceId: targetEntry.instanceId, pin: targetPin };

    const baseExplanation = `${mcuEntry.definition?.name ?? mcuEntry.componentId} ${mcuPin} ${assignment.direction === 'output' ? '→' : '←'} ${targetEntry.instance.label ?? targetEntry.definition?.name ?? ''} ${targetPin}: ${assignment.purpose}`;
    const commonOptions = {
      kind: 'signal' as const,
      signal: assignment.signal,
      protocol: assignment.protocol,
      voltage: mcuLogicVoltage,
      direction: 'unidirectional' as const,
    };

    // Series resistor insertion for LEDs.
    const isLed = targetEntry.definition?.category === 'actuator' && /led/i.test(targetEntry.definition.id) && assignment.direction === 'output';
    if (isLed && seriesResistorQueue.length > 0) {
      const resistor = seriesResistorQueue.shift();
      const resistorDefinition = resistor ? index.get(resistor.instanceId)?.definition : undefined;
      if (resistor && resistorDefinition) {
        const resistorPins = resistorDefinition.pins.map((entry) => entry.name);
        const firstPin = resistorPins[0] ?? '1';
        const secondPin = resistorPins[1] ?? '2';
        addConnection(state, from, endpoint(resistor, firstPin), {
          ...commonOptions,
          explanation: `${baseExplanation} — through a ${String(resistorDefinition.metadata.resistanceOhm ?? '')} Ω series resistor to limit LED current.`,
          metadata: { role: 'current_limiting', via: resistor.instanceId },
        });
        addConnection(state, endpoint(resistor, secondPin), to, {
          ...commonOptions,
          explanation: `Series resistor ${resistor.instanceId} to ${targetEntry.instance.label ?? targetEntry.definition?.name ?? ''} anode.`,
          metadata: { role: 'current_limiting', via: resistor.instanceId },
        });
        continue;
      }
    }

    // Level shifting between mixed-voltage logic.
    if (needsLevelShift(targetEntry.definition) && levelShifterQueue.length > 0 && assignment.protocol !== 'i2c') {
      const channel = levelShifterQueue.shift();
      const shifterDefinition = channel ? index.get(channel.instance.instanceId)?.definition : undefined;
      if (channel && shifterDefinition) {
        const mcuSideIsLow = mcuLogicVoltage <= 3.4;
        const mcuSidePin = mcuSideIsLow ? `LV${channel.channel}` : `HV${channel.channel}`;
        const peripheralSidePin = mcuSideIsLow ? `HV${channel.channel}` : `LV${channel.channel}`;
        const shifterEndpoint = (pin: string): WiringEndpoint => ({
          componentId: channel.instance.componentId,
          instanceId: channel.instance.instanceId,
          pin,
        });

        addConnection(state, from, shifterEndpoint(mcuSidePin), {
          ...commonOptions,
          explanation: `${baseExplanation} — routed through level shifter channel ${channel.channel} (${mcuSideIsLow ? 'low' : 'high'} side) to keep both sides inside their logic ratings.`,
          metadata: { role: 'level_shift', channel: channel.channel },
        });
        addConnection(state, shifterEndpoint(peripheralSidePin), to, {
          ...commonOptions,
          explanation: `Level shifter channel ${channel.channel} (${mcuSideIsLow ? 'high' : 'low'} side) to ${to.instanceId}.${to.pin}.`,
          metadata: { role: 'level_shift', channel: channel.channel },
        });
        void shifterDefinition;
        continue;
      }
    }

    addConnection(state, from, to, {
      ...commonOptions,
      explanation: baseExplanation,
      source: assignment.source === 'model' ? 'model' : 'planner',
      metadata: { assignmentId: assignment.id, rationale: assignment.rationale },
    });
  }

  /* --- 2. Driver outputs → motors ------------------------------------------ */
  const drivers = selections.filter((selection) => selection.category === 'motor_driver');
  const motors = selections
    .filter((selection) => selection.category === 'motor')
    .flatMap((selection) => selection.instances.map((instance) => ({ instance, definition: catalog.find((component) => component.id === selection.componentId) })));

  let motorCursor = 0;
  for (const driver of drivers) {
    const driverDefinition = catalog.find((component) => component.id === driver.componentId);
    const channels = channelMapOf(driverDefinition);

    for (const driverInstance of driver.instances) {
      for (const channel of channels) {
        const motor = motors[motorCursor];
        motorCursor += 1;
        if (!motor || !motor.definition) {
          state.notes.push(`${driverInstance.instanceId} channel ${channel.channel} has no motor connected — fewer motors than driver channels.`);
          continue;
        }

        const motorDefinition = motor.definition;
        const terminals = motorTerminalsOf(motorDefinition);
        channel.outputs.forEach((outputPin, outputIndex) => {
          const terminal = terminals[outputIndex];
          if (!terminal) return;
          addConnection(
            state,
            { componentId: driverInstance.componentId, instanceId: driverInstance.instanceId, pin: outputPin },
            endpoint(motor.instance, terminal),
            {
              kind: 'signal',
              signal: 'motor_drive',
              protocol: 'other',
              direction: 'unidirectional',
              explanation: `${driverDefinition?.name ?? driver.name} channel ${channel.channel} output ${outputPin} drives ${motor.instance.label ?? motorDefinition.name} terminal ${terminal}. The H-bridge reverses polarity across this pair to change direction.`,
              metadata: { channel: channel.channel, motor: motor.instance.instanceId },
            },
          );
        });
      }
    }
  }

  if (motorCursor < motors.length) {
    for (let i = motorCursor; i < motors.length; i += 1) {
      const motor = motors[i];
      if (motor) state.notes.push(`${motor.instance.label ?? motor.instance.name} has no driver channel left — add another driver or reduce the motor count.`);
    }
  }

  /* --- 3. Power distribution ----------------------------------------------- */
  const ground = groundEndpoint();

  const connectGround = (instanceId: string, definition: ComponentDefinition | undefined, why: string) => {
    if (!ground || ground.instanceId === instanceId) return;
    const entry = index.get(instanceId);
    if (!entry) return;
    const pin = negativePinOf(definition ?? entry.definition) ?? entry.definition?.groundPins[0];
    if (!pin) return;
    addConnection(
      state,
      { componentId: entry.componentId, instanceId, pin },
      ground,
      {
        kind: 'ground',
        signal: 'ground',
        protocol: 'power',
        direction: 'bidirectional',
        voltage: 0,
        explanation: `Common ground: ${entry.instance.label ?? entry.definition?.name ?? instanceId} ${pin} to ${controllerDefinition?.name ?? 'MCU'} ${ground.pin}. ${why}`,
      },
    );
  };

  const connectPower = (instanceId: string, pin: string, rail: RailSource | undefined, why: string) => {
    if (!rail) {
      state.notes.push(`${instanceId} ${pin} could not be powered: no suitable rail was resolved.`);
      return;
    }
    const entry = index.get(instanceId);
    if (!entry) return;
    addConnection(
      state,
      { componentId: rail.instanceId, instanceId: rail.instanceId, pin: rail.pin },
      { componentId: entry.componentId, instanceId, pin },
      {
        kind: 'power',
        signal: 'power',
        protocol: 'power',
        direction: 'unidirectional',
        voltage: rail.voltage,
        explanation: `${rail.label} (${rail.instanceId}.${rail.pin}) → ${entry.instance.label ?? entry.definition?.name ?? instanceId} ${pin}. ${why}`,
      },
    );
  };

  const signalOnlyParts: string[] = [];

  for (const selection of selections) {
    const definition = catalog.find((component) => component.id === selection.componentId);
    if (!definition) continue;
    if (definition.metadata.electrical === false || definition.metadata.integrated === true) continue;

    for (const instance of selection.instances) {
      /* Supply sources themselves anchor the rails. */
      if (definition.category === 'power' && definition.powerSourceRequirements?.outputVoltage !== undefined) {
        if (ground) {
          const negative = negativePinOf(definition);
          if (negative) {
            addConnection(
              state,
              { componentId: instance.componentId, instanceId: instance.instanceId, pin: negative },
              ground,
              {
                kind: 'ground',
                signal: 'ground',
                protocol: 'power',
                direction: 'bidirectional',
                voltage: 0,
                explanation: `Supply negative (${definition.name} ${negative}) tied to the system ground so all logic shares one reference.`,
              },
            );
          }
        }
        continue;
      }

      /* Motors are fed by the driver, not by a rail. */
      if (definition.category === 'motor' && definition.motorRequirements?.motorType !== 'servo') continue;

      /* Passive parts are wired by their dedicated rules below. */
      if (definition.category === 'passive') continue;

      /*
       * A contact- or signal-only part (tactile switch, membrane keypad) has no
       * supply rail of its own — it is powered through whatever it switches.
       * Reporting that once per instance buried the wiring notes under sixteen
       * identical "left unpowered" warnings for a single keypad's worth of
       * buttons, so these are collected and reported once.
       */
      if (definition.metadata.noSupplyPins === true) {
        if (definition.groundPins.length === 0) signalOnlyParts.push(instance.instanceId);
        continue;
      }

      /*
       * A USB-powered board that sources the logic rail is the reference for
       * everything else; it must not be wired to its own 5V/GND pins.
       */
      if (
        definition.category === 'microcontroller' &&
        instance.instanceId === controllerInstanceId &&
        (rails.logic?.instanceId === instance.instanceId || rails.supply?.instanceId === instance.instanceId)
      ) {
        continue;
      }

      /* Motor drivers: supply rail on the power input, logic rail on VCC. */
      if (definition.category === 'motor_driver') {
        const supplyPin =
          definition.pins.find((entry) => ['+12V', 'VM', 'VMOT', 'VCC2'].includes(entry.name))?.name ?? positivePinOf(definition);
        if (supplyPin) {
          connectPower(instance.instanceId, supplyPin, rails.motorRail, 'Motor supply rail feeds the H-bridge power stage.');
        }

        const hasOnboardRegulator = typeof definition.metadata.onboardRegulator === 'string';
        const supplyVoltage = rails.supply?.voltage ?? 0;
        const threshold = typeof definition.metadata.regulatorInputThresholdV === 'number' ? (definition.metadata.regulatorInputThresholdV as number) : undefined;
        const regulatorActive = hasOnboardRegulator && threshold !== undefined && supplyVoltage >= threshold;

        const logicPins = definition.pins.filter((entry) => entry.type === 'power' && entry.name !== supplyPin);
        for (const logicPin of logicPins) {
          if (regulatorActive && logicPin.name === '5V') {
            state.notes.push(
              `${instance.instanceId} 5V pin is the on-board regulator OUTPUT at this supply voltage — do not feed 5 V into it; leave the jumper in place and use it to power the MCU/logic rail.`,
            );
            continue;
          }
          connectPower(instance.instanceId, logicPin.name, rails.logic, `Logic supply for ${definition.name} (${logicPin.signal ?? logicPin.name}).`);
        }

        connectGround(instance.instanceId, definition, 'Driver and MCU must share ground or the logic thresholds float.');
        continue;
      }

      /*
       * Everything else: pair a power pin with a rail that actually fits it.
       *
       * Choosing the pin and the rail independently is what fed 7.4 V into an
       * Arduino's 5 V pin: the board also has a VIN input rated 7–12 V, and a
       * rail must never be wired back into the part that sources it.
       */
      const powerPinCandidates = definition.pins.filter((entry) => entry.type === 'power');
      const maxCurrent = definition.currentRequirements?.maxMa ?? 0;
      const railOptions = [
        ...(maxCurrent > 500 ? [rails.supply, rails.motorRail, rails.logic] : [rails.logic, rails.motorRail, rails.supply]),
      ].filter((rail): rail is RailSource => rail !== undefined && rail.instanceId !== instance.instanceId);

      const partMax = definition.motorRequirements?.supplyVoltageMax ?? definition.maxVoltage;
      const pinAcceptsRail = (pinVoltage: number | undefined, rail: RailSource, pinMaxVoltage?: number, pinMinVoltage?: number): boolean => {
        // VIN / RAW style input: a wide unregulated window declared by one number.
        if (pinVoltage !== undefined && pinVoltage >= 7 && (partMax === undefined || pinVoltage > partMax)) {
          return rail.voltage >= pinVoltage * 0.7 && rail.voltage <= pinVoltage * 1.3;
        }
        // A pin with its own declared voltage (a board's VIN = 5 V input next
        // to its 3V3 output) is judged by that pin's window, not by the part's
        // overall logic rating — otherwise a 3.3 V board could never be fed 5 V.
        if (pinVoltage !== undefined) {
          const floor = pinMinVoltage ?? pinVoltage - 0.3;
          const ceiling = pinMaxVoltage ?? pinVoltage + 0.6;
          return rail.voltage >= floor - 0.05 && rail.voltage <= ceiling + 0.05;
        }
        // Otherwise the part's own voltage window decides.
        return fitsWindow(definition, rail.voltage);
      };

      let powerPin: string | undefined;
      let powerRail: RailSource | undefined;
      for (const candidate of powerPinCandidates) {
        const rail = railOptions.find((option) => pinAcceptsRail(candidate.voltage, option, candidate.maxVoltage, candidate.minVoltage));
        if (rail) {
          powerPin = candidate.name;
          powerRail = rail;
          break;
        }
      }

      if (powerPin && powerRail) {
        connectPower(
          instance.instanceId,
          powerPin,
          powerRail,
          maxCurrent > 500
            ? `${definition.name} can draw ${maxCurrent} mA, above what the logic rail should supply, so it is fed from the ${powerRail.label}.`
            : `${definition.name} runs from the ${powerRail.label} on its ${powerPin} pin.`,
        );
      } else {
        const fallbackPin =
          definition.pins.find((entry) => entry.type === 'power' && entry.required)?.name ?? definition.powerPins[0];
        const fallbackRail = railOptions[0];
        if (fallbackPin) {
          connectPower(
            instance.instanceId,
            fallbackPin,
            fallbackRail,
            `No rail matches the ${definition.name} voltage window — ${fallbackRail?.label ?? 'the available rail'} is used and the mismatch must be resolved.`,
          );
        } else {
          state.notes.push(`${instance.instanceId} has no power pin in the catalog, so it was left unpowered.`);
        }
      }

      if (definition.groundPins.length > 0) {
        connectGround(instance.instanceId, definition, 'Single common ground reference for logic and power.');
      }
    }
  }

  if (signalOnlyParts.length > 0) {
    state.notes.push(
      `${signalOnlyParts.length} contact-only part${signalOnlyParts.length === 1 ? '' : 's'} (${signalOnlyParts
        .slice(0, 4)
        .join(', ')}${signalOnlyParts.length > 4 ? ', …' : ''}) need no supply rail: ` +
        'each sits between a GPIO and ground (or the signal it switches) and is powered through that path.',
    );
  }

  /* --- 4. Passive network --------------------------------------------------- */
  // Voltage divider for resistive analog sensors (LDR and friends).
  for (const selection of selections) {
    const definition = catalog.find((component) => component.id === selection.componentId);
    if (!definition || definition.metadata.requiresVoltageDivider !== true) continue;

    for (const instance of selection.instances) {
      const terminals = definition.pins.filter((entry) => entry.type === 'analog').map((entry) => entry.name);
      const topTerminal = terminals[0];
      const nodeTerminal = terminals[1] ?? terminals[0];
      if (!topTerminal || !nodeTerminal) continue;

      connectPower(instance.instanceId, topTerminal, rails.logic, 'Top of the voltage divider is fed from the logic rail.');

      const divider = dividerResistorQueue.shift();
      const dividerDefinition = divider ? index.get(divider.instanceId)?.definition : undefined;
      if (divider && dividerDefinition && ground) {
        const pins = dividerDefinition.pins.map((entry) => entry.name);
        addConnection(
          state,
          { componentId: instance.componentId, instanceId: instance.instanceId, pin: nodeTerminal },
          { componentId: divider.componentId, instanceId: divider.instanceId, pin: pins[0] ?? '1' },
          {
            kind: 'signal',
            signal: 'analog',
            protocol: 'adc',
            direction: 'unidirectional',
            voltage: mcuLogicVoltage,
            explanation: `Divider node: ${instance.label ?? definition.name} ${nodeTerminal} joins the ${String(dividerDefinition.metadata.resistanceOhm ?? '')} Ω resistor, forming the analog voltage the MCU samples.`,
            metadata: { role: 'voltage_divider' },
          },
        );
        addConnection(
          state,
          { componentId: divider.componentId, instanceId: divider.instanceId, pin: pins[1] ?? '2' },
          ground,
          {
            kind: 'ground',
            signal: 'ground',
            protocol: 'power',
            direction: 'bidirectional',
            voltage: 0,
            explanation: `Bottom of the divider to ground: with ${instance.label ?? definition.name} in series this creates Vout = Vcc x R_bottom / (R_sensor + R_bottom).`,
            metadata: { role: 'voltage_divider' },
          },
        );
      } else {
        state.notes.push(`${instance.instanceId} needs a divider resistor to ground, but none is in the bill of materials.`);
      }
    }
  }

  // Input devices: one leg to the MCU pin (already wired), the other to ground.
  for (const selection of selections) {
    const definition = catalog.find((component) => component.id === selection.componentId);
    if (!definition || definition.category !== 'input_device') continue;
    for (const instance of selection.instances) {
      const pins = definition.pins.map((entry) => entry.name);
      const usedByAssignment = new Set(
        assignments.filter((assignment) => assignment.targetInstanceId === instance.instanceId).map((assignment) => assignment.targetPin),
      );
      const freePin = pins.find((pin) => !usedByAssignment.has(pin));
      if (freePin && ground && pins.length === 2) {
        addConnection(
          state,
          { componentId: instance.componentId, instanceId: instance.instanceId, pin: freePin },
          ground,
          {
            kind: 'ground',
            signal: 'ground',
            protocol: 'power',
            direction: 'bidirectional',
            voltage: 0,
            explanation: `${definition.name} ${freePin} to ground: the firmware enables the internal pull-up, so a press pulls the input LOW.`,
          },
        );
      }
      if (definition.id === 'potentiometer-10k') {
        connectPower(instance.instanceId, 'A', rails.logic, 'Potentiometer top terminal to the logic rail.');
        connectGround(instance.instanceId, definition, 'Potentiometer bottom terminal to ground completes the divider.');
      }
    }
  }

  /*
   * Which rail do the stall-prone loads sit on? The power budget already made
   * that call voltage-driven (matching the wiring emitted above), so read its
   * rail membership instead of assuming the raw supply: in a battery build the
   * servo is fed from the regulated logic rail, and a capacitor across the pack
   * would sit on the wrong side of the linear regulator for its transients.
   */
  const stallProneIds = new Set<string>();
  for (const selection of selections) {
    const definition = catalog.find((component) => component.id === selection.componentId);
    if (!definition || !['motor', 'motor_driver'].includes(definition.category)) continue;
    for (const instance of selection.instances) stallProneIds.add(instance.instanceId);
  }
  const railNameForLoad = (instanceId: string): 'supply' | 'logic' => {
    for (const rail of power.rails) {
      const member = rail.loads.some((load) => /\(([^)]+)\)\s*$/.exec(load)?.[1] === instanceId);
      if (member) return rail.rail === '3V3' || rail.rail === '5V' ? 'logic' : 'supply';
    }
    return 'supply';
  };
  let logicVotes = 0;
  let supplyVotes = 0;
  for (const instanceId of stallProneIds) {
    if (railNameForLoad(instanceId) === 'logic') logicVotes += 1;
    else supplyVotes += 1;
  }
  const bulkRail: RailSource | undefined = logicVotes > supplyVotes ? rails.logic : rails.supply;
  const stallProneNames = selections
    .filter((selection) => selection.instances.some((instance) => stallProneIds.has(instance.instanceId)))
    .map((selection) => selection.name)
    .join(', ');

  // Bulk capacitance across the rail that carries the stall-prone loads.
  for (const capacitor of passives.bulkCapacitors) {
    const definition = index.get(capacitor.instanceId)?.definition;
    if (!definition || !bulkRail || !ground) continue;
    const pins = definition.pins.map((entry) => entry.name);
    addConnection(
      state,
      { componentId: bulkRail.definition?.id ?? bulkRail.instanceId, instanceId: bulkRail.instanceId, pin: bulkRail.pin },
      { componentId: capacitor.componentId, instanceId: capacitor.instanceId, pin: pins[0] ?? '+' },
      {
        kind: 'power',
        signal: 'power',
        protocol: 'power',
        direction: 'bidirectional',
        voltage: bulkRail.voltage,
        explanation: `Bulk reservoir capacitor across the ${bulkRail.label}${
          stallProneNames ? ` — the rail that feeds ${stallProneNames}` : ''
        }: absorbs motor inrush and stall transients so the rail does not brown out.`,
      },
    );
    addConnection(
      state,
      { componentId: capacitor.componentId, instanceId: capacitor.instanceId, pin: pins[1] ?? '-' },
      ground,
      {
        kind: 'ground',
        signal: 'ground',
        protocol: 'power',
        direction: 'bidirectional',
        voltage: 0,
        explanation: 'Bulk capacitor negative to the common ground. Observe polarity — reverse voltage destroys an electrolytic.',
      },
    );
    break; // one bulk capacitor is enough for the MVP bill of materials
  }

  // Decoupling capacitors for ICs.
  const icInstances = selections
    .filter((selection) => ['sensor', 'communication', 'display', 'motor_driver'].includes(selection.category))
    .flatMap((selection) => selection.instances);
  for (const icInstance of icInstances) {
    const capacitor = decouplingQueue.shift();
    if (!capacitor) break;
    const capacitorDefinition = index.get(capacitor.instanceId)?.definition;
    const icEntry = index.get(icInstance.instanceId);
    if (!capacitorDefinition || !icEntry?.definition || !ground) continue;
    const capPins = capacitorDefinition.pins.map((entry) => entry.name);
    const icPowerPin = icEntry.definition.powerPins[0];
    if (!icPowerPin) continue;

    addConnection(
      state,
      { componentId: icInstance.componentId, instanceId: icInstance.instanceId, pin: icPowerPin },
      { componentId: capacitor.componentId, instanceId: capacitor.instanceId, pin: capPins[0] ?? '1' },
      {
        kind: 'power',
        signal: 'power',
        protocol: 'power',
        direction: 'bidirectional',
        voltage: mcuLogicVoltage,
        explanation: `100 nF decoupling across ${icEntry.definition.name} (${icInstance.instanceId}) supply pin — suppresses high-frequency switching noise on the rail.`,
      },
    );
    addConnection(
      state,
      { componentId: capacitor.componentId, instanceId: capacitor.instanceId, pin: capPins[1] ?? '2' },
      ground,
      {
        kind: 'ground',
        signal: 'ground',
        protocol: 'power',
        direction: 'bidirectional',
        voltage: 0,
        explanation: `Decoupling capacitor for ${icInstance.instanceId} returned to the common ground.`,
      },
    );
  }

  // Flyback diodes across raw inductive loads (only when the driver has no clamps).
  const driverHasClamps = selections.some((selection) => {
    const definition = catalog.find((component) => component.id === selection.componentId);
    return definition?.metadata.internalClampDiodes === true || /l298n|l293d|tb6612/i.test(selection.componentId);
  });
  if (!driverHasClamps) {
    for (const motor of motors) {
      const diode = passives.diodes.shift();
      if (!diode) break;
      const diodeDefinition = index.get(diode.instanceId)?.definition;
      const terminals = motorTerminalsOf(motor.definition);
      if (!diodeDefinition || terminals.length < 2) continue;
      addConnection(
        state,
        { componentId: diode.componentId, instanceId: diode.instanceId, pin: 'K' },
        endpoint(motor.instance, terminals[0] as string),
        {
          kind: 'signal',
          signal: 'unknown',
          protocol: 'other',
          direction: 'unidirectional',
          explanation: `Flyback diode cathode to ${motor.instance.label ?? motor.definition?.name ?? 'motor'} ${terminals[0]}: clamps the back-EMF spike when the drive is switched off.`,
          metadata: { role: 'flyback' },
        },
      );
      addConnection(
        state,
        { componentId: diode.componentId, instanceId: diode.instanceId, pin: 'A' },
        endpoint(motor.instance, terminals[1] as string),
        {
          kind: 'signal',
          signal: 'unknown',
          protocol: 'other',
          direction: 'unidirectional',
          explanation: `Flyback diode anode to ${terminals[1]} completing the clamp path across the motor.`,
          metadata: { role: 'flyback' },
        },
      );
    }
  }

  /* --- 5. Merge model-suggested connections -------------------------------- */
  const mergedFromModel = mergeModelWiring(state, index, input.modelWiring);
  if (mergedFromModel > 0) state.notes.push(`${mergedFromModel} additional connection(s) suggested by the model were merged after validation.`);

  /* --- 6. Nets -------------------------------------------------------------- */
  const nets = computeNets(state.connections, index);

  /* --- 7. Conflict detection ------------------------------------------------ */
  const conflicts = detectConflicts({
    connections: state.connections,
    assignments,
    selections,
    catalog,
    power,
    ...(profile ? { profile } : {}),
    ...(controllerInstanceId ? { controllerInstanceId } : {}),
  });

  const stats = {
    power: state.connections.filter((connection) => connection.kind === 'power').length,
    ground: state.connections.filter((connection) => connection.kind === 'ground').length,
    signal: state.connections.filter((connection) => connection.kind === 'signal').length,
  };

  handle?.complete(
    `Wiring complete — ${state.connections.length} connection(s): ${stats.signal} signal, ${stats.power} power, ${stats.ground} ground${conflicts.length > 0 ? `, ${conflicts.length} conflict(s) detected` : ''}`,
    {
      connections: state.connections.length,
      ...stats,
      nets: nets.length,
      conflicts: conflicts.length,
      errors: conflicts.filter((conflict) => conflict.severity === 'error').length,
    },
  );

  return {
    connections: state.connections,
    conflicts,
    nets,
    notes: [...new Set(state.notes)],
    generatedAt: nowIso(),
  };
}

function fitsWindow(definition: ComponentDefinition, voltage: number): boolean {
  const motor = definition.motorRequirements;
  const min = motor?.supplyVoltageMin ?? definition.minVoltage;
  const max = motor?.supplyVoltageMax ?? definition.maxVoltage;
  if (min !== undefined && voltage < min) return false;
  if (max !== undefined && voltage > max) return false;
  return true;
}

/* ------------------------------------------------------------------------- */
/* Model wiring merge                                                         */
/* ------------------------------------------------------------------------- */

function mergeModelWiring(state: BuilderState, index: Map<string, InstanceIndexEntry>, raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  let merged = 0;

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;

    const resolve = (componentKey: string, indexKey: string, pinKey: string): WiringEndpoint | null => {
      const componentId = String(record[componentKey] ?? '').trim();
      const pin = String(record[pinKey] ?? '').trim();
      if (!componentId || !pin) return null;
      const rawIndex = record[indexKey];
      const instanceIndex = typeof rawIndex === 'number' ? rawIndex : Number.parseInt(String(rawIndex ?? '1'), 10) || 1;
      const instanceId = `${componentId}-${instanceIndex}`;
      const found = index.get(instanceId);
      if (!found) return null;
      const resolvedPin = resolvePinName(found.definition, pin) ?? pin;
      return { componentId: found.componentId, instanceId: found.instanceId, pin: resolvedPin };
    };

    const from = resolve('fromComponentId', 'fromInstanceIndex', 'fromPin');
    const to = resolve('toComponentId', 'toInstanceIndex', 'toPin');
    if (!from || !to) continue;
    if (from.instanceId === to.instanceId && from.pin === to.pin) continue;

    const kindRaw = String(record.kind ?? '').toLowerCase();
    const kind: WiringConnection['kind'] = kindRaw === 'power' || kindRaw === 'ground' ? (kindRaw as 'power' | 'ground') : 'signal';

    // A model can describe the same resistor terminal twice while trying to
    // "route" a series circuit. Keep the first valid edge and reject a second
    // signal net on a passive terminal; otherwise the invalid graph would make
    // it all the way into diagram.json as a short between MCU outputs.
    if (kind === 'signal') {
      const passiveTerminalOverconnected = (endpoint: WiringEndpoint, opposite: WiringEndpoint): boolean => {
        if (index.get(endpoint.instanceId)?.definition?.category !== 'passive') return false;
        return state.connections.some((existing) => {
          if (existing.kind !== 'signal') return false;
          const touches =
            existing.from.instanceId === endpoint.instanceId && existing.from.pin === endpoint.pin
              ? existing.to
              : existing.to.instanceId === endpoint.instanceId && existing.to.pin === endpoint.pin
                ? existing.from
                : null;
          return Boolean(touches && (touches.instanceId !== opposite.instanceId || touches.pin !== opposite.pin));
        });
      };
      if (passiveTerminalOverconnected(from, to) || passiveTerminalOverconnected(to, from)) {
        state.notes.push(`Rejected a model wire to an already-used passive terminal (${from.instanceId}.${from.pin} ↔ ${to.instanceId}.${to.pin}) to avoid a duplicate/shorted net.`);
        continue;
      }
    }

    const signalRaw = String(record.signal ?? '').toLowerCase();
    const signal: SignalType = (
      ['digital', 'analog', 'pwm', 'uart', 'i2c', 'spi', 'one_wire', 'motor_drive', 'enable', 'interrupt', 'power', 'ground'].includes(signalRaw)
        ? signalRaw
        : kind === 'power'
          ? 'power'
          : kind === 'ground'
            ? 'ground'
            : 'digital'
    ) as SignalType;

    const connection = addConnection(state, from, to, {
      kind,
      signal,
      protocol: kind === 'signal' ? 'gpio' : 'power',
      direction: 'bidirectional',
      explanation: String(record.explanation ?? `Model-proposed connection between ${from.instanceId}.${from.pin} and ${to.instanceId}.${to.pin}.`).trim(),
      source: 'model',
      ...(kind === 'power' && typeof record.voltage === 'number' ? { voltage: record.voltage } : {}),
      metadata: { origin: 'model' },
    });
    if (connection) merged += 1;
  }

  return merged;
}

/* ------------------------------------------------------------------------- */
/* Net computation (union-find over power + ground connections)                */
/* ------------------------------------------------------------------------- */

function computeNets(connections: WiringConnection[], index: Map<string, InstanceIndexEntry>): WiringNet[] {
  const parent = new Map<string, string>();

  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root) as string;
    let cursor = key;
    while (cursor !== root) {
      const next = parent.get(cursor) as string;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  const nodeKey = (instanceId: string, pin: string) => `${instanceId}.${pin}`;

  for (const connection of connections) {
    if (connection.kind !== 'power' && connection.kind !== 'ground') continue;
    const a = nodeKey(connection.from.instanceId, connection.from.pin);
    const b = nodeKey(connection.to.instanceId, connection.to.pin);
    if (parent.get(a) === undefined) parent.set(a, a);
    if (parent.get(b) === undefined) parent.set(b, b);
    union(a, b);
  }

  const groups = new Map<string, WiringNet['members']>();
  for (const key of parent.keys()) {
    const root = find(key);
    const list = groups.get(root) ?? [];
    const [instanceId, ...pinParts] = key.split('.');
    list.push({ instanceId: instanceId as string, pin: pinParts.join('.') });
    groups.set(root, list);
  }

  const nets: WiringNet[] = [];
  let netIndex = 0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    netIndex += 1;

    const voltages = members
      .map((member) => {
        const entry = index.get(member.instanceId);
        const pin = entry?.definition?.pins.find((candidate) => candidate.name === member.pin);
        return pin?.voltage;
      })
      .filter((value): value is number => typeof value === 'number');

    const isGround = members.some((member) => {
      const entry = index.get(member.instanceId);
      return entry?.definition?.groundPins.includes(member.pin) === true;
    });

    const voltage = voltages.length > 0 ? Math.max(...voltages) : undefined;
    const name = isGround && (voltage === undefined || voltage === 0) ? 'GND' : voltage !== undefined ? `${voltage}V` : `NET${netIndex}`;

    nets.push({
      id: `net_${netIndex}`,
      name,
      kind: isGround && (voltage === undefined || voltage === 0) ? 'ground' : 'power',
      signal: isGround && (voltage === undefined || voltage === 0) ? 'ground' : 'power',
      ...(voltage !== undefined ? { voltage } : {}),
      members,
    });
  }

  return nets.sort((a, b) => b.members.length - a.members.length);
}

/* ------------------------------------------------------------------------- */
/* Incremental extension                                                      */
/*                                                                            */
/* Used by the fixer: wires up newly added/replaced component instances       */
/* without touching the connections that already exist. Existing edges keep    */
/* their ids, colours and explanations, so a fix produces a real patch rather  */
/* than a regenerated graph.                                                  */
/* ------------------------------------------------------------------------- */

export interface ExtendWiringInput {
  /** The wiring plan currently stored on the project. */
  existing: WiringPlan;
  /** All selections after the patch (needed to resolve rails and instances). */
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  /** All pin assignments after the patch. */
  assignments: PinAssignment[];
  /** Instances that need new wiring. */
  targetInstanceIds: string[];
  power: PowerBudget;
  controllerInstanceId?: string;
  profile?: McuProfile;
  events?: AgentEventLog;
}

export function extendWiringPlan(input: ExtendWiringInput): WiringPlan {
  const { existing, selections, catalog, assignments, power, profile, events } = input;
  const targets = input.targetInstanceIds.filter((instanceId) => instanceId.trim().length > 0);

  const handle = events?.start('wiring_started', `Extending the wiring graph for ${targets.length} component instance(s)...`, {
    stage: 'fixing',
    metadata: { instances: targets.length },
  });

  const state: BuilderState = {
    connections: [...existing.connections],
    keys: new Set(existing.connections.map((connection) => keyFor(connection.from, connection.to))),
    notes: [...existing.notes],
    colorIndex: existing.connections.filter((connection) => connection.kind === 'signal').length,
  };

  const index = indexInstances(selections, catalog);
  const targetSet = new Set(targets);
  const added: string[] = [];
  const track = (connection: WiringConnection | null): void => {
    if (connection) added.push(connection.id);
  };

  const controllerInstanceId =
    input.controllerInstanceId ?? selections.find((selection) => selection.role === 'controller')?.instances[0]?.instanceId;
  const controllerEntry = controllerInstanceId ? index.get(controllerInstanceId) : undefined;
  const rails = resolveRails(index, selections, catalog, power, controllerInstanceId);
  const mcuLogicVoltage = rails.logic?.voltage ?? controllerEntry?.definition?.voltage ?? 5;
  const ground: WiringEndpoint | null = controllerInstanceId
    ? { componentId: controllerEntry?.componentId ?? '', instanceId: controllerInstanceId, pin: rails.ground.pin }
    : null;

  /* 1. Signal wires for the new pin assignments ------------------------------ */
  for (const assignment of assignments) {
    if (!targetSet.has(assignment.targetInstanceId)) continue;
    const mcuEntry = index.get(assignment.mcuInstanceId);
    const targetEntry = index.get(assignment.targetInstanceId);
    if (!mcuEntry || !targetEntry) {
      state.notes.push(`Fixer: assignment ${assignment.id} references an unknown instance and was not wired.`);
      continue;
    }
    const targetPin = resolvePinName(targetEntry.definition, assignment.targetPin) ?? assignment.targetPin;
    track(
      addConnection(
        state,
        { componentId: mcuEntry.componentId, instanceId: mcuEntry.instanceId, pin: assignment.pin },
        { componentId: targetEntry.componentId, instanceId: targetEntry.instanceId, pin: targetPin },
        {
          kind: 'signal',
          signal: assignment.signal,
          protocol: assignment.protocol,
          voltage: mcuLogicVoltage,
          direction: 'unidirectional',
          source: 'fixer',
          explanation: `${mcuEntry.definition?.name ?? mcuEntry.componentId} ${assignment.pin} ${assignment.direction === 'output' ? '→' : '←'} ${targetEntry.instance.label ?? targetEntry.definition?.name ?? ''} ${targetPin}: ${assignment.purpose} (added by fixer).`,
          metadata: { role: 'fixer_patch', assignmentId: assignment.id },
        },
      ),
    );
  }

  /* 2. Power and ground for the new instances -------------------------------- */
  for (const instanceId of targets) {
    const entry = index.get(instanceId);
    const definition = entry?.definition;
    if (!entry || !definition) continue;
    if (definition.metadata.electrical === false || definition.metadata.integrated === true) continue;
    if (definition.metadata.participatesInWiring === false) continue;

    if (ground) {
      const groundPin = negativePinOf(definition) ?? definition.groundPins[0];
      if (groundPin) {
        track(
          addConnection(
            state,
            { componentId: entry.componentId, instanceId, pin: groundPin },
            ground,
            {
              kind: 'ground',
              signal: 'ground',
              protocol: 'power',
              direction: 'bidirectional',
              voltage: 0,
              source: 'fixer',
              explanation: `Common ground: ${entry.instance.label ?? definition.name} ${groundPin} to ${controllerEntry?.definition?.name ?? 'MCU'} ${ground.pin} (added by fixer).`,
              metadata: { role: 'fixer_patch' },
            },
          ),
        );
      } else {
        state.notes.push(`Fixer: ${instanceId} has no ground pin in the catalog, so no ground wire was added.`);
      }
    }

    /* Motors are fed by their driver, supplies anchor the rails themselves. */
    const isSupply = definition.category === 'power' && definition.powerSourceRequirements?.outputVoltage !== undefined;
    const isMotor = definition.category === 'motor' && definition.motorRequirements?.motorType !== 'servo';
    if (isSupply || isMotor) continue;

    const supplyPin = positivePinOf(definition) ?? definition.powerPins[0];
    if (!supplyPin) continue;
    const wantsMotorRail = definition.motorRequirements?.requiresExternalSupply === true;
    const rail = (wantsMotorRail ? rails.motorRail ?? rails.supply : rails.logic ?? rails.supply) ?? rails.supply;
    if (!rail) {
      state.notes.push(`Fixer: no suitable supply rail was resolved for ${instanceId} ${supplyPin}.`);
      continue;
    }
    track(
      addConnection(
        state,
        { componentId: rail.instanceId, instanceId: rail.instanceId, pin: rail.pin },
        { componentId: entry.componentId, instanceId, pin: supplyPin },
        {
          kind: 'power',
          signal: 'power',
          protocol: 'power',
          direction: 'unidirectional',
          voltage: rail.voltage,
          source: 'fixer',
          explanation: `${rail.label} (${rail.instanceId}.${rail.pin}) → ${entry.instance.label ?? definition.name} ${supplyPin} (added by fixer).`,
          metadata: { role: 'fixer_patch' },
        },
      ),
    );
  }

  /* 3. Recompute derived data over the merged graph -------------------------- */
  const nets = computeNets(state.connections, index);
  const conflicts = detectConflicts({
    connections: state.connections,
    assignments,
    selections,
    catalog,
    power,
    ...(profile ? { profile } : {}),
    ...(controllerInstanceId ? { controllerInstanceId } : {}),
  });

  const stats = {
    power: state.connections.filter((connection) => connection.kind === 'power').length,
    ground: state.connections.filter((connection) => connection.kind === 'ground').length,
    signal: state.connections.filter((connection) => connection.kind === 'signal').length,
  };

  handle?.complete(
    `Wiring patched — ${added.length} connection(s) added, ${state.connections.length} total.`,
    { added: added.length, connections: state.connections.length, ...stats, nets: nets.length, conflicts: conflicts.length },
  );

  return {
    connections: state.connections,
    conflicts,
    nets,
    notes: [...new Set(state.notes)],
    generatedAt: nowIso(),
  };
}
