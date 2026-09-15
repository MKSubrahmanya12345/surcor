/**
 * Electrical contracts.
 *
 * The catalog can never be complete — there are hundreds of thousands of
 * orderable parts and roughly sixty *ways a part behaves electrically*. A
 * contract describes one of those ways: the pins it must expose, the drive
 * stage it needs, the library that talks to it and the hazards that come with
 * the family.
 *
 * This is what stops an unknown part from being silently mapped to "something
 * close enough". When the model asks for an SG92R and the catalog has no such
 * entry, matching it to the SG90 is *probably* right — but for a motor or a
 * battery, "probably" is a burnt component. Instead we recognise the contract
 * ("this is a 50 Hz hobby servo"), synthesise a provisional part that carries
 * the family's real requirements, and mark every field we could not verify.
 *
 * A provisional part is deliberately *not* equal to a catalog part:
 *
 *   - `metadata.provisional` is true and `metadata.unverifiedFields` names what
 *     we are guessing, so downstream code and the UI can be honest about it;
 *   - the electrical envelope is the family's *worst case*, not a typical
 *     value, so the power budget errs toward refusing rather than approving;
 *   - `verification` carries a human-readable instruction telling the user
 *     exactly which datasheet number to confirm.
 *
 * Adding a real catalog entry always wins: contracts are the floor, not a
 * replacement for engineering the part properly.
 */

import type { ComponentDefinition, ComponentPin } from '@/types/component';

import { def, pin } from './seed/helpers';

export interface ContractMatch {
  contract: ElectricalContract;
  /** 0-100 confidence that the query belongs to this family. */
  score: number;
  /** The term that triggered the match, for explainability. */
  matchedTerm: string;
}

export interface ElectricalContract {
  id: string;
  /** Human name of the family, e.g. "hobby servo (50 Hz PWM)". */
  family: string;
  category: ComponentDefinition['category'];
  /** Terms that identify membership of this family. */
  signals: string[];
  /**
   * Terms that look like a match but are a *different* contract. A "servo
   * driver" is not a servo; a "fan controller" is not a fan.
   */
  antiSignals?: string[];
  /** What the user must confirm on the real datasheet before building. */
  verification: string[];
  /** Fields the contract is guessing rather than knowing. */
  unverifiedFields: string[];
  /** Build a provisional definition for a specific requested name. */
  build(requestedName: string, id: string): ComponentDefinition;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

function titleCase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'Unknown part';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Shared provisional metadata.
 *
 * Every synthesised part carries this so no consumer can mistake it for a
 * verified catalog entry.
 */
function provisionalMetadata(
  contract: Omit<ElectricalContract, 'build'>,
  requestedName: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...extra,
    electrical: true,
    provisional: true,
    contractId: contract.id,
    contractFamily: contract.family,
    requestedAs: requestedName,
    unverifiedFields: contract.unverifiedFields,
    verification: contract.verification,
    note:
      `Not a verified catalog part. Wireup recognised "${requestedName}" as a ${contract.family} and applied that family's ` +
      'worst-case electrical envelope so the design fails safe. Confirm the datasheet values before building.',
  };
}

/* ------------------------------------------------------------------ *
 * Contract definitions
 * ------------------------------------------------------------------ */

