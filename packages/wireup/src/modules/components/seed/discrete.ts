/** Discrete semiconductor seed entries (transistors, MOSFETs, optocouplers). */

import type { ComponentDefinition } from '@/types/component';

import { def, pin } from './helpers';

/**
 * Bare semiconductors. These are the parts the catalog's own notes keep
 * telling users to add ("drive it with a transistor", "switch it with a
 * logic-level MOSFET") — selectable at last. All are circuit-level parts: the
 * Velxio build solves them on the ngspice netlist (SPICE tier), which is
 * claimed with the standard tier-S note.
 */
export const DISCRETE: ComponentDefinition[] = [
  def({
    id: 'transistor-2n2222',
    name: '2N2222 / PN2222 NPN transistor (TO-92)',
    category: 'discrete',
    description:
      'The default small-power NPN. VCEO 40 V, 600 mA continuous collector current (1 A peak), hFE 100-300. As a low-side switch from a GPIO: base resistor = (Voh - 0.7 V) / (Ic / 10) — roughly 1 kohm for 100 mA from a 5 V pin, 470 ohms from 3.3 V. VCEsat is ~0.3 V at 150 mA, so it dissipates (0.3 V x Ic) — fine to ~200 mA in free air.',
    voltage: 40,
    maxVoltage: 40,
    currentRequirements: { typicalMa: 100, maxMa: 600, note: 'Continuous collector current; 800 mA absolute max on some datasheets — design to 600 mA.' },
    pins: [
      pin('B', 'control', 'input', { required: true, signal: 'Base — drive through a series resistor (rule of thumb: Ic/10 for hard saturation)', aliases: ['BASE'] }),
      pin('C', 'other', 'bidirectional', { required: true, signal: 'Collector — to the load; the load returns to the supply', aliases: ['COLLECTOR'] }),
      pin('E', 'ground', 'bidirectional', { required: true, signal: 'Emitter — to GND (low-side switch)', aliases: ['EMITTER'] }),
    ],
    keywords: ['transistor', 'npn', '2n2222', 'pn2222', 'switch', 'driver', 'bjt'],
    aliases: ['2n2222', 'pn2222', 'npn transistor', 'transistor', 'bjt'],
    exampleUsage: ['Low-side switch for a relay or buzzer from a GPIO', 'PWM driver for a small DC load'],
    simulator: {
      part: 'wokwi-bjt-2n2222',
      supported: true,
      notes:
        'Circuit-level SPICE model: the solved netlist carries the BJT junction equations, so the base resistor divider, saturation and load current all resolve on the canvas. No behavioural logic — a solved voltage, not a datasheet: thermal limits and hFE spread are not modelled.',
    },
    metadata: { electrical: true, noSupplyPins: true, polarity: 'npn', package: 'TO-92', vceoV: 40, hfeTypical: 200, requiresBaseResistor: true },
  }),

  def({
    id: 'mosfet-2n7000',
    name: '2N7000 N-channel MOSFET (TO-92)',
    category: 'discrete',
    description:
      'Small logic-friendly NMOS: rated 200 mA continuous, RDS(on) roughly 2-5 ohm with a 4.5 V gate. Good for LEDs, small relays and buzzers from a 5 V GPIO through a ~100 ohm gate resistor. At 3.3 V it is already marginal — check your load current; this is NOT the part for amps.',
    voltage: 60,
    maxVoltage: 60,
    currentRequirements: { typicalMa: 100, maxMa: 200, note: 'Continuous drain current at 25 C; derate sharply with a small TO-92 package.' },
    pins: [
      pin('G', 'control', 'input', { required: true, signal: 'Gate — voltage driven, no DC gate current; a ~100 ohm series resistor damps ringing', aliases: ['GATE'] }),
      pin('D', 'other', 'bidirectional', { required: true, signal: 'Drain — to the load; the load returns to the supply', aliases: ['DRAIN'] }),
      pin('S', 'ground', 'bidirectional', { required: true, signal: 'Source — to GND (low-side switch)', aliases: ['SOURCE'] }),
    ],
    keywords: ['mosfet', 'nmos', '2n7000', 'logic level', 'switch', 'n channel'],
    aliases: ['2n7000', 'n channel mosfet', 'logic level mosfet', 'small mosfet'],
    exampleUsage: ['Low-side switch for a 12 V LED string from a 5 V GPIO', 'Driving a small solenoid with flyback protection'],
    simulator: {
      part: 'wokwi-mosfet-2n7000',
      supported: true,
      notes:
        'Circuit-level SPICE model: gate threshold and channel conduction resolve in the netlist, so a 3.3 V vs 5 V gate really does switch differently. No behavioural logic — a solved voltage, not a datasheet: thermal dissipation limits are not modelled.',
    },
    metadata: { electrical: true, noSupplyPins: true, polarity: 'nmos', package: 'TO-92', vdsV: 60, gateThresholdV: [0.8, 3], rdsOnOhmAt4v5: 5, logicLevelGate: true },
  }),

  def({
    id: 'mosfet-irf540',
    name: 'IRF540N N-channel power MOSFET (TO-220)',
    category: 'discrete',
    description:
      'Classic power NMOS: 100 V, 33 A package rating, RDS(on) 44 mohm — but RDS(on) is specified at VGS = 10 V. It is NOT a logic-level FET: from a 3.3 V or 5 V GPIO it only half-enhances, sags under load and heats. Drive the gate with 10-12 V (or through a BJT/driver stage), or pick a logic-level part for direct GPIO drive. Always a low-side switch: source to GND, load between supply and drain.',
    voltage: 100,
    maxVoltage: 100,
    currentRequirements: { typicalMa: 10000, maxMa: 33000, note: '33 A is the TO-220 package limit at 25 C with the tab cooled — design well under it; at VGS 10 V and a proper heat sink.' },
    pins: [
      pin('G', 'control', 'input', { required: true, signal: 'Gate — needs a real 10 V drive for the rated RDS(on); a GPIO alone will cook it under load', aliases: ['GATE'] }),
      pin('D', 'motor', 'bidirectional', { required: true, signal: 'Drain — to the load (motor +, heater, LED rail)', aliases: ['DRAIN'] }),
      pin('S', 'ground', 'bidirectional', { required: true, signal: 'Source — to GND (low-side switch)', aliases: ['SOURCE'] }),
    ],
    keywords: ['mosfet', 'power mosfet', 'irf540', 'irf540n', 'n channel', 'high current switch'],
    aliases: ['irf540', 'irf540n', 'power mosfet', 'high current mosfet'],
    exampleUsage: ['PWM motor brake / load switch with a proper gate driver', 'Heater or high-power LED bank switching'],
    simulator: {
      part: 'wokwi-mosfet-irf540',
      supported: true,
      notes:
        'Circuit-level SPICE model: the transfer curve is real, so a 5 V gate visibly under-drives versus a 10 V gate — the datasheet trap is observable, not hidden. No behavioural logic — a solved voltage, not a datasheet: thermal runaway and gate-charge dynamics are not modelled.',
    },
    metadata: { electrical: true, noSupplyPins: true, polarity: 'nmos', package: 'TO-220', vdsV: 100, rdsOnMohmAt10v: 44, logicLevelGate: false, caution: 'RDS(on) is specified at VGS = 10 V — not logic-level; drive the gate from 10-12 V.' },
  }),

  def({
    id: 'optocoupler-pc817',
    name: 'PC817 optocoupler (phototransistor output)',
    category: 'discrete',
    description:
      'Single-channel optocoupler: an infrared LED facing a phototransistor in a 4-pin DIP, 5 kV input-to-output isolation. Drive the LED side from a GPIO through a ~330 ohm resistor (IF ~10 mA, VF 1.2 V); the collector/emitter side switches up to 80 V at ~50 mA. CTR (current transfer ratio) 50-600 % by rank — budget the output side at 2-5x the input current. The standard way to isolate a mains-side triac/relay stage or two hostile voltage domains from an MCU.',
    minVoltage: 0,
    maxVoltage: 80,
    currentRequirements: { typicalMa: 10, maxMa: 50, note: 'Input LED current — this is what the MCU supply provides; the output side switches the OTHER circuit\'s current.' },
    pins: [
      pin('ANODE', 'other', 'input', { required: true, signal: 'LED anode — from the GPIO THROUGH a series resistor (330 ohm at 5 V)', aliases: ['AN', 'A', '+'] }),
      pin('CATHODE', 'ground', 'input', { required: true, signal: 'LED cathode — to the driving MCU\'s GND', aliases: ['CAT', 'C', 'K', '-'] }),
      pin('COLLECTOR', 'other', 'bidirectional', { required: true, signal: 'Phototransistor collector — to the isolated side\'s pull-up/load', aliases: ['COL', 'OUT'] }),
      pin('EMITTER', 'ground', 'bidirectional', { required: true, signal: 'Phototransistor emitter — to the isolated side\'s ground', aliases: ['EMIT', 'E'] }),
    ],
    keywords: ['optocoupler', 'opto', 'pc817', 'isolator', 'isolation', 'phototransistor'],
    aliases: ['pc817', 'optocoupler', 'opto isolator', 'optocoupler pc817', 'isolation ic'],
    exampleUsage: ['Isolated mains-detection input', 'Level/isolation barrier between two supplies'],
    simulator: {
      part: 'wokwi-opto-pc817',
      supported: true,
      notes:
        'Circuit-level SPICE model: the LED side and the phototransistor side solve as coupled circuits, so a missing input series resistor shows up as real current, not as a warning. No behavioural logic — a solved voltage, not a datasheet: CTR rank spread and isolation voltage are not modelled.',
    },
    metadata: { electrical: true, noSupplyPins: true, requiresSeriesResistor: true, seriesResistorOhmAt5v: 330, isolationKV: 5, ctrPercent: [50, 600], vceoV: 80, ifMaxMa: 50 },
  }),
];
