/** Power-related seed entries: supplies, regulators, conversion and protection. */

import type { ComponentDefinition } from '@/types/component';

import { def, pin } from './helpers';

export const POWER: ComponentDefinition[] = [
  def({
    id: 'battery-2s-lipo',
    name: '2S LiPo battery pack (7.4 V)',
    category: 'power',
    description:
      'Two lithium-polymer cells in series: 7.4 V nominal, 8.4 V fully charged, 6.0 V safe cutoff. High discharge capability makes it the standard choice for motor projects. Feed motors from it directly and derive the logic rail with a regulator or the driver board regulator.',
    voltage: 7.4,
    minVoltage: 6,
    maxVoltage: 8.4,
    currentRequirements: { typicalMa: 1000, maxMa: 20000, note: 'Continuous discharge depends on the C rating; a 2200 mAh 20C pack sustains 44 A.' },
    powerSourceRequirements: {
      outputVoltage: 7.4,
      outputVoltageMin: 6,
      outputVoltageMax: 8.4,
      capacityMah: 2200,
      maxCurrentMa: 20000,
      chemistry: 'LiPo',
      adjustable: false,
      rail: 'VBAT',
    },
    pins: [
      pin('+', 'power', 'output', { required: true, voltage: 7.4, signal: 'Positive terminal', aliases: ['V+', 'POS', 'RED'] }),
      pin('-', 'ground', 'output', { required: true, signal: 'Negative terminal / system ground reference', aliases: ['V-', 'NEG', 'BLACK', 'GND'] }),
    ],
    keywords: ['battery', 'lipo', 'li-po', '7.4v', '2s', 'power supply', 'pack'],
    aliases: ['lipo', 'lipo battery', '2s lipo', '7.4v battery'],
    metadata: {
      electrical: true,
      cells: 2,
      cutoffVoltagePerCell: 3.0,
      chargeVoltagePerCell: 4.2,
      connector: 'XT60 / JST (verify against the actual pack)',
      safety: 'Use a protection circuit or monitor cell voltage; never discharge below 3.0 V per cell.',
    },
  }),

  def({
    id: 'battery-9v',
    name: '9 V alkaline battery (PP3)',
    category: 'power',
    description:
      'Convenient 9 V source for low-current projects. Internal resistance rises quickly: it can only supply a few hundred milliamps, so it is unsuitable for motor stall loads but fine for sensors and logic.',
    voltage: 9,
    minVoltage: 5.4,
    maxVoltage: 9.6,
    currentRequirements: { typicalMa: 100, maxMa: 500, note: 'Voltage sags heavily above ~300 mA.' },
    powerSourceRequirements: {
      outputVoltage: 9,
      outputVoltageMin: 5.4,
      outputVoltageMax: 9.6,
      capacityMah: 500,
      maxCurrentMa: 500,
      chemistry: 'Alkaline',
      rail: '9V',
    },
    pins: [
      pin('+', 'power', 'output', { required: true, voltage: 9, aliases: ['POS', 'RED'] }),
      pin('-', 'ground', 'output', { required: true, aliases: ['NEG', 'BLACK', 'GND'] }),
    ],
    keywords: ['battery', '9v', 'pp3', 'power supply', 'alkaline'],
    aliases: ['9v battery', 'pp3', '9 volt battery'],
    simulator: {
      part: 'wokwi-battery-9v',
      supported: true,
      notes:
        'Circuit-level SPICE model: the element solves as a source with internal resistance, so sag under heavy load is visible. No behavioural logic — a solved voltage, not a datasheet: the 500 mAh capacity is NOT modelled and a simulated battery never runs flat.',
    },
    metadata: { electrical: true, unsuitableForMotors: true, note: 'Do not use as the sole supply for DC motor stall loads.' },
  }),

  def({
    id: 'battery-holder-4xaa',
    name: '4x AA battery holder (6 V)',
    category: 'power',
    description:
      'Four AA cells in series: 6 V alkaline (or 4.8 V with NiMH). Comfortable 1–2 A capability, cheap and safe, and sits nicely in the 5–12 V window most motor drivers accept.',
    voltage: 6,
    minVoltage: 4.4,
    maxVoltage: 6.4,
    currentRequirements: { typicalMa: 500, maxMa: 2000 },
    powerSourceRequirements: {
      outputVoltage: 6,
      outputVoltageMin: 4.4,
      outputVoltageMax: 6.4,
      capacityMah: 2500,
      maxCurrentMa: 2000,
      chemistry: 'Alkaline / NiMH',
      rail: 'VBAT',
    },
    pins: [
      pin('+', 'power', 'output', { required: true, voltage: 6, aliases: ['POS', 'RED'] }),
      pin('-', 'ground', 'output', { required: true, aliases: ['NEG', 'BLACK', 'GND'] }),
    ],
    keywords: ['battery', 'aa', 'battery holder', '6v', 'power supply'],
    aliases: ['aa battery holder', '4xaa', 'battery pack'],
    metadata: { electrical: true, cells: 4 },
  }),

  def({
    id: 'breadboard-power-module-mb102',
    name: 'MB102 breadboard power supply module',
    category: 'power',
    description:
      'Breadboard rail supply: takes 6.5–12 V from a DC jack or 5 V from USB and provides independently jumper-selectable 3.3 V / 5 V rails, up to ~700 mA total.',
    voltage: 5,
    minVoltage: 3.3,
    maxVoltage: 5,
    currentRequirements: { typicalMa: 200, maxMa: 700 },
    powerSourceRequirements: { outputVoltage: 5, outputVoltageMin: 3.3, outputVoltageMax: 5, maxCurrentMa: 700, adjustable: true, rail: 'RAIL' },
    pins: [
      pin('VIN_DC', 'power', 'input', { required: false, voltage: 9, signal: '6.5–12 V DC jack input', aliases: ['DC_IN', 'IN'] }),
      pin('USB_5V', 'power', 'input', { required: false, voltage: 5, signal: 'USB 5 V input', aliases: ['USB'] }),
      pin('GND_IN', 'ground', 'input', { required: true, aliases: ['IN_GND'] }),
      pin('+RAIL', 'power', 'output', { required: true, voltage: 5, signal: 'Selectable 3.3 V or 5 V positive rail', aliases: ['VCC', '5V', '3V3'] }),
      pin('-RAIL', 'ground', 'output', { required: true, aliases: ['GND'] }),
    ],
    keywords: ['breadboard power', 'mb102', 'power module', 'rail supply', '3.3v', '5v'],
    aliases: ['mb102', 'breadboard power supply', 'power module'],
    metadata: { electrical: true, selectableRails: [3.3, 5], maxTotalCurrentMa: 700 },
  }),

  def({
    id: 'regulator-lm7805',
    name: 'LM7805 5 V linear regulator (TO-220)',
    category: 'power',
    description:
      'Classic positive linear regulator: 7–35 V in, 5 V out, up to 1.5 A with a heat sink. Needs ~2 V headroom and dissipates (Vin - 5) x I as heat, so it is inefficient for motor battery supplies. Add 0.33 µF on the input and 0.1 µF on the output.',
    voltage: 5,
    minVoltage: 4.8,
    maxVoltage: 5.2,
    currentRequirements: { typicalMa: 500, maxMa: 1500 },
    powerSourceRequirements: { outputVoltage: 5, outputVoltageMin: 4.8, outputVoltageMax: 5.2, maxCurrentMa: 1500, adjustable: false, rail: '5V' },
    pins: [
      pin('IN', 'power', 'input', { required: true, voltage: 9, signal: 'Unregulated input 7–35 V', aliases: ['VIN', 'INPUT'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['COM', 'ADJ'] }),
      pin('OUT', 'power', 'output', { required: true, voltage: 5, signal: 'Regulated 5 V output', aliases: ['VOUT', 'OUTPUT', '5V'] }),
    ],
    keywords: ['lm7805', '7805', 'regulator', '5v regulator', 'linear regulator', 'voltage regulator'],
    aliases: ['7805', 'lm7805', '5v regulator', 'voltage regulator'],
    simulator: {
      part: 'wokwi-reg-7805',
      supported: true,
      notes:
        'Circuit-level SPICE model: the output rail solves against the load, so feeding it from too-low a voltage produces a visibly sagging 5 V. No behavioural logic — a solved voltage, not a datasheet: dropout slope, thermal shutdown and current limiting are not modelled.',
    },
    metadata: { electrical: true, dropoutV: 2, heatSinkAboveMa: 500, package: 'TO-220', inputRangeV: [7, 35] },
  }),

  def({
    id: 'regulator-ams1117-3v3',
    name: 'AMS1117-3.3 3.3 V LDO regulator',
    category: 'power',
    description:
      'Low-dropout regulator producing 3.3 V from 4.75–12 V at up to ~800 mA. Dropout is ~1.1 V at full load, so 5 V in is workable but leaves little headroom. Standard choice for powering 3.3 V logic from a 5 V rail.',
    voltage: 3.3,
    minVoltage: 3.2,
    maxVoltage: 3.4,
    currentRequirements: { typicalMa: 200, maxMa: 800 },
    powerSourceRequirements: { outputVoltage: 3.3, outputVoltageMin: 3.2, outputVoltageMax: 3.4, maxCurrentMa: 800, adjustable: false, rail: '3V3' },
    pins: [
      pin('IN', 'power', 'input', { required: true, voltage: 5, signal: 'Input 4.75–12 V', aliases: ['VIN'] }),
      pin('GND', 'ground', 'ground', { required: true }),
      pin('OUT', 'power', 'output', { required: true, voltage: 3.3, signal: 'Regulated 3.3 V output', aliases: ['VOUT', '3V3'] }),
    ],
    keywords: ['ams1117', '3.3v regulator', 'ldo', 'regulator', 'voltage regulator'],
    aliases: ['ams1117', 'ams1117-3.3', '3.3v ldo'],
    metadata: { electrical: true, dropoutV: 1.1, package: 'SOT-223', inputRangeV: [4.75, 12] },
  }),

  def({
    id: 'buck-converter-lm2596',
    name: 'LM2596 adjustable buck converter',
    category: 'power',
    description:
      'Switching step-down converter: 4–40 V in, 1.23–37 V out (adjustable with the multi-turn trimmer), up to 3 A with a heat sink (2 A recommended continuous). Far more efficient than a linear regulator when stepping a motor battery down to a logic rail.',
    voltage: 5,
    minVoltage: 1.23,
    maxVoltage: 37,
    currentRequirements: { typicalMa: 1000, maxMa: 3000 },
    powerSourceRequirements: { outputVoltage: 5, outputVoltageMin: 1.23, outputVoltageMax: 37, maxCurrentMa: 3000, adjustable: true, rail: 'VOUT' },
    pins: [
      pin('IN+', 'power', 'input', { required: true, voltage: 12, signal: 'Input positive 4–40 V', aliases: ['VIN+', 'IN'] }),
      pin('IN-', 'ground', 'input', { required: true, aliases: ['GND_IN', 'IN-'] }),
      pin('OUT+', 'power', 'output', { required: true, voltage: 5, signal: 'Regulated output positive', aliases: ['VOUT+', 'OUT'] }),
      pin('OUT-', 'ground', 'output', { required: true, aliases: ['GND_OUT', 'OUT-'] }),
    ],
    keywords: ['buck', 'step down', 'lm2596', 'dc-dc', 'converter', 'switching regulator', 'adjustable'],
    aliases: ['lm2596', 'buck converter', 'step-down converter', 'dc-dc buck'],
    metadata: { electrical: true, topology: 'buck', efficiencyPercent: 85, trimmingRequired: true, inputRangeV: [4, 40] },
  }),

  def({
    id: 'logic-level-shifter-4ch',
    name: '4-channel bidirectional logic level shifter',
    category: 'power',
    description:
      'BSS138-based bidirectional level translator between a high-side rail (HV, 3.6–5.5 V) and a low-side rail (LV, 1.8–3.3 V). Four independent channels, 10 kΩ pull-ups on both sides. Use it between 5 V and 3.3 V logic such as an HC-05 and an ESP32, or a 5 V ECHO pin into a 3.3 V MCU.',
    voltage: 3.3,
    minVoltage: 1.8,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 1, maxMa: 10 },
    pins: [
      pin('HV', 'power', 'power', { required: true, voltage: 5, aliases: ['VCCA', 'HIGH'] }),
      pin('LV', 'power', 'power', { required: true, voltage: 3.3, aliases: ['VCCB', 'LOW'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['VSS'] }),
      pin('HV1', 'digital', 'bidirectional', { required: false, aliases: ['RXI'] }),
      pin('LV1', 'digital', 'bidirectional', { required: false, aliases: ['TXO'] }),
      pin('HV2', 'digital', 'bidirectional', { required: false }),
      pin('LV2', 'digital', 'bidirectional', { required: false }),
      pin('HV3', 'digital', 'bidirectional', { required: false }),
      pin('LV3', 'digital', 'bidirectional', { required: false }),
      pin('HV4', 'digital', 'bidirectional', { required: false }),
      pin('LV4', 'digital', 'bidirectional', { required: false }),
    ],
    keywords: ['level shifter', 'logic level', 'voltage translator', '3.3v to 5v', 'bss138', 'txs0108'],
    aliases: ['level shifter', 'logic level converter', 'level converter', 'voltage level translator'],
    metadata: { electrical: true, channels: 4, bidirectional: true, maxSpeedMhz: 2, requiresPullups: true },
  }),

  def({
    id: 'diode-1n4007',
    name: '1N4007 rectifier / flyback diode',
    category: 'power',
    description:
      '1 A, 1000 V general-purpose rectifier diode. Across an inductive load (relay coil, raw DC motor) it clamps the back-EMF spike when the current is interrupted. Cathode (striped end) goes to the positive side of the load.',
    minVoltage: 0,
    maxVoltage: 1000,
    currentRequirements: { typicalMa: 100, maxMa: 1000 },
    pins: [
      pin('A', 'other', 'bidirectional', { required: true, signal: 'Anode — to the low side of the load', aliases: ['ANODE', '+'] }),
      pin('K', 'other', 'bidirectional', { required: true, signal: 'Cathode (striped) — to the high side of the load', aliases: ['CATHODE', '-'] }),
    ],
    keywords: ['diode', 'flyback', 'freewheeling', '1n4007', 'protection', 'back emf'],
    aliases: ['1n4007', 'flyback diode', 'rectifier diode', 'freewheel diode'],
    simulator: {
      part: 'wokwi-diode-1n4007',
      supported: true,
      notes:
        'Circuit-level SPICE model: the diode equation solves on the netlist, so the flyback clamp across a simulated coil actually clamps. No behavioural logic — a solved voltage, not a datasheet: 1 A current rating and reverse-recovery behaviour are not enforced.',
    },
    metadata: { electrical: true, noSupplyPins: true, forwardVoltageV: 0.7, peakReverseVoltageV: 1000, useCase: 'Flyback clamp across inductive loads' },
  }),

  def({
    id: 'diode-1n4148',
    name: '1N4148 small-signal switching diode (DO-35)',
    category: 'power',
    description:
      'The fast small-signal diode: 100 V reverse, ~150 mA continuous forward, 0.6-0.7 V drop at tens of milliamps and a ~4 ns recovery that makes it the standard clamp for logic-level switching, steering/OR-ing inputs and small relay/buzzer coils. For anything above ~100 mA continuous use a 1N4007; for low-drop rectification use a Schottky.',
    minVoltage: 0,
    maxVoltage: 100,
    currentRequirements: { typicalMa: 20, maxMa: 150, note: 'IF(AV) ~150 mA at 25 C with leads at 1 cm; 2-4 A non-repetitive surge.' },
    pins: [
      pin('A', 'other', 'bidirectional', { required: true, signal: 'Anode — toward the more positive point when forward-biased', aliases: ['ANODE', '+'] }),
      pin('K', 'other', 'bidirectional', { required: true, signal: 'Cathode (striped end)', aliases: ['CATHODE', '-'] }),
    ],
    keywords: ['diode', '1n4148', 'switching diode', 'signal diode', 'fast diode', 'clamp'],
    aliases: ['1n4148', 'switching diode', 'signal diode', 'small signal diode'],
    simulator: {
      part: 'wokwi-diode-1n4148',
      supported: true,
      notes:
        'Circuit-level SPICE model: forward drop and reverse blocking solve in the netlist. No behavioural logic — a solved voltage, not a datasheet: the 150 mA rating is not enforced.',
    },
    metadata: { electrical: true, noSupplyPins: true, forwardVoltageV: 0.7, peakReverseVoltageV: 100, recoveryNs: 4, useCase: 'Logic clamping, steering, small coil flyback' },
  }),

  def({
    id: 'diode-1n5819',
    name: '1N5819 Schottky diode (40 V, 1 A)',
    category: 'power',
    description:
      'Schottky barrier rectifier: ~0.45 V typical forward drop at 1 A (0.6 V max) against the ~0.9 V of a silicon diode, and essentially zero recovery time. The choice where every hundred millivolts is heat or runtime: reverse-polarity protection in series with a supply rail, low-voltage rectification, flyback on bigger coils where a hot diode wastes your budget. 40 V reverse limit — not for mains-side work.',
    minVoltage: 0,
    maxVoltage: 40,
    currentRequirements: { typicalMa: 500, maxMa: 1000, note: '1 A continuous at 25 C with adequate leads; ~25 A non-repetitive surge.' },
    pins: [
      pin('A', 'other', 'bidirectional', { required: true, signal: 'Anode (black bar end is the cathode)', aliases: ['ANODE', '+'] }),
      pin('K', 'other', 'bidirectional', { required: true, signal: 'Cathode — to the more positive point in a protection diode', aliases: ['CATHODE', '-'] }),
    ],
    keywords: ['diode', 'schottky', '1n5819', 'low drop', 'rectifier', 'polarity protection'],
    aliases: ['1n5819', 'schottky diode', '1a schottky'],
    simulator: {
      part: 'wokwi-diode-1n5819',
      supported: true,
      notes:
        'Circuit-level SPICE model: the low forward drop solves in the netlist and is visible in the rail voltage. No behavioural logic — a solved voltage, not a datasheet: the 1 A and 40 V ratings are not enforced.',
    },
    metadata: { electrical: true, noSupplyPins: true, forwardVoltageV: 0.45, peakReverseVoltageV: 40, useCase: 'Low-drop rectification, reverse-polarity series protection' },
  }),
];