const HOBBY_SERVO: ElectricalContract = {
  id: 'contract-hobby-servo',
  family: 'hobby servo (50 Hz PWM)',
  category: 'motor',
  signals: ['servo', 'sg90', 'sg92', 'mg90', 'mg996', 'ds3218', 'mg995', 'futaba', 'towerpro', 'micro servo', 'steering servo'],
  antiSignals: ['servo driver', 'servo controller', 'servo shield', 'servo tester', 'pca9685'],
  verification: [
    'Stall current at your supply voltage — this sets the power budget and the wire gauge.',
    'Operating voltage window (4.8-6 V is typical, some digital servos accept 7.4 V).',
    'Pulse range: most servos are 1.0-2.0 ms but many accept 0.5-2.5 ms for extended travel.',
  ],
  unverifiedFields: ['currentRequirements', 'motorRequirements.holdingTorqueKgCm', 'motorRequirements.stallCurrentMa'],
  build(requestedName, id) {
    return def({
      id,
      name: `${titleCase(requestedName)} (provisional servo)`,
      category: 'motor',
      description:
        `Provisional definition for "${requestedName}", recognised as a standard 3-wire hobby servo driven by a 50 Hz ` +
        'position pulse. Wireup applied the family contract because this exact part is not in the component database: ' +
        'the signal interface is reliable, but the current and torque figures are worst-case placeholders that must be ' +
        'confirmed against the real datasheet.',
      voltage: 5,
      minVoltage: 4.8,
      maxVoltage: 6,
      // Worst case across common hobby servos, so the power budget errs toward refusing.
      currentRequirements: {
        typicalMa: 250,
        maxMa: 2500,
        note: 'Worst-case standard-size servo stall current. Unverified — confirm on the datasheet for this exact model.',
      },
      motorRequirements: {
        motorType: 'servo',
        requiresDriver: false,
        requiresExternalSupply: true,
        supplyVoltageMin: 4.8,
        supplyVoltageMax: 6,
        stallCurrentMa: 2500,
        controlSignal: 'pwm',
      },
      pins: [
        pin('SIGNAL', 'pwm', 'input', { required: true, signal: '50 Hz position PWM', aliases: ['S', 'SIG', 'PWM', 'ORANGE', 'YELLOW', 'WHITE'] }),
        pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+', 'RED'] }),
        pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-', 'BROWN', 'BLACK'] }),
      ],
      libraryRequirements: [
        { name: 'Servo', import: 'Servo.h', manager: 'arduino', purpose: 'Hardware timer based servo PWM', builtIn: true },
      ],
      keywords: ['servo', 'pwm', 'position', requestedName.toLowerCase()],
      aliases: [requestedName.toLowerCase()],
      metadata: provisionalMetadata(HOBBY_SERVO, requestedName, {
        pwmFrequencyHz: 50,
        pulseRangeUs: [1000, 2000],
        stallIsTransient: true,
      }),
    });
  },
};

const BRUSHED_DC_MOTOR: ElectricalContract = {
  id: 'contract-brushed-dc-motor',
  family: 'brushed DC motor (needs an H-bridge)',
  category: 'motor',
  signals: ['dc motor', 'gear motor', 'gearmotor', 'brushed motor', 'tt motor', 'n20', 'rs-540', 'rs540', 'johnson motor', 'geared motor', 'drive motor'],
  antiSignals: ['motor driver', 'motor shield', 'motor controller', 'brushless', 'stepper', 'servo'],
  verification: [
    'Stall current at your supply voltage — this decides which H-bridge is safe (it is typically 5-10x the free-run current).',
    'Rated operating voltage; running a 6 V motor from 12 V will overheat it.',
    'Gearbox ratio and output RPM if the mechanism depends on speed.',
  ],
  unverifiedFields: ['currentRequirements', 'motorRequirements.stallCurrentMa', 'motorRequirements.rpm'],
  build(requestedName, id) {
    return def({
      id,
      name: `${titleCase(requestedName)} (provisional DC motor)`,
      category: 'motor',
      description:
        `Provisional definition for "${requestedName}", recognised as a two-terminal brushed DC motor. Direction comes ` +
        'from polarity and speed from PWM, so it must be driven through an H-bridge and never from an MCU pin. Current ' +
        'figures are worst-case placeholders until the datasheet is confirmed.',
      voltage: 6,
      minVoltage: 3,
      maxVoltage: 12,
      currentRequirements: {
        typicalMa: 500,
        maxMa: 3000,
        note: 'Worst-case small brushed motor stall current. Unverified — confirm against the real datasheet.',
      },
      motorRequirements: {
        motorType: 'dc',
        requiresDriver: true,
        requiresExternalSupply: true,
        supplyVoltageMin: 3,
        supplyVoltageMax: 12,
        stallCurrentMa: 3000,
        controlSignal: 'pwm',
      },
      pins: [
        pin('A', 'motor', 'input', { required: true, signal: 'Motor terminal A', aliases: ['+', 'M+', 'RED'] }),
        pin('B', 'motor', 'input', { required: true, signal: 'Motor terminal B', aliases: ['-', 'M-', 'BLACK'] }),
      ],
      incompatibleComponents: ['esp32-devkit-v1', 'arduino-uno-r3', 'arduino-nano'],
      keywords: ['dc motor', 'motor', requestedName.toLowerCase()],
      aliases: [requestedName.toLowerCase()],
      metadata: provisionalMetadata(BRUSHED_DC_MOTOR, requestedName, {
        noSupplyPins: true,
        inductiveLoad: true,
        flybackDiodeRequired: true,
        incompatibleReason: 'Stall current exceeds any MCU GPIO rating; an H-bridge driver is mandatory.',
      }),
    });
  },
};

