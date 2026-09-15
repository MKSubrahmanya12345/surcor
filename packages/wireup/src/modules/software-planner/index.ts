/**
 * Software planner.
 *
 * Decides the firmware architecture: modules, libraries, control states,
 * input/sensor/actuator logic, the communication command set, safety behaviour
 * and the loop strategy. It merges the model's proposal with facts derived from
 * the hardware plan and pin plan (which serial port exists, which bus is used,
 * which motors are on which driver channels).
 */

import { z } from 'zod';

import type { ComponentDefinition, ComponentSelection, LibraryRequirement } from '@/types/component';
import type { CommandSpec, ControlState, ProjectRequirements, SoftwareModule, SoftwarePlan } from '@/types/project';
import type { PinAssignment } from '@/types/wiring';
import type { AgentEventLog } from '@/lib/logging/events';
import type { I2CBus, SerialLink } from '@/modules/pin-planner';

const StringArray = z.array(z.string()).transform((values) => values.map((value) => String(value).trim()).filter(Boolean)).catch([]);

const SoftwarePlanRawSchema = z
  .object({
    architecture: z.string().optional().catch(undefined),
    language: z.string().optional().catch(undefined),
    framework: z.string().optional().catch(undefined),
    modules: z
      .array(
        z
          .object({
            id: z.string().optional().catch(undefined),
            name: z.string().optional().catch(undefined),
            responsibility: z.string().optional().catch(undefined),
            dependsOn: z.array(z.string()).optional().catch(undefined),
          })
          .passthrough(),
      )
      .optional()
      .catch(undefined),
    libraries: z
      .array(
        z
          .object({
            name: z.string().optional().catch(undefined),
            import: z.string().optional().catch(undefined),
            purpose: z.string().optional().catch(undefined),
            manager: z.string().optional().catch(undefined),
            version: z.string().optional().catch(undefined),
            repository: z.string().optional().catch(undefined),
            builtIn: z.boolean().optional().catch(undefined),
          })
          .passthrough(),
      )
      .optional()
      .catch(undefined),
    controlStates: z
      .array(
        z
          .object({
            id: z.string().optional().catch(undefined),
            name: z.string().optional().catch(undefined),
            description: z.string().optional().catch(undefined),
            transitions: z
              .array(z.object({ to: z.string().optional(), when: z.string().optional() }).passthrough())
              .optional()
              .catch(undefined),
          })
          .passthrough(),
      )
      .optional()
      .catch(undefined),
    inputHandling: StringArray.optional(),
    sensorLogic: StringArray.optional(),
    actuatorLogic: StringArray.optional(),
    communication: z
      .object({
        protocol: z.string().optional().catch(undefined),
        transport: z.string().optional().catch(undefined),
        details: z.string().optional().catch(undefined),
        commandSet: z
          .array(z.object({ command: z.string().optional(), meaning: z.string().optional(), response: z.string().optional() }).passthrough())
          .optional()
          .catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
    safety: StringArray.optional(),
    loopStrategy: z.string().optional().catch(undefined),
    files: z.array(z.object({ path: z.string().optional(), purpose: z.string().optional() }).passthrough()).optional().catch(undefined),
  })
  .passthrough();

export interface SoftwarePlannerInput {
  requirements: ProjectRequirements;
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  assignments: PinAssignment[];
  serialLinks: SerialLink[];
  i2cBuses: I2CBus[];
  controllerInstanceId?: string;
  controllerComponentId?: string;
  modelSoftwarePlan?: unknown;
  events?: AgentEventLog;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Derive control states from the requested behaviours (or from the hardware). */
export function deriveControlStates(requirements: ProjectRequirements, selections: ComponentSelection[]): ControlState[] {
  const text = [
    requirements.goal,
    ...requirements.behaviors,
    ...requirements.requirements,
    ...requirements.outputs,
  ]
    .join(' ')
    .toLowerCase();

  const hasMotors = selections.some(
    (selection) => selection.category === 'motor' && !/servo/i.test(selection.componentId),
  );
  const hasRemote = requirements.communicationRequirements.length > 0 || /bluetooth|phone|remote|app/.test(text);
  const states: ControlState[] = [];

  const push = (id: string, name: string, description: string, transitions: { to: string; when: string }[]) => {
    states.push({ id, name, description, transitions });
  };

  push('init', 'Initialise', 'Configure pins, buses and peripherals, then enter a safe idle state.', [
    { to: hasMotors ? 'idle' : 'running', when: 'peripherals report ready' },
    { to: 'fault', when: 'a required peripheral does not initialise' },
  ]);

  if (hasMotors) {
    const directions: { id: string; name: string; command: string }[] = [];
    if (/forward|\bF\b|ahead/.test(text)) directions.push({ id: 'forward', name: 'Forward', command: 'F' });
    if (/backward|reverse|\bB\b/.test(text)) directions.push({ id: 'reverse', name: 'Reverse', command: 'B' });
    if (/left|steer/.test(text)) directions.push({ id: 'left', name: 'Turn left', command: 'L' });
    if (/right|steer/.test(text)) directions.push({ id: 'right', name: 'Turn right', command: 'R' });
    if (directions.length === 0) {
      directions.push(
        { id: 'forward', name: 'Forward', command: 'F' },
        { id: 'reverse', name: 'Reverse', command: 'B' },
        { id: 'left', name: 'Turn left', command: 'L' },
        { id: 'right', name: 'Turn right', command: 'R' },
      );
    }

    push('idle', 'Idle / stopped', 'All motor outputs low (coast) or braked; waiting for a command.', [
      ...directions.map((direction) => ({ to: direction.id, when: `command "${direction.command}" received` })),
      { to: 'failsafe', when: 'no command received within the failsafe window' },
    ]);

    for (const direction of directions) {
      push(direction.id, direction.name, `Drive outputs set for ${direction.name.toLowerCase()}.`, [
        { to: 'idle', when: 'command "S" (stop) received' },
        ...directions.filter((other) => other.id !== direction.id).map((other) => ({ to: other.id, when: `command "${other.command}" received` })),
        { to: 'failsafe', when: 'command timeout expires' },
      ]);
    }

    push('failsafe', 'Failsafe', 'Link lost: motors stopped immediately and stay stopped until a fresh command arrives.', [
      { to: 'idle', when: 'a valid command is received again' },
    ]);
  } else {
    push('running', 'Running', 'Periodic sampling of inputs and update of outputs.', [
      { to: 'alert', when: 'a monitored threshold is crossed' },
      { to: 'fault', when: 'a sensor read fails repeatedly' },
    ]);
    push('alert', 'Alert', 'Outputs indicating an alert condition (LED, buzzer, message).', [
      { to: 'running', when: 'the measured value returns inside the threshold' },
    ]);
  }

  push('fault', 'Fault', 'Unrecoverable error: outputs disabled and the fault reported over the available link.', [
    { to: 'init', when: 'the controller is reset' },
  ]);

  void hasRemote;
  return states;
}

/** Command set for a remote-controlled build. */
export function deriveCommandSet(states: ControlState[], requirements: ProjectRequirements): CommandSpec[] {
  const hasRemote =
    requirements.communicationRequirements.length > 0 || /bluetooth|phone|remote|app|wifi/i.test(requirements.goal);
  if (!hasRemote) return [];

  const commands: CommandSpec[] = [];
  const seen = new Set<string>();

  for (const state of states) {
    if (['init', 'fault'].includes(state.id)) continue;
    const candidate = state.id === 'idle' ? 'S' : state.id === 'reverse' ? 'B' : state.id.charAt(0).toUpperCase();
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    commands.push({ command: candidate, meaning: state.name, response: `ok:${state.id}` });
  }

  if (!seen.has('S')) commands.push({ command: 'S', meaning: 'Stop / idle', response: 'ok:idle' });
  commands.push({ command: '?', meaning: 'Report status and sensor telemetry', response: 'status:<json>' });

  return commands;
}

/** Resolve the authoritative library list from the catalog. */
/**
 * Does this build need non-volatile storage?
 *
 * Anything that authorises access (a keypad or a set of switches plus a lock)
 * has a credential that must survive a power cycle; so does any brief that asks
 * to "store", "remember" or "persist" a setting. Without EEPROM.h in the plan
 * the firmware cannot keep the PIN and the include block would strip it.
 */
export function needsPersistentStorage(
  selections: ComponentSelection[],
  catalog: ComponentDefinition[],
  requirements: { goal: string; behaviors: string[]; requirements: string[] },
): boolean {
  const text = `${requirements.goal} ${requirements.behaviors.join(' ')} ${requirements.requirements.join(' ')}`.toLowerCase();
  if (/\b(store|persist|remember|survive|non-?volatile|save)\b/.test(text) && /\b(pin|password|code|setting|calibrat)\w*\b/.test(text)) {
    return true;
  }

  const hasLock = selections.some((selection) => /servo/i.test(selection.componentId) || /relay/i.test(selection.componentId));
  const hasKeyInput = selections.some((selection) => {
    const definition = catalog.find((component) => component.id === selection.componentId);
    if (definition?.metadata.keypadMatrix !== undefined) return true;
    return selection.category === 'input_device' && /button|switch|key/i.test(selection.componentId);
  });
  const credential = /\b(pin|password|passcode|code|access|safe|lock)\b/.test(text);
  return hasLock && hasKeyInput && credential;
}

export function resolveLibraries(
  selections: ComponentSelection[],
  catalog: ComponentDefinition[],
  extra: LibraryRequirement[] = [],
  context: { i2c: boolean; softwareSerial: boolean; bluetoothSerial: boolean; platform: string; persistentStorage?: boolean },
): LibraryRequirement[] {
  const libraries = new Map<string, LibraryRequirement>();

  const add = (library: LibraryRequirement) => {
    const key = `${library.name.toLowerCase()}|${library.import.toLowerCase()}`;
    const existing = libraries.get(key);
    if (existing) {
      libraries.set(key, { ...existing, purpose: existing.purpose || library.purpose, builtIn: existing.builtIn || library.builtIn });
      return;
    }
    libraries.set(key, { ...library });
  };

  for (const selection of selections) {
    const definition = catalog.find((component) => component.id === selection.componentId);
    for (const library of definition?.libraryRequirements ?? []) add(library);
  }

  if (context.i2c) add({ name: 'Wire', import: 'Wire.h', manager: 'arduino', purpose: 'Hardware I2C bus used by the shared sensor/display bus', builtIn: true });
  if (context.softwareSerial)
    add({ name: 'SoftwareSerial', import: 'SoftwareSerial.h', manager: 'arduino', purpose: 'Emulated UART for the Bluetooth module on AVR boards', builtIn: true });
  if (context.bluetoothSerial)
    add({ name: 'BluetoothSerial', import: 'BluetoothSerial.h', manager: 'arduino', purpose: 'Bluetooth Classic SPP link on the ESP32 integrated radio', builtIn: true });
  if (context.persistentStorage)
    add({
      name: 'EEPROM',
      import: 'EEPROM.h',
      manager: 'arduino',
      purpose: 'Non-volatile storage so a stored PIN/setting survives a reset (flash-emulated on ESP32)',
      builtIn: true,
    });

  for (const library of extra) {
    if (!library.name || !library.import) continue;
    add({ ...library, purpose: library.purpose || 'Requested by the generation model' });
  }

  return [...libraries.values()];
}

export function planSoftware(input: SoftwarePlannerInput): SoftwarePlan {
  const { requirements, selections, catalog, assignments, serialLinks, i2cBuses, events } = input;
  const handle = events?.start('software_plan_started', 'Planning firmware architecture...', { stage: 'software' });

  const parsed = SoftwarePlanRawSchema.safeParse(input.modelSoftwarePlan ?? {});
  const model = parsed.success ? parsed.data : {};

  const controller = selections.find((selection) => selection.role === 'controller');
  const controllerDefinition = controller ? catalog.find((component) => component.id === controller.componentId) : undefined;
  const platform = controllerDefinition?.name ?? controller?.name ?? 'microcontroller';

  const integratedRadio = selections.some((selection) => {
    const definition = catalog.find((component) => component.id === selection.componentId);
    return definition?.metadata.integrated === true;
  });
  const wantsBluetooth = requirements.communicationRequirements.some((entry) => /bluetooth/i.test(entry)) || integratedRadio;

  const controlStates = (model.controlStates && model.controlStates.length > 0
    ? model.controlStates.map((state, stateIndex) => ({
        id: state.id ?? slug(state.name ?? `state_${stateIndex + 1}`),
        name: state.name ?? `State ${stateIndex + 1}`,
        description: state.description ?? '',
        transitions: (state.transitions ?? []).map((transition) => ({
          to: String(transition.to ?? ''),
          when: String(transition.when ?? ''),
        })),
      }))
    : deriveControlStates(requirements, selections)
  ).filter((state) => state.id.length > 0);

  const libraries = resolveLibraries(selections, catalog, (model.libraries ?? []) as LibraryRequirement[], {
    i2c: i2cBuses.length > 0,
    softwareSerial: serialLinks.some((link) => link.kind === 'software'),
    bluetoothSerial: wantsBluetooth && integratedRadio,
    platform,
    persistentStorage: needsPersistentStorage(selections, catalog, requirements),
  });

  const transport = (() => {
    if (integratedRadio && wantsBluetooth) return 'BluetoothSerial (ESP32 integrated Bluetooth Classic radio)';
    if (integratedRadio) return 'Wi-Fi (ESP32 integrated radio)';
    const link = serialLinks[0];
    if (!link) return model.communication?.transport ?? 'none';
    return link.kind === 'hardware'
      ? `${link.id} hardware UART on ${link.mcuTxPin} (TX) / ${link.mcuRxPin} (RX)`
      : `${link.id} on ${link.mcuTxPin} (TX) / ${link.mcuRxPin} (RX)`;
  })();

  const protocol = (() => {
    if (wantsBluetooth) return 'Bluetooth Classic SPP (serial profile)';
    if (/wi-?fi|http|mqtt/i.test(requirements.communicationRequirements.join(' '))) return 'Wi-Fi TCP/HTTP';
    return model.communication?.protocol ?? 'UART serial';
  })();

  const commandSet =
    model.communication?.commandSet && model.communication.commandSet.length > 0
      ? model.communication.commandSet.map((entry) => ({
          command: String(entry.command ?? ''),
          meaning: String(entry.meaning ?? ''),
          ...(entry.response ? { response: String(entry.response) } : {}),
        }))
      : deriveCommandSet(controlStates, requirements);

  const modules: SoftwareModule[] = [];
  const pushModule = (id: string, name: string, responsibility: string, dependsOn: string[] = []) => {
    if (modules.some((module) => module.id === id)) return;
    modules.push({ id, name, responsibility, dependsOn });
  };

  pushModule('pin_map', 'Pin map & hardware abstraction', `Static pin constants for all ${assignments.length} assignment(s) plus helper accessors so no magic numbers appear in the logic.`, []);

  if (serialLinks.length > 0 || integratedRadio) {
    pushModule('link', 'Communication link', `Owns ${transport}: initialisation, buffering and a non-blocking read of incoming bytes.`, ['pin_map']);
    pushModule('command_parser', 'Command parser', 'Turns raw bytes/lines into validated commands, ignores garbage and acknowledges accepted ones.', ['link']);
  }

  const sensorSelections = selections.filter((selection) => selection.role === 'sensor' || selection.category === 'input_device');
  if (sensorSelections.length > 0) {
    pushModule(
      'input_layer',
      'Input & sensor layer',
      `Reads ${sensorSelections.map((selection) => selection.name).join(', ')} with rate limiting, filtering and failure handling.`,
      ['pin_map'],
    );
  }

  const motorSelections = selections.filter((selection) => selection.category === 'motor');
  const driverSelections = selections.filter((selection) => selection.category === 'motor_driver');
  if (motorSelections.length > 0) {
    pushModule(
      'motion_control',
      'Motion controller',
      `Translates high-level movement states into ${driverSelections.length > 0 ? driverSelections.map((selection) => selection.name).join(', ') : 'drive'} channel signals (direction bits + PWM speed).`,
      ['pin_map', 'command_parser'],
    );
    pushModule('failsafe', 'Failsafe / watchdog', 'Stops all motion when no command arrives within the timeout window, and keeps outputs safe at boot.', ['motion_control']);
  }

  const actuatorSelections = selections.filter((selection) => selection.category === 'actuator' || selection.category === 'display');
  if (actuatorSelections.length > 0) {
    pushModule(
      'output_layer',
      'Output & indication layer',
      `Drives ${actuatorSelections.map((selection) => selection.name).join(', ')} for status feedback.`,
      ['pin_map'],
    );
  }

  pushModule(
    'scheduler',
    'Non-blocking scheduler',
    'Millis-based task scheduler so no delay() blocks the control loop.',
    modules.map((module) => module.id),
  );

  const modelModules = (model.modules ?? []).map((module, moduleIndex) => ({
    id: module.id ?? slug(module.name ?? `module_${moduleIndex + 1}`),
    name: module.name ?? `Module ${moduleIndex + 1}`,
    responsibility: module.responsibility ?? '',
    dependsOn: module.dependsOn ?? [],
  }));
  for (const module of modelModules) {
    if (!modules.some((existing) => existing.id === module.id)) modules.push(module);
  }

  const inputHandling = (model.inputHandling ?? []).length > 0 ? (model.inputHandling as string[]) : [];
  if (inputHandling.length === 0) {
    for (const selection of selections.filter((entry) => entry.category === 'input_device')) {
      inputHandling.push(
        `${selection.name}: read with the internal pull-up enabled and debounce for 20 ms before accepting a state change.`,
      );
    }
    if (commandSet.length > 0) {
      inputHandling.push(
        `Remote commands are read non-blocking from ${transport}; a ${commandSet.length}-entry command table maps single characters to states, and unrecognised bytes are discarded with a diagnostic reply.`,
      );
    }
  }

  const sensorLogic = (model.sensorLogic ?? []).length > 0 ? (model.sensorLogic as string[]) : [];
  if (sensorLogic.length === 0) {
    for (const selection of selections.filter((entry) => entry.role === 'sensor')) {
      const definition = catalog.find((component) => component.id === selection.componentId);
      const rate = definition?.metadata.sampleRateHz;
      sensorLogic.push(
        `${selection.name}: sample${typeof rate === 'number' ? ` no faster than ${rate} Hz` : ' at a fixed interval'}, keep a rolling average of 4 samples, and report a fault after 3 consecutive read failures.`,
      );
    }
  }

  const actuatorLogic = (model.actuatorLogic ?? []).length > 0 ? (model.actuatorLogic as string[]) : [];
  if (actuatorLogic.length === 0 && motorSelections.length > 0) {
    for (const driver of driverSelections) {
      const definition = catalog.find((component) => component.id === driver.componentId);
      const channelMap = Array.isArray(definition?.metadata.channelMap) ? (definition?.metadata.channelMap as Record<string, unknown>[]) : [];
      actuatorLogic.push(
        `${driver.name}: each channel takes two direction bits${channelMap.length > 0 ? ` (${channelMap.map((channel) => `channel ${String(channel.channel)} = ${String(channel.inputs ?? '')}`).join(', ')})` : ''} plus a PWM enable for speed; both inputs low = coast, both high = brake.`,
      );
    }
    actuatorLogic.push('Ramp PWM duty over ~150 ms instead of stepping it, to limit inrush current and mechanical shock.');
  }

  const safety = (model.safety ?? []).length > 0 ? (model.safety as string[]) : [];
  if (motorSelections.length > 0) {
    safety.push('Drive outputs are set to the stopped state before anything else in setup(), so the motors never lurch on reset.');
    if (commandSet.length > 0) safety.push('Failsafe: if no command arrives within 500 ms, all motion stops automatically.');
  }
  safety.push('Sensor read failures are counted and reported instead of silently returning stale values.');
  if (i2cBuses.length > 0) safety.push('I2C bus is scanned at start-up; a missing device is logged rather than hanging the loop.');

  const architecture =
    model.architecture?.trim() ||
    `Layered firmware on ${platform}: a pin/hardware abstraction layer, an input layer (sensors and ${
      transport === 'none' ? 'local controls' : transport
    }), a command parser, a state machine with ${controlStates.length} state(s), an output layer for the drive stage, and a millis-based non-blocking scheduler that ties them together.`;

  const files =
    model.files && model.files.length > 0
      ? model.files.map((file) => ({ path: String(file.path ?? 'sketch.ino'), purpose: String(file.purpose ?? 'Firmware source') }))
      : [{ path: 'sketch.ino', purpose: 'Complete firmware: pin map, drivers, command handling, control states and failsafe.' }];
  if (!files.some((file) => /sketch\.ino$/i.test(file.path))) {
    files.unshift({ path: 'sketch.ino', purpose: 'Arduino entry point (setup/loop).' });
  }

  const plan: SoftwarePlan = {
    architecture,
    language: 'arduino-cpp',
    framework: model.framework?.trim() || 'Arduino',
    modules,
    libraries,
    controlStates,
    inputHandling,
    sensorLogic,
    actuatorLogic,
    communication:
      transport === 'none'
        ? null
        : {
            protocol,
            transport,
            details:
              model.communication?.details?.trim() ||
              `9600–115200 baud single-character command protocol with acknowledgement. ${
                integratedRadio ? 'No external module or level shifting required.' : 'TX and RX are cross-connected between the MCU and the module.'
              }`,
            commandSet,
          },
    safety,
    loopStrategy:
      model.loopStrategy?.trim() ||
      'Non-blocking loop(): each subsystem has its own millis() deadline (link poll every loop, sensors 50–500 ms, telemetry 1 s, failsafe check every loop). No delay() calls in the control path.',
    files,
  };

  handle?.complete(
    `Firmware architecture planned — ${modules.length} module(s), ${libraries.length} librar${libraries.length === 1 ? 'y' : 'ies'}, ${controlStates.length} control state(s)`,
    { modules: modules.length, libraries: libraries.length, states: controlStates.length, transport },
  );

  return plan;
}
