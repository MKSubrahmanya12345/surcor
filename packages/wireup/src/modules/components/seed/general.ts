/** General purpose parts: passives, inputs, prototyping. */

import type { ComponentDefinition } from '@/types/component';

import { def, pin } from './helpers';

export const GENERAL: ComponentDefinition[] = [
  def({
    id: 'resistor-220ohm',
    name: '220 Ω resistor (1/4 W)',
    category: 'passive',
    description: '220 Ω, ±5 %, 1/4 W through-hole resistor. The standard LED current limiter from a 5 V logic pin (≈13 mA at a 2.1 V LED).',
    currentRequirements: { typicalMa: 13, maxMa: 20 },
    pins: [
      pin('1', 'other', 'bidirectional', { required: true, aliases: ['A'] }),
      pin('2', 'other', 'bidirectional', { required: true, aliases: ['B'] }),
    ],
    keywords: ['resistor', '220 ohm', 'led resistor', 'current limiting'],
    aliases: ['220r', '220 ohm resistor', 'resistor 220'],
    simulator: { part: 'wokwi-resistor', supported: true, attrs: { value: '220' } },
    metadata: { electrical: true, noSupplyPins: true, resistanceOhm: 220, tolerancePercent: 5, powerRatingW: 0.25, inSeriesWith: 'LED anode from a 5 V pin' },
  }),

  def({
    id: 'resistor-1kohm',
    name: '1 kΩ resistor (1/4 W)',
    category: 'passive',
    description: '1 kΩ, ±5 %, 1/4 W resistor. Useful for LED limiting from 3.3 V logic and as a general-purpose series/base resistor.',
    pins: [
      pin('1', 'other', 'bidirectional', { required: true, aliases: ['A'] }),
      pin('2', 'other', 'bidirectional', { required: true, aliases: ['B'] }),
    ],
    keywords: ['resistor', '1k', '1 kohm', 'current limiting'],
    aliases: ['1k resistor', '1kohm', 'resistor 1k'],
    simulator: { part: 'wokwi-resistor', supported: true, attrs: { value: '1k' } },
    metadata: { electrical: true, noSupplyPins: true, resistanceOhm: 1000, tolerancePercent: 5, powerRatingW: 0.25 },
  }),

  def({
    id: 'resistor-10kohm',
    name: '10 kΩ resistor (1/4 W)',
    category: 'passive',
    description:
      '10 kΩ, ±5 %, 1/4 W resistor. The default pull-up/pull-down value: used with pushbuttons, DHT data lines and as the bottom leg of an LDR voltage divider.',
    pins: [
      pin('1', 'other', 'bidirectional', { required: true, aliases: ['A'] }),
      pin('2', 'other', 'bidirectional', { required: true, aliases: ['B'] }),
    ],
    keywords: ['resistor', '10k', 'pullup', 'pull-up', 'pull-down', 'voltage divider'],
    aliases: ['10k resistor', '10kohm', 'resistor 10k'],
    simulator: { part: 'wokwi-resistor', supported: true, attrs: { value: '10k' } },
    metadata: { electrical: true, noSupplyPins: true, resistanceOhm: 10000, tolerancePercent: 5, powerRatingW: 0.25 },
  }),

  def({
    id: 'capacitor-100nf-ceramic',
    name: '100 nF ceramic decoupling capacitor',
    category: 'passive',
    description: '100 nF (0.1 µF) 50 V ceramic capacitor placed between VCC and GND of every IC to suppress high-frequency supply noise.',
    pins: [
      pin('1', 'power', 'bidirectional', { required: true, aliases: ['+'] }),
      pin('2', 'ground', 'bidirectional', { required: true, aliases: ['-'] }),
    ],
    keywords: ['capacitor', 'decoupling', 'bypass', '100nf', '0.1uf', 'ceramic'],
    aliases: ['100nf capacitor', '0.1uf capacitor', 'decoupling capacitor', 'bypass capacitor'],
    simulator: {
      part: 'wokwi-capacitor',
      supported: true,
      attrs: { value: '100n' },
      notes: 'Two-terminal capacitor; both simulators model its value, not its ESR.',
    },
    metadata: { electrical: true, capacitanceF: 1e-7, voltageRatingV: 50, polarity: 'non-polar' },
  }),

  def({
    id: 'capacitor-1000uf-electrolytic',
    name: '1000 µF electrolytic bulk capacitor (16 V)',
    category: 'passive',
    description:
      'Polarised 1000 µF / 16 V electrolytic used as a bulk reservoir across a motor or servo supply to absorb inrush and stall transients. Observe polarity — reverse voltage destroys it.',
    pins: [
      pin('+', 'power', 'bidirectional', { required: true, aliases: ['POS'] }),
      pin('-', 'ground', 'bidirectional', { required: true, aliases: ['NEG'] }),
    ],
    keywords: ['capacitor', 'electrolytic', 'bulk', '1000uf', 'reservoir', 'smoothing'],
    aliases: ['1000uf capacitor', 'electrolytic capacitor', 'bulk capacitor'],
    simulator: {
      part: 'wokwi-capacitor',
      supported: true,
      attrs: { value: '1000u', voltage: '16' },
      notes:
        'Simulated as a two-terminal capacitor. Polarity is NOT modelled: on the bench the long leg goes to the supply and the striped leg to ground, or the part vents.',
    },
    metadata: { electrical: true, capacitanceF: 0.001, voltageRatingV: 16, polarity: 'polarised' },
  }),

  def({
    id: 'pushbutton-6mm',
    name: '6 mm tactile pushbutton',
    category: 'input_device',
    description:
      'Momentary 4-leg tactile switch. Legs on the same side are internally connected, so use one leg per side. Wire between a GPIO and GND with the internal pull-up enabled (reads LOW when pressed), or between GPIO and VCC with a pull-down.',
    minVoltage: 0,
    maxVoltage: 12,
    currentRequirements: { typicalMa: 0, maxMa: 50 },
    pins: [
      pin('1', 'digital', 'bidirectional', { required: true, aliases: ['A', 'LEG1'] }),
      pin('2', 'digital', 'bidirectional', { required: true, aliases: ['B', 'LEG2'] }),
    ],
    keywords: ['button', 'pushbutton', 'push button', 'switch', 'tactile', 'input', 'key'],
    aliases: ['pushbutton', 'push button', 'tact switch', 'momentary switch', 'button'],
    simulator: { part: 'wokwi-pushbutton', supported: true },
    metadata: { electrical: true, noSupplyPins: true, momentary: true, requiresPullup: true, recommendedDebounceMs: 20, internalLegPairs: 'legs 1-2 and 3-4 are bridged' },
  }),

  def({
    id: 'keypad-4x4-membrane',
    name: '4x4 membrane keypad',
    category: 'input_device',
    description:
      '16-key membrane matrix keypad (1-9, 0, *, #, A-D). Eight pins, not sixteen: the MCU drives the four row lines (R1-R4) low one at a time and reads the four column lines (C1-C4) through its internal pull-ups. A pressed key shorts one row to one column, so the firmware resolves the key from the (row, column) pair.',
    minVoltage: 0,
    maxVoltage: 5,
    currentRequirements: { typicalMa: 0, maxMa: 5 },
    pins: [
      pin('R1', 'digital', 'input', { required: true, signal: 'Row 1 drive (top row)', aliases: ['ROW1', '1'] }),
      pin('R2', 'digital', 'input', { required: true, signal: 'Row 2 drive', aliases: ['ROW2', '2'] }),
      pin('R3', 'digital', 'input', { required: true, signal: 'Row 3 drive', aliases: ['ROW3', '3'] }),
      pin('R4', 'digital', 'input', { required: true, signal: 'Row 4 drive (bottom row)', aliases: ['ROW4', '4'] }),
      pin('C1', 'digital', 'output', { required: true, signal: 'Column 1 sense (left column)', aliases: ['COL1', '5'] }),
      pin('C2', 'digital', 'output', { required: true, signal: 'Column 2 sense', aliases: ['COL2', '6'] }),
      pin('C3', 'digital', 'output', { required: true, signal: 'Column 3 sense', aliases: ['COL3', '7'] }),
      pin('C4', 'digital', 'output', { required: true, signal: 'Column 4 sense (right column)', aliases: ['COL4', '8'] }),
    ],
    keywords: ['keypad', '4x4 keypad', 'matrix keypad', 'membrane keypad', 'keyboard', 'pin entry', 'code entry', 'keys', 'hex keypad'],
    aliases: ['4x4 keypad', '4x4 matrix keypad', 'matrix keypad', 'membrane keypad', 'keypad', '16 key keypad'],
    simulator: {
      part: 'wokwi-membrane-keypad',
      supported: true,
      notes: 'Wokwi/Velxio pins: R1-R4 (rows, driven low by the MCU) and C1-C4 (columns, read with pull-ups).',
    },
    metadata: {
      electrical: true,
      noSupplyPins: true,
      requiresPullup: true,
      recommendedDebounceMs: 20,
      scanStyle: 'row-drive-column-sense',
      keypadMatrix: {
        rows: ['R1', 'R2', 'R3', 'R4'],
        columns: ['C1', 'C2', 'C3', 'C4'],
        keyMap: [
          ['1', '2', '3', 'A'],
          ['4', '5', '6', 'B'],
          ['7', '8', '9', 'C'],
          ['*', '0', '#', 'D'],
        ],
      },
    },
  }),

  def({
    id: 'potentiometer-10k',
    name: '10 kΩ rotary potentiometer',
    category: 'input_device',
    description: 'Three-terminal 10 kΩ linear-taper rotary potentiometer. Connect the two outer terminals to VCC and GND and read the wiper with an ADC pin for an analog input.',
    minVoltage: 0,
    maxVoltage: 5,
    pins: [
      pin('A', 'power', 'bidirectional', { required: true, signal: 'Counter-clockwise end to VCC', aliases: ['1', 'CCW'] }),
      pin('WIPER', 'analog', 'output', { required: true, signal: 'Center tap to an ADC pin', aliases: ['2', 'W', 'S', 'SIG'] }),
      pin('B', 'ground', 'bidirectional', { required: true, signal: 'Clockwise end to GND', aliases: ['3', 'CW'] }),
    ],
    keywords: ['potentiometer', 'pot', 'knob', 'analog input', 'trimmer', 'throttle', 'variable resistor'],
    aliases: ['potentiometer', 'pot', '10k pot', 'rotary potentiometer'],
    simulator: { part: 'wokwi-potentiometer', supported: true },
    metadata: { electrical: true, resistanceOhm: 10000, taper: 'linear', requiresAdc: true },
  }),

  def({
    id: 'slide-potentiometer-10k',
    name: '10 kΩ slide potentiometer (fader)',
    category: 'input_device',
    description:
      'Linear-taper 10 kΩ slide potentiometer (45 mm travel fader). Electrically identical to a rotary pot: the two ends go to VCC/GND and the wiper to an ADC pin, with position proportional to travel. Choose it over a rotary pot when the panel layout wants a visible, directly-labelled position — mixers, light dimmers, setpoint sliders.',
    minVoltage: 0,
    maxVoltage: 5,
    currentRequirements: { typicalMa: 0.5, maxMa: 1, note: 'Divider current only: 5 V / 10 kΩ.' },
    pins: [
      pin('A', 'power', 'bidirectional', { required: true, signal: 'One end of the track to VCC', aliases: ['1', 'CCW'] }),
      pin('WIPER', 'analog', 'output', { required: true, signal: 'Wiper to an ADC pin', aliases: ['2', 'W', 'S', 'SIG'] }),
      pin('B', 'ground', 'bidirectional', { required: true, signal: 'Other end of the track to GND', aliases: ['3', 'CW'] }),
    ],
    keywords: ['slide potentiometer', 'fader', 'slider', 'analog input', 'volume slider', 'mixer', 'linear pot'],
    aliases: ['slide pot', 'slider potentiometer', 'fader', 'slide potentiometer', 'linear potentiometer'],
    simulator: {
      part: 'wokwi-slide-potentiometer',
      supported: true,
      notes: 'Velxio maps the slider position to the SIG voltage — drag it and the ADC reading follows, same behaviour as the rotary pot.',
    },
    metadata: { electrical: true, resistanceOhm: 10000, taper: 'linear', requiresAdc: true, travelMm: 45 },
  }),

  def({
    id: 'dip-switch-8',
    name: '8-way DIP switch (SPST)',
    category: 'input_device',
    description:
      'Row of eight independent slide switches in a standard 0.1" DIP package — the classic way to give a device a hard-wired address, mode or configuration word that survives power cycles. Each pole is a separate pair of pins (nA/nB); wire one side to the MCU pin and the other to GND, and enable the internal pull-up so OFF reads HIGH and ON reads LOW.',
    minVoltage: 0,
    maxVoltage: 5,
    currentRequirements: { typicalMa: 0, maxMa: 25, note: 'Contact current only; 25 mA per pole absolute max — logic switching only.' },
    pins: [
      pin('1A', 'digital', 'bidirectional', { required: true, signal: 'Switch 1 pole, side A', aliases: ['1a'] }),
      pin('1B', 'digital', 'bidirectional', { required: true, signal: 'Switch 1 pole, side B (wire to GND)', aliases: ['1b'] }),
      pin('2A', 'digital', 'bidirectional', { required: true, signal: 'Switch 2 pole, side A', aliases: ['2a'] }),
      pin('2B', 'digital', 'bidirectional', { required: true, signal: 'Switch 2 pole, side B (wire to GND)', aliases: ['2b'] }),
      pin('3A', 'digital', 'bidirectional', { required: true, signal: 'Switch 3 pole, side A', aliases: ['3a'] }),
      pin('3B', 'digital', 'bidirectional', { required: true, signal: 'Switch 3 pole, side B (wire to GND)', aliases: ['3b'] }),
      pin('4A', 'digital', 'bidirectional', { required: true, signal: 'Switch 4 pole, side A', aliases: ['4a'] }),
      pin('4B', 'digital', 'bidirectional', { required: true, signal: 'Switch 4 pole, side B (wire to GND)', aliases: ['4b'] }),
      pin('5A', 'digital', 'bidirectional', { required: true, signal: 'Switch 5 pole, side A', aliases: ['5a'] }),
      pin('5B', 'digital', 'bidirectional', { required: true, signal: 'Switch 5 pole, side B (wire to GND)', aliases: ['5b'] }),
      pin('6A', 'digital', 'bidirectional', { required: true, signal: 'Switch 6 pole, side A', aliases: ['6a'] }),
      pin('6B', 'digital', 'bidirectional', { required: true, signal: 'Switch 6 pole, side B (wire to GND)', aliases: ['6b'] }),
      pin('7A', 'digital', 'bidirectional', { required: true, signal: 'Switch 7 pole, side A', aliases: ['7a'] }),
      pin('7B', 'digital', 'bidirectional', { required: true, signal: 'Switch 7 pole, side B (wire to GND)', aliases: ['7b'] }),
      pin('8A', 'digital', 'bidirectional', { required: true, signal: 'Switch 8 pole, side A', aliases: ['8a'] }),
      pin('8B', 'digital', 'bidirectional', { required: true, signal: 'Switch 8 pole, side B (wire to GND)', aliases: ['8b'] }),
    ],
    keywords: ['dip switch', 'configuration', 'address select', 'mode select', 'dipswitch', '8 way switch'],
    aliases: ['dip switch', 'dipswitch', 'dip-8', '8-way dip', 'configuration switch'],
    simulator: {
      part: 'wokwi-dip-switch-8',
      supported: true,
      notes: 'Velxio simulates all 8 poles independently (pin side A of each switch is the sense side — wire the B side to GND and pull A up).',
    },
    metadata: { electrical: true, noSupplyPins: true, poles: 8, latching: true, requiresPullup: true, recommendedDebounceMs: 20 },
  }),

  def({
    id: 'rotary-encoder-ky040',
    name: 'KY-040 rotary encoder module',
    category: 'input_device',
    description:
      'Incremental quadrature encoder with a detented knob (20 detents / 20 pulses per revolution) and an integrated push switch. CLK and DT are 90 degrees out of phase, so the direction is the phase relationship, not the pulse itself. The module carries 10 kOhm pull-ups on CLK and DT but not on SW, which needs the internal pull-up. Contact bounce is severe: debounce in firmware or add 0.1 uF capacitors.',
    voltage: 5,
    minVoltage: 3.3,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 1, maxMa: 5 },
    pins: [
      pin('CLK', 'digital', 'output', { required: true, signal: 'Quadrature channel A — read on an interrupt-capable pin', aliases: ['A', 'ENC_A', 'S1'], requiresCapability: ['interrupt'] }),
      pin('DT', 'digital', 'output', { required: true, signal: 'Quadrature channel B — sampled on the CLK edge to get direction', aliases: ['B', 'ENC_B', 'S2'] }),
      pin('SW', 'digital', 'output', { required: false, signal: 'Push switch, active LOW, needs an internal pull-up', aliases: ['SWITCH', 'BUTTON', 'KEY'] }),
      pin('+', 'power', 'power', { required: true, voltage: 5, signal: 'Supply 3.3–5 V', aliases: ['VCC', 'V+', '5V', '3V3'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
    ],
    compatibleMicrocontrollers: ['esp32-devkit-v1', 'arduino-uno-r3', 'arduino-nano'],
    keywords: ['rotary encoder', 'ky-040', 'ky040', 'knob', 'dial', 'quadrature', 'menu', 'volume'],
    aliases: ['ky040', 'ky-040', 'rotary encoder', 'encoder knob', 'digital potentiometer knob'],
    exampleUsage: ['Menu navigation on an OLED', 'Setpoint adjustment on a thermostat'],
    simulator: {
      part: 'wokwi-ky-040',
      supported: true,
      notes: 'Velxio generates real quadrature on CLK/DT as you turn the knob (angle/stepSize are part properties) and SW goes active LOW when pressed.',
    },
    metadata: {
      electrical: true,
      detentsPerRevolution: 20,
      pulsesPerRevolution: 20,
      onboardPullups: ['CLK', 'DT'],
      requiresPullup: 'SW only',
      recommendedDebounceMs: 5,
      dimensionsMm: { width: 26, length: 19, height: 1.6 },
    },
  }),

  def({
    id: 'toggle-switch-spdt',
    name: 'SPDT slide / toggle switch',
    category: 'input_device',
    description:
      'Single-pole double-throw mechanical switch: the common terminal is connected to exactly one of the two throws at all times. Use it as a hard power switch or as a latching logic input (common to the GPIO, one throw to GND, internal pull-up enabled).',
    minVoltage: 0,
    maxVoltage: 30,
    currentRequirements: { typicalMa: 0, maxMa: 3000, note: 'Contact rating; typical miniature switches handle 3 A at 30 V DC.' },
    pins: [
      pin('COM', 'digital', 'bidirectional', { required: true, signal: 'Common pole', aliases: ['C', '2', 'POLE'] }),
      pin('NO', 'digital', 'bidirectional', { required: true, signal: 'Throw 1 (position A)', aliases: ['1', 'A', 'ON1'] }),
      pin('NC', 'digital', 'bidirectional', { required: false, signal: 'Throw 2 (position B)', aliases: ['3', 'B', 'ON2'] }),
    ],
    keywords: ['switch', 'toggle', 'slide switch', 'spdt', 'power switch', 'latching'],
    aliases: ['toggle switch', 'slide switch', 'spdt switch', 'switch'],
    simulator: { part: 'wokwi-slide-switch', supported: true },
    metadata: { electrical: true, noSupplyPins: true, latching: true, requiresPullup: true, recommendedDebounceMs: 20 },
  }),

  def({
    id: 'limit-switch-microswitch',
    name: 'Lever microswitch (limit switch)',
    category: 'input_device',
    description:
      'Snap-action lever switch with common, normally-open and normally-closed terminals. Standard end-stop for motion systems. Wire NC-to-ground for a fail-safe end-stop: a broken wire then reads as "triggered" rather than as "clear".',
    minVoltage: 0,
    maxVoltage: 250,
    currentRequirements: { typicalMa: 0, maxMa: 5000 },
    pins: [
      pin('COM', 'digital', 'bidirectional', { required: true, signal: 'Common terminal', aliases: ['C', 'POLE'] }),
      pin('NO', 'digital', 'bidirectional', { required: false, signal: 'Normally open — closes when the lever is pressed', aliases: ['NORMALLY_OPEN'] }),
      pin('NC', 'digital', 'bidirectional', { required: false, signal: 'Normally closed — opens when the lever is pressed (fail-safe wiring)', aliases: ['NORMALLY_CLOSED'] }),
    ],
    keywords: ['limit switch', 'microswitch', 'end stop', 'endstop', 'lever switch', 'homing'],
    aliases: ['limit switch', 'microswitch', 'endstop', 'end stop switch'],
    simulator: { supported: false },
    metadata: { electrical: true, noSupplyPins: true, snapAction: true, requiresPullup: true, failSafeWiring: 'NC to ground' },
  }),

  def({
    id: 'joystick-module-2axis',
    name: '2-axis analog thumb joystick module',
    category: 'input_device',
    description:
      'PS2-style thumb joystick: two 10 kOhm potentiometers on X and Y plus a momentary push switch under the stick. Each axis reads roughly mid-scale at rest (about 512 on a 10-bit ADC) and needs a dead-band in firmware because the spring return is not exact.',
    voltage: 5,
    minVoltage: 3.3,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 1, maxMa: 5 },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, signal: 'Supply — sets the ADC full-scale reference for both axes', aliases: ['+5V', '+', 'VDD'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-'] }),
      pin('VRX', 'analog', 'output', { required: true, signal: 'X axis wiper voltage', aliases: ['VRx', 'X', 'HOR'] }),
      pin('VRY', 'analog', 'output', { required: true, signal: 'Y axis wiper voltage', aliases: ['VRy', 'Y', 'VER'] }),
      pin('SW', 'digital', 'output', { required: false, signal: 'Push switch, active LOW, needs an internal pull-up', aliases: ['SEL', 'BUTTON', 'KEY'] }),
    ],
    keywords: ['joystick', 'thumbstick', 'analog stick', '2-axis', 'ps2 joystick', 'control'],
    aliases: ['joystick', 'joystick module', 'thumb joystick', 'ky-023'],
    exampleUsage: ['Driving an RC car over Bluetooth', 'Pan/tilt camera control'],
    simulator: {
      part: 'wokwi-analog-joystick',
      supported: true,
      notes: 'Velxio wires VRX→HORZ, VRY→VERT, SW→SEL: drag the stick and the ADC reads move, the switch goes active LOW.',
    },
    metadata: { electrical: true, resistanceOhm: 10000, restValue10Bit: 512, requiresDeadband: true, requiresAdc: true },
  }),

  def({
    id: 'breadboard-830',
    name: '830-point solderless breadboard',
    category: 'prototyping',
    description:
      'Full-size solderless breadboard: 63 columns of 5-point tie rows split by a center DIP channel, plus two power rails per side. This is the wiring medium, not an electrical component — it does not appear in the connection graph.',
    pins: [
      pin('BUS_POSITIVE', 'power', 'power', { required: false, signal: 'Power rail (+)', aliases: ['+', 'RED_RAIL'] }),
      pin('BUS_NEGATIVE', 'ground', 'ground', { required: false, signal: 'Ground rail (-)', aliases: ['-', 'BLUE_RAIL'] }),
      pin('TIE_POINTS', 'other', 'bidirectional', { required: false, description: '830 solderless tie points in 5-point rows' }),
    ],
    keywords: ['breadboard', 'protoboard', 'prototyping', 'solderless'],
    aliases: ['breadboard', 'protoboard', '830 breadboard'],
    simulator: { part: 'wokwi-breadboard', supported: true },
    metadata: { electrical: false, participatesInWiring: false, tiePoints: 830, columns: 63, powerRails: 4 },
  }),

  def({
    id: 'jumper-wires-kit',
    name: 'Jumper wire kit (male-male / male-female)',
    category: 'prototyping',
    description:
      'Assorted 20 cm jumper wires for breadboard connections. Consumable wiring medium — not an electrical component and not represented in the connection graph.',
    pins: [],
    keywords: ['jumper', 'wires', 'jumper wires', 'dupont', 'cables', 'connections'],
    aliases: ['jumper wires', 'dupont wires', 'wires', 'cables'],
    metadata: { electrical: false, participatesInWiring: false, count: 65, gaugeAwg: 24, currentRatingMa: 1000 },
  }),
];