const I2C_SENSOR: ElectricalContract = {
  id: 'contract-i2c-sensor',
  family: 'I2C sensor breakout',
  category: 'sensor',
  signals: ['i2c sensor', 'bmp', 'bme', 'sht', 'ccs811', 'sgp30', 'tsl2561', 'veml', 'apds', 'max30102', 'ads1115', 'mlx90614', 'vl53l0x', 'hmc5883', 'qmc5883', 'lis3dh', 'adxl345', 'mpu9250', 'bno055'],
  antiSignals: ['i2c lcd', 'oled', 'display', 'multiplexer', 'level shifter'],
  verification: [
    'I2C address (and whether an address-select pin changes it) — a wrong address is the most common cause of "sensor not found".',
    'Logic voltage: a 3.3 V-only sensor needs a level shifter on a 5 V board.',
    'The exact driver library for this part; the register map is model specific.',
  ],
  unverifiedFields: ['metadata.i2cAddress', 'currentRequirements', 'libraryRequirements'],
  build(requestedName, id) {
    return def({
      id,
      name: `${titleCase(requestedName)} (provisional I2C sensor)`,
      category: 'sensor',
      description:
        `Provisional definition for "${requestedName}", recognised as an I2C sensor breakout. The four-wire interface ` +
        '(VCC/GND/SDA/SCL) is standard and safe to wire, but the I2C address, the driver library and the current draw ' +
        'are unverified and must be confirmed before the firmware will actually talk to it.',
      voltage: 3.3,
      minVoltage: 3,
      maxVoltage: 5.5,
      currentRequirements: { typicalMa: 5, maxMa: 20, note: 'Placeholder for a small I2C breakout. Unverified.' },
      pins: [
        pin('VCC', 'power', 'power', { required: true, voltage: 3.3, signal: 'Supply — check whether this breakout is 3.3 V only', aliases: ['VIN', 'VDD', '+', '3V3', '5V'] }),
        pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'VSS'] }),
        pin('SDA', 'i2c', 'bidirectional', { required: true, signal: 'I2C data', aliases: ['SDI', 'DATA'] }),
        pin('SCL', 'i2c', 'input', { required: true, signal: 'I2C clock', aliases: ['SCK', 'CLK'] }),
      ],
      communicationProtocols: ['i2c'],
      libraryRequirements: [{ name: 'Wire', import: 'Wire.h', manager: 'arduino', purpose: 'I2C transport', builtIn: true }],
      keywords: ['i2c', 'sensor', requestedName.toLowerCase()],
      aliases: [requestedName.toLowerCase()],
      metadata: provisionalMetadata(I2C_SENSOR, requestedName, {
        i2cAddress: 'unknown — scan the bus with an I2C scanner sketch',
        logicVoltage: 3.3,
      }),
    });
  },
};

const DIGITAL_OUT_SENSOR: ElectricalContract = {
  id: 'contract-digital-sensor',
  family: '3-pin digital sensor module',
  category: 'sensor',
  signals: ['digital sensor', 'hall sensor', 'reed switch module', 'tilt sensor', 'vibration sensor', 'flame sensor', 'touch sensor', 'ky-', 'sound sensor', 'rain sensor', 'water level sensor', 'line sensor', 'tracking sensor'],
  antiSignals: ['i2c', 'spi', 'uart'],
  verification: [
    'Whether the output is active HIGH or active LOW — this inverts the firmware logic.',
    'Whether the module has an analog output (AO) in addition to the digital one.',
    'Supply voltage: many modules are 5 V and will not read reliably at 3.3 V.',
  ],
  unverifiedFields: ['pins.OUT polarity', 'currentRequirements', 'voltage'],
  build(requestedName, id) {
    return def({
      id,
      name: `${titleCase(requestedName)} (provisional digital sensor)`,
      category: 'sensor',
      description:
        `Provisional definition for "${requestedName}", recognised as a 3-pin sensor module with a single digital ` +
        'output. Wiring is standard (VCC/GND/OUT); the output polarity is unverified, so confirm whether the module ' +
        'reads HIGH or LOW when triggered before trusting the generated logic.',
      voltage: 5,
      minVoltage: 3.3,
      maxVoltage: 5.5,
      currentRequirements: { typicalMa: 15, maxMa: 40, note: 'Placeholder for a comparator-based sensor module. Unverified.' },
      pins: [
        pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['VIN', '+', 'V+'] }),
        pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
        pin('OUT', 'digital', 'output', { required: true, signal: 'Digital output — polarity unverified', aliases: ['DO', 'D0', 'SIG', 'S'] }),
      ],
      keywords: ['sensor', 'digital', requestedName.toLowerCase()],
      aliases: [requestedName.toLowerCase()],
      metadata: provisionalMetadata(DIGITAL_OUT_SENSOR, requestedName, { activeLowUnverified: true }),
    });
  },
};

