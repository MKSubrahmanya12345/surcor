/** Actuator seed entries. */

import type { ComponentDefinition } from '@/types/component';

import { def, pin } from './helpers';

export const ACTUATORS: ComponentDefinition[] = [
  def({
    id: 'led-5mm',
    name: '5 mm LED',
    category: 'actuator',
    description:
      'Standard 5 mm through-hole LED. Forward voltage ~1.8–2.2 V (red/amber) or ~3.0–3.4 V (blue/white) at 20 mA. Always driven through a current-limiting series resistor: 220 Ω from a 5 V pin, 100–150 Ω from a 3.3 V pin.',
    voltage: 2.1,
    minVoltage: 1.8,
    maxVoltage: 3.4,
    currentRequirements: { typicalMa: 10, maxMa: 20 },
    pins: [
      pin('A', 'digital', 'input', { required: true, signal: 'Anode — long leg, to the MCU pin through a resistor', aliases: ['+', 'ANODE', 'LONG'] }),
      pin('C', 'ground', 'input', { required: true, signal: 'Cathode — short leg, to GND', aliases: ['-', 'CATHODE', 'SHORT'] }),
    ],
    keywords: ['led', 'light', 'indicator', 'lamp'],
    aliases: ['led', '5mm led', 'light emitting diode', 'indicator led'],
    simulator: { part: 'wokwi-led', supported: true },
    metadata: { electrical: true, polarity: 'A=anode, C=cathode', requiresSeriesResistor: true, seriesResistorOhmAt5v: 220, seriesResistorOhmAt3v3: 100 },
  }),

  def({
    id: 'rgb-led-common-cathode',
    name: 'RGB LED (common cathode)',
    category: 'actuator',
    description:
      'Four-lead RGB LED sharing a common cathode. Each colour channel needs its own series resistor (220 Ω at 5 V) and its own PWM-capable MCU pin for mixing.',
    voltage: 2.2,
    minVoltage: 1.8,
    maxVoltage: 3.4,
    currentRequirements: { typicalMa: 20, maxMa: 60, note: 'Up to 20 mA per channel.' },
    pins: [
      pin('R', 'pwm', 'input', { required: true, signal: 'Red anode (through a resistor)', aliases: ['RED'] }),
      pin('G', 'pwm', 'input', { required: true, signal: 'Green anode (through a resistor)', aliases: ['GREEN'] }),
      pin('B', 'pwm', 'input', { required: true, signal: 'Blue anode (through a resistor)', aliases: ['BLUE'] }),
      pin('CATHODE', 'ground', 'input', { required: true, signal: 'Common cathode to GND', aliases: ['-', 'GND', 'COMMON'] }),
    ],
    keywords: ['rgb led', 'color led', 'colour led', 'mood light', 'status light'],
    aliases: ['rgb led', 'rgb light', 'common cathode rgb led'],
    simulator: {
      part: 'wokwi-rgb-led',
      supported: true,
      notes: 'Three independently PWM-driven channels on the element (common cathode, `common: cathode`).',
    },
    metadata: { electrical: true, requiresSeriesResistor: true, seriesResistorOhmAt5v: 220, pwmRequired: true },
  }),

  def({
    id: 'buzzer-active-5v',
    name: 'Active buzzer (5 V)',
    category: 'actuator',
    description:
      'Self-oscillating piezo buzzer: drive the + terminal HIGH/LOW for on/off — no PWM tone generation required. ~30 mA at 5 V, so it can be driven directly from a 5 V logic pin but should use a transistor on 3.3 V boards.',
    voltage: 5,
    minVoltage: 3.3,
    maxVoltage: 6,
    currentRequirements: { typicalMa: 30, maxMa: 40 },
    pins: [
      pin('+', 'digital', 'input', { required: true, signal: 'Positive drive input', aliases: ['S', 'SIG', 'I/O', 'POS'] }),
      pin('-', 'ground', 'input', { required: true, signal: 'Negative to GND', aliases: ['GND', 'NEG'] }),
    ],
    keywords: ['buzzer', 'alarm', 'beep', 'sound', 'speaker', 'audio alert'],
    aliases: ['buzzer', 'active buzzer', 'beeper'],
    simulator: { part: 'wokwi-buzzer', supported: true, notes: 'Simulated as a passive buzzer — tone generation differs.' },
    metadata: { electrical: true, active: true, oscillationFrequencyHz: 2300 },
  }),

  def({
    id: 'buzzer-passive',
    name: 'Passive buzzer / piezo element',
    category: 'actuator',
    description:
      'Non-oscillating piezo element: the MCU must generate the tone with PWM/timer output (typically 2–4 kHz). Connect the drive pin through the element to GND.',
    minVoltage: 1.5,
    maxVoltage: 15,
    currentRequirements: { typicalMa: 20, maxMa: 30 },
    pins: [
      pin('+', 'pwm', 'input', { required: true, signal: 'PWM tone input', aliases: ['S', 'SIG'] }),
      pin('-', 'ground', 'input', { required: true, aliases: ['GND'] }),
    ],
    libraryRequirements: [{ name: 'tone()', import: 'Arduino.h', manager: 'arduino', purpose: 'Generates the square wave', builtIn: true }],
    keywords: ['buzzer', 'passive buzzer', 'piezo', 'tone', 'melody', 'sound'],
    aliases: ['passive buzzer', 'piezo element', 'piezo buzzer'],
    simulator: { part: 'wokwi-buzzer', supported: true },
    metadata: { electrical: true, active: false, requiresPwm: true },
  }),

  def({
    id: 'relay-module-5v-1ch',
    name: '5 V single-channel relay module (opto-isolated)',
    category: 'actuator',
    description:
      'Opto-isolated relay module switching up to 250 VAC / 30 VDC at 10 A. IN is typically active LOW and needs ~10 mA at 5 V. Provides COM / NO / NC screw terminals for the load side, electrically isolated from the MCU side.',
    voltage: 5,
    minVoltage: 4.5,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 70, maxMa: 90, note: 'Coil + opto current; not available from a 3.3 V MCU pin.' },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'DC+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'DC-'] }),
      pin('IN', 'digital', 'input', { required: true, signal: 'Control input, active LOW on most modules', aliases: ['SIG', 'S'] }),
      pin('COM', 'other', 'bidirectional', { required: true, signal: 'Load common terminal', aliases: ['C'] }),
      pin('NO', 'other', 'bidirectional', { required: true, signal: 'Normally open load terminal', aliases: ['N/O'] }),
      pin('NC', 'other', 'bidirectional', { required: false, signal: 'Normally closed load terminal', aliases: ['N/C'] }),
    ],
    keywords: ['relay', 'switch', 'mains', 'high current', 'pump', 'lamp', 'contactor'],
    aliases: ['relay', 'relay module', '5v relay', '1 channel relay'],
    simulator: {
      supported: false,
      notes:
        'The bundled Velxio bare-relay element (COIL+/COIL-/COM/NO/NC) only DRAWS the relay: it has no registered ' +
        'simulation behaviour and no netlist mapper, so on the canvas it is dead — the coil does not pull in. It also ' +
        'has no VCC/GND/IN module pins to fake. Keep the module for the bench; simulate switching with a transistor ' +
        'stage and an LED probe instead.',
    },
    metadata: {
      electrical: true,
      activeLevel: 'low',
      contactRating: '250 VAC / 30 VDC, 10 A',
      isolation: 'opto-coupler',
      inPinLogicNote: 'A 3.3 V MCU cannot pull IN low enough on many opto modules — use a 5 V supply for VCC and verify the trigger level, or add a transistor.',
    },
  }),

  def({
    id: 'neopixel-ws2812b-strip',
    name: 'WS2812B addressable LED strip (NeoPixel)',
    category: 'actuator',
    description:
      'Single-wire 800 kHz addressable RGB LEDs, 5 V supply, up to ~60 mA per LED at full white. Data in is a strict timing protocol; level shift from a 3.3 V MCU and inject power at both ends for long runs.',
    voltage: 5,
    minVoltage: 4.5,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 20, maxMa: 60, note: 'Per LED at full white; budget 60 mA x LED count.' },
    pins: [
      pin('DIN', 'digital', 'input', { required: true, signal: '800 kHz data in', aliases: ['DI', 'DATA', 'IN'] }),
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+5V', '+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
      pin('DOUT', 'digital', 'output', { required: false, signal: 'Data out to the next segment', aliases: ['DO'] }),
    ],
    libraryRequirements: [
      { name: 'Adafruit NeoPixel', import: 'Adafruit_NeoPixel.h', manager: 'arduino', repository: 'https://github.com/adafruit/Adafruit_NeoPixel', purpose: 'WS2812B timing and colour control' },
    ],
    keywords: ['neopixel', 'ws2812', 'ws2812b', 'addressable led', 'led strip', 'rgb strip'],
    aliases: ['neopixel', 'ws2812b', 'led strip', 'addressable leds'],
    simulator: {
      part: 'wokwi-neopixel',
      supported: true,
      notes:
        'Simulated as ONE addressable pixel (DIN/DOUT/VDD/VSS match the strip pin for pin). ' +
        'A real strip needs one part per pixel in the simulator, or a bench build with the full length.',
    },
    metadata: { electrical: true, levelShiftFrom3v3: true, protocol: 'ws2812b-single-wire', ledCount: 'per segment' },
  }),

  def({
    id: 'led-ring-ws2812-8',
    name: 'WS2812 8-LED ring (NeoPixel ring)',
    category: 'actuator',
    description:
      'Circular PCB carrying 8 addressable WS2812B LEDs chained on a single data line. Same electrical rules as a NeoPixel strip: 5 V supply, 800 kHz timing, one pin drives the whole ring, DOUT exists for chaining a second ring. Full-white draw is ~0.5 A (8 × 60 mA) — budget it on the 5 V rail, and add ~470 µF across the ring supply.',
    voltage: 5,
    minVoltage: 4.5,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 60, maxMa: 480, note: 'Per LED at full white ~60 mA; 8 LEDs ≈ 0.5 A worst case.' },
    pins: [
      pin('DIN', 'digital', 'input', { required: true, signal: '800 kHz data in', aliases: ['DI', 'DATA', 'IN'] }),
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+5V', '+', 'VDD'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'VSS'] }),
      pin('DOUT', 'digital', 'output', { required: false, signal: 'Data out to the next ring in the chain', aliases: ['DO'] }),
    ],
    libraryRequirements: [
      { name: 'Adafruit NeoPixel', import: 'Adafruit_NeoPixel.h', manager: 'arduino', repository: 'https://github.com/adafruit/Adafruit_NeoPixel', purpose: 'WS2812B timing and colour control' },
    ],
    keywords: ['neopixel ring', 'ws2812 ring', 'led ring', 'addressable ring', 'status ring'],
    aliases: ['led ring', 'neopixel ring', 'ws2812 ring', '8-pixel ring', 'pixel ring'],
    simulator: {
      part: 'wokwi-led-ring',
      supported: true,
      notes: 'Velxio renders and drives all 8 pixels from DIN (VCC/GND/DIN/DOUT match pin for pin) — the ring is fully interactive, unlike a long strip which is modelled one pixel at a time.',
    },
    metadata: { electrical: true, levelShiftFrom3v3: true, protocol: 'ws2812b-single-wire', ledCount: 8, diameterMm: 50 },
  }),

  def({
    id: 'led-matrix-ws2812-8x8',
    name: 'WS2812B 8x8 LED matrix (NeoPixel matrix, 64 pixels)',
    category: 'actuator',
    description:
      '64 addressable WS2812B LEDs in an 8x8 grid on one data line — the same single-pin protocol as the strip and ring, scrolled into a matrix. One pin drives every pixel (index = row*8 + col with the common left-to-right, top-to-bottom wiring; cheap boards vary, so verify direction before fixing a layout). Full-white draw is ~3.8 A: budget a dedicated 5 V supply, inject power at the connector, and keep data runs short with a ~330-470 ohm series resistor and a ~1000 uF cap across the supply.',
    voltage: 5,
    minVoltage: 4.5,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 60, maxMa: 3840, note: 'Per pixel ~60 mA at full white; 64 pixels ≈ 3.8 A worst case — never from a USB pin.' },
    pins: [
      pin('DIN', 'digital', 'input', { required: true, signal: '800 kHz data in', aliases: ['DI', 'DATA', 'IN'] }),
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+5V', '+', 'VDD'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'VSS'] }),
      pin('DOUT', 'digital', 'output', { required: false, signal: 'Data out to the next matrix in the chain', aliases: ['DO'] }),
    ],
    libraryRequirements: [
      { name: 'Adafruit NeoPixel', import: 'Adafruit_NeoPixel.h', manager: 'arduino', repository: 'https://github.com/adafruit/Adafruit_NeoPixel', purpose: 'WS2812B timing and colour control' },
    ],
    keywords: ['neopixel matrix', 'ws2812 matrix', 'led matrix', '8x8 matrix', 'pixel matrix', 'addressable matrix'],
    aliases: ['neopixel matrix', 'ws2812 matrix', '8x8 matrix', 'led matrix', 'pixel matrix'],
    simulator: {
      part: 'wokwi-neopixel-matrix',
      supported: true,
      notes: 'Velxio decodes the WS2812B stream on DIN and lights each pixel at its (row, col) — set the part rows/cols to match the Adafruit_NeoPixel constructor. Power injection and current-vs-brightness are not modelled.',
    },
    metadata: { electrical: true, levelShiftFrom3v3: true, protocol: 'ws2812b-single-wire', ledCount: 64, columns: 8, rows: 8 },
  }),
];