const UART_MODULE: ElectricalContract = {
  id: 'contract-uart-module',
  family: 'UART serial module',
  category: 'communication',
  signals: ['uart', 'gps module', 'neo-6m', 'neo-7m', 'gsm', 'sim800', 'sim900', 'a9g', 'lora module', 'rfid reader', 'fingerprint sensor', 'serial module', 'bluetooth module', 'hc-12', 'e32'],
  antiSignals: ['usb to ttl', 'level shifter'],
  verification: [
    'Baud rate — the default varies by module and firmware revision.',
    'Logic level: a 5 V module TX into a 3.3 V MCU RX needs a divider or level shifter.',
    'Peak supply current: GSM modules pull 2 A bursts that a board regulator cannot provide.',
  ],
  unverifiedFields: ['metadata.baudRate', 'currentRequirements', 'voltage'],
  build(requestedName, id) {
    return def({
      id,
      name: `${titleCase(requestedName)} (provisional UART module)`,
      category: 'communication',
      description:
        `Provisional definition for "${requestedName}", recognised as a UART serial module. TX/RX must be crossed to ` +
        'the MCU (module TX to MCU RX). Baud rate, logic level and peak current are unverified — check them before ' +
        'wiring, especially the supply, since cellular modules can brown out a board regulator.',
      voltage: 3.3,
      minVoltage: 3.3,
      maxVoltage: 5.5,
      currentRequirements: {
        typicalMa: 60,
        maxMa: 2000,
        note: 'Worst case allows for a cellular module transmit burst. Unverified — confirm for this exact module.',
      },
      pins: [
        pin('VCC', 'power', 'power', { required: true, voltage: 3.3, signal: 'Supply — confirm 3.3 V vs 5 V', aliases: ['VIN', '+', 'VDD'] }),
        pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'VSS'] }),
        pin('TX', 'uart', 'output', { required: true, signal: 'Module transmit — wire to the MCU RX', aliases: ['TXD', 'TXO'] }),
        pin('RX', 'uart', 'input', { required: true, signal: 'Module receive — wire to the MCU TX', aliases: ['RXD', 'RXI'] }),
      ],
      communicationProtocols: ['uart'],
      keywords: ['uart', 'serial', requestedName.toLowerCase()],
      aliases: [requestedName.toLowerCase()],
      metadata: provisionalMetadata(UART_MODULE, requestedName, {
        baudRate: 'unknown — 9600 and 115200 are the usual defaults',
        crossoverRequired: true,
      }),
    });
  },
};

const RELAY_SWITCH: ElectricalContract = {
  id: 'contract-relay-switch',
  family: 'relay / high-side switch module',
  category: 'actuator',
  signals: ['relay', 'relay module', 'ssr', 'solid state relay', 'contactor'],
  antiSignals: ['relay driver ic'],
  verification: [
    'Coil voltage and whether the module input is active HIGH or active LOW (most cheap boards are active LOW).',
    'Contact rating against the actual load — inrush on a motor or lamp is far above its running current.',
    'Whether the board has opto-isolation and a separate JD-VCC jumper for the coil supply.',
  ],
  unverifiedFields: ['pins.IN polarity', 'currentRequirements', 'metadata.contactRating'],
  build(requestedName, id) {
    return def({
      id,
      name: `${titleCase(requestedName)} (provisional relay)`,
      category: 'actuator',
      description:
        `Provisional definition for "${requestedName}", recognised as a relay module. The coil is an inductive load ` +
        'driven through the on-board transistor, so the MCU only supplies the logic input. Input polarity and contact ' +
        'rating are unverified — most low-cost boards are active LOW, which inverts the firmware.',
      voltage: 5,
      minVoltage: 3.3,
      maxVoltage: 5.5,
      currentRequirements: { typicalMa: 70, maxMa: 100, note: 'Coil current per channel while energised. Unverified.' },
      pins: [
        pin('VCC', 'power', 'power', { required: true, voltage: 5, signal: 'Coil supply', aliases: ['+', 'VIN'] }),
        pin('GND', 'ground', 'ground', { required: true, aliases: ['-'] }),
        pin('IN', 'digital', 'input', { required: true, signal: 'Control input — polarity unverified, often active LOW', aliases: ['IN1', 'SIG', 'S'] }),
        pin('COM', 'other', 'bidirectional', { required: false, signal: 'Switched common terminal (mains side)' }),
        pin('NO', 'other', 'bidirectional', { required: false, signal: 'Normally-open contact' }),
        pin('NC', 'other', 'bidirectional', { required: false, signal: 'Normally-closed contact' }),
      ],
      keywords: ['relay', 'switch', requestedName.toLowerCase()],
      aliases: [requestedName.toLowerCase()],
      metadata: provisionalMetadata(RELAY_SWITCH, requestedName, {
        activeLowUnverified: true,
        inductiveLoad: true,
        safetyNote: 'If the switched side is mains voltage, this must be built by someone competent to work on mains.',
      }),
    });
  },
};

/** Ordered most-specific first; matching stops at the best score. */
export const ELECTRICAL_CONTRACTS: ElectricalContract[] = [
  HOBBY_SERVO,
  BRUSHED_DC_MOTOR,
  I2C_SENSOR,
  DIGITAL_OUT_SENSOR,
  UART_MODULE,
  RELAY_SWITCH,
];

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Recognise which electrical family a requested part belongs to.
 *
 * Returns undefined when nothing matches confidently — an unrecognised part
 * must stay unmatched rather than be forced into the nearest family, because a
 * wrong contract is worse than an honest gap.
 */
export function matchContract(query: string): ContractMatch | undefined {
  const needle = normalise(query);
  if (!needle) return undefined;

  let best: ContractMatch | undefined;

  for (const contract of ELECTRICAL_CONTRACTS) {
    if ((contract.antiSignals ?? []).some((term) => needle.includes(normalise(term)))) continue;

    for (const signal of contract.signals) {
      const term = normalise(signal);
      if (!term) continue;

      let score = 0;
      if (needle === term) score = 95;
      else if (needle.startsWith(`${term} `) || needle.endsWith(` ${term}`)) score = 85;
      else if (needle.includes(term)) score = term.length >= 4 ? 78 : 60;

      if (score > 0 && (!best || score > best.score)) {
        best = { contract, score, matchedTerm: signal };
      }
    }
  }

  return best && best.score >= 60 ? best : undefined;
}

/**
 * Build a provisional catalog entry for an unmatched part.
 *
 * The returned definition is structurally identical to a catalog entry so every
 * downstream stage (wiring, pin planning, diagram, firmware) works unchanged —
 * the difference is carried in `metadata.provisional`, which the validator and
 * the UI use to refuse silent confidence.
 */
export function buildProvisionalComponent(
  requestedName: string,
  match: ContractMatch,
): ComponentDefinition {
  const id = `provisional-${slug(requestedName) || match.contract.id}`;
  return match.contract.build(requestedName, id);
}

/** True when a definition came from a contract rather than the catalog. */
export function isProvisional(component: ComponentDefinition | undefined): boolean {
  return component?.metadata?.provisional === true;
}

/** The datasheet values a provisional part still needs confirmed. */
export function provisionalVerification(component: ComponentDefinition): string[] {
  const value = component.metadata?.verification;
  return Array.isArray(value) ? value.map(String) : [];
}

/** Required pins of a contract, used by tests and the audit. */
export function contractPins(contract: ElectricalContract): ComponentPin[] {
  return contract.build('probe', 'probe').pins;
}
