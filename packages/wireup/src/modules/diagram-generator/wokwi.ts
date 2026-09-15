/**
 * Wokwi adapter.
 *
 * Projects the simulator-agnostic `wireup-diagram` into the Wokwi `diagram.json`
 * shape. Swapping or adding another simulator target only means adding a file
 * like this one — the planners and the diagram generator stay untouched.
 *
 * Wokwi parts name their pins differently from the Wireup catalog (an SSD1306
 * exposes `DATA`/`CLK`/`VIN`, an Arduino digital pin is `4` rather than `D4`,
 * ground is `GND.1`). The per-part tables below translate catalog pin names
 * into the simulator's vocabulary so the exported diagram loads and simulates
 * without hand edits. Sources: docs.wokwi.com/parts/<part>.
 */

import type { Diagram, DiagramComponent } from '@/types/diagram';
import { isCadBenchComponent } from '@/modules/simulation/velxio-key';

export interface WokwiPart {
  type: string;
  id: string;
  top: number;
  left: number;
  attrs: Record<string, string>;
}

/** Wokwi connections are tuples: [from, to, colour, routeHints]. */
export type WokwiConnection = [string, string, string, string[]];

export interface WokwiDiagram {
  version: 1;
  author: string;
  editor: string;
  parts: WokwiPart[];
  connections: WokwiConnection[];
}

export interface WokwiSkippedPart {
  id: string;
  ref: string;
  reason: string;
  /**
   * Present when the part is NOT missing from the project, only from THIS
   * artifact: the emulator has no element for it, so it is carried as a CAD
   * bench part (exact shape, real pin anchors, no electrical model) in the
   * canonical Wireup diagram and in the Velxio/3D target. A plain Wokwi
   * `diagram.json` cannot represent it — inventing a `wokwi-*` type for it
   * would wire the firmware to pins that do not exist on the real part.
   */
  carriedAs?: 'cad-bench';
  /** The `/cad-catalog.json` key its geometry is registered under. */
  cadKey?: string;
}

export interface WokwiProjection {
  diagram: WokwiDiagram;
  skippedParts: WokwiSkippedPart[];
  skippedConnections: { id: string; reason: string }[];
  warnings: string[];
  /** CAD bench parts this projection kept in the project but cannot simulate. */
  cadBench: { id: string; ref: string; name: string }[];
}

/* ------------------------------------------------------------------------- */
/* Pin-name translation                                                       */
/* ------------------------------------------------------------------------- */

type PinMapper = (catalogPin: string) => string | undefined;

/** Case-insensitive lookup table mapper. */
function table(map: Record<string, string>): PinMapper {
  const lower = new Map(Object.entries(map).map(([key, value]) => [key.toLowerCase(), value]));
  return (pin) => lower.get(pin.toLowerCase());
}

/** Arduino AVR boards: `D7` → `7`, `A4` → `A4`, `GND` → `GND.1`, `3V3` → `3.3V`. */
function arduinoAvrPins(hasThreeVoltRail: boolean): PinMapper {
  return (pin) => {
    const upper = pin.toUpperCase();
    const digital = /^D(\d{1,2})$/.exec(upper);
    if (digital) return digital[1];
    if (/^\d{1,2}$/.test(upper)) return upper;
    if (/^A\d$/.test(upper)) return upper;
    switch (upper) {
      case 'GND':
        return 'GND.1';
      case '5V':
      case 'VCC':
        return '5V';
      case 'VIN':
      case 'RAW':
        return 'VIN';
      case '3V3':
      case '3.3V':
        return hasThreeVoltRail ? '3.3V' : undefined;
      case 'AREF':
        return 'AREF';
      case 'RESET':
      case 'RST':
        return 'RESET';
      case 'SDA':
        return 'A4';
      case 'SCL':
        return 'A5';
      default:
        return undefined;
    }
  };
}

/** ESP32 DevKit V1: `GPIO4` → `D4`, strapping/UART pins by their silk names. */
const esp32DevkitPins: PinMapper = (pin) => {
  const upper = pin.toUpperCase();
  const special: Record<string, string> = {
    GPIO1: 'TX0',
    GPIO3: 'RX0',
    GPIO16: 'RX2',
    GPIO17: 'TX2',
    GPIO36: 'VP',
    GPIO39: 'VN',
    '3V3': '3V3',
    '3.3V': '3V3',
    VIN: 'VIN',
    '5V': 'VIN',
    GND: 'GND.1',
    EN: 'EN',
    RESET: 'EN',
  };
  if (special[upper]) return special[upper];
  const gpio = /^GPIO(\d{1,2})$/.exec(upper);
  if (gpio) return `D${gpio[1]}`;
  const d = /^D(\d{1,2})$/.exec(upper);
  if (d) return upper;
  return undefined;
};

/** Identity mapper for parts whose Wokwi pins equal the catalog names. */
const identity: PinMapper = (pin) => pin;

/**
 * Catalog pin → Wokwi pin per simulator part type. Parts missing from this
 * table pass their pin names through unchanged (and a warning is raised).
 */
const PIN_MAPS: Record<string, PinMapper> = {
  'wokwi-arduino-uno': arduinoAvrPins(false),
  'wokwi-arduino-nano': arduinoAvrPins(true),
  'wokwi-arduino-mega': arduinoAvrPins(true),
  'wokwi-esp32-devkit-v1': esp32DevkitPins,
  // Wokwi's SSD1306 part uses CLK/DATA/VIN/GND (not SCL/SDA/VCC).
  'wokwi-ssd1306': table({ VCC: 'VIN', VIN: 'VIN', GND: 'GND', SCL: 'CLK', SDA: 'DATA', '3V3': '3V3' }),
  'board-ssd1306': table({ VCC: 'VCC', GND: 'GND', SCL: 'SCL', SDA: 'SDA' }),
  'wokwi-lcd1602': table({ VCC: 'VCC', GND: 'GND', SDA: 'SDA', SCL: 'SCL' }),
  'wokwi-lcd2004': table({ VCC: 'VCC', GND: 'GND', SDA: 'SDA', SCL: 'SCL' }),
  'wokwi-pushbutton': table({ '1': '1.r', '2': '2.r', A: '1.r', B: '2.r', LEG1: '1.r', LEG2: '2.r' }),
  'wokwi-led': table({ A: 'A', C: 'C' }),
  'wokwi-rgb-led': table({ R: 'R', G: 'G', B: 'B', CATHODE: 'COM', COM: 'COM' }),
  'wokwi-resistor': table({ '1': '1', '2': '2', A: '1', B: '2' }),
  // Wokwi's capacitor is a two-terminal part named 1/2; a polarised entry in
  // the catalog reaches it through the same two terminals.
  'wokwi-capacitor': table({ '1': '1', '2': '2', '+': '1', '-': '2', POS: '1', NEG: '2' }),
  'wokwi-capacitor-electrolytic': table({ '+': '+', '-': '\u2212', POS: '+', NEG: '\u2212', '1': '+', '2': '\u2212' }),
  'wokwi-servo': table({ SIGNAL: 'PWM', VCC: 'V+', GND: 'GND' }),
  'wokwi-hc-sr04': table({ VCC: 'VCC', TRIG: 'TRIG', ECHO: 'ECHO', GND: 'GND' }),
  'wokwi-dht22': table({ VCC: 'VCC', DATA: 'SDA', GND: 'GND' }),
  'wokwi-dht11': table({ VCC: 'VCC', DATA: 'SDA', GND: 'GND' }),
  'wokwi-buzzer': table({ '+': '2', '-': '1' }),
  'wokwi-potentiometer': table({ A: 'VCC', WIPER: 'SIG', B: 'GND' }),
  'wokwi-photoresistor-sensor': table({ VCC: 'VCC', GND: 'GND', DO: 'DO', AO: 'AO' }),
  'wokwi-neopixel': table({ VCC: 'VDD', GND: 'VSS', DIN: 'DIN', DOUT: 'DOUT' }),
  // The MPU-6050 element carries the auxiliary master bus too (XDA/XCL); the
  // catalog exposes those pins, so they must be mapped, not passed through.
  'wokwi-mpu6050': table({
    VCC: 'VCC',
    GND: 'GND',
    SCL: 'SCL',
    SDA: 'SDA',
    INT: 'INT',
    AD0: 'AD0',
    XDA: 'XDA',
    XCL: 'XCL',
  }),
  /*
   * The pinned Velxio build models the BMP280 (pressure + temperature) on a
   * four-pin module, so this maps the shared I2C/power pins and deliberately
   * leaves CSB/SDO unmapped: the BME280 catalog part has no emulator element
   * of its own, and a wire to a pin the element does not have is *reported*
   * rather than silently dropped. Keep `supported: false` until a humidity
   * model exists — this table only makes a future flip safe.
   */
  'wokwi-bme280': table({ VIN: 'VCC', VCC: 'VCC', GND: 'GND', SCL: 'SCL', SDA: 'SDA' }),
  'wokwi-pir-motion-sensor': table({ VCC: 'VCC', OUT: 'OUT', GND: 'GND' }),
  'wokwi-relay-module': table({ VCC: 'VCC', GND: 'GND', IN: 'IN', COM: 'COM', NO: 'NO', NC: 'NC' }),

  /* ---- Velxio-simulatable batch (verified against the vendored element set) -- */
  // The joystick element names its pins HORZ/VERT/SEL, not VRX/VRY/SW.
  'wokwi-analog-joystick': table({ VRX: 'HORZ', VRY: 'VERT', HORZ: 'HORZ', VERT: 'VERT', SW: 'SEL', SEL: 'SEL', VCC: 'VCC', GND: 'GND' }),
  // MQ-2 module pins AO/DO land on the element's AOUT/DOUT.
  'wokwi-gas-sensor': table({ VCC: 'VCC', GND: 'GND', AO: 'AOUT', A0: 'AOUT', AOUT: 'AOUT', DO: 'DOUT', D0: 'DOUT', DOUT: 'DOUT' }),
  // TSOP style names (OUT/VS) onto the element's DAT/VCC.
  'wokwi-ir-receiver': table({ OUT: 'DAT', DATA: 'DAT', DAT: 'DAT', VS: 'VCC', VCC: 'VCC', GND: 'GND' }),
  // HX711 module names DT/SCK as DAT/SCK on the element; the bridge-side pins
  // (E±/A±/B±) have no counterpart — those wires are reported, not silently mapped.
  'wokwi-hx711': table({ VCC: 'VCC', GND: 'GND', DT: 'DT', DAT: 'DT', DOUT: 'DT', SCK: 'SCK', CLK: 'SCK' }),
  // KY-040 supplies through a pin literally named "+" on the module.
  'wokwi-ky-040': table({ '+': 'VCC', VCC: 'VCC', GND: 'GND', CLK: 'CLK', DT: 'DT', SW: 'SW' }),
  // NTC/tilt comparator modules: three pins, element names match.
  'wokwi-ntc-temperature-sensor': table({ VCC: 'VCC', GND: 'GND', OUT: 'OUT', AO: 'OUT', SIG: 'OUT' }),
  'wokwi-tilt-switch': table({ VCC: 'VCC', GND: 'GND', OUT: 'OUT', DO: 'OUT', SIG: 'OUT' }),
  // NEMA17 coil names → the stepper element's coil pins.
  'wokwi-stepper-motor': table({ COIL_A1: 'A+', 'A+': 'A+', COIL_A2: 'A-', 'A-': 'A-', COIL_B1: 'B+', 'B+': 'B+', COIL_B2: 'B-', 'B-': 'B-' }),
  // Pololu A4988: silkscreen STP/EN/RST/SLP and the two grounds map onto the
  // element's STEP/ENABLE/RESET/SLEEP and GND/GND.2.
  'wokwi-a4988': table({
    VMOT: 'VMOT',
    GND_MOT: 'GND',
    GND: 'GND.2',
    GND_LOGIC: 'GND.2',
    '1A': '1A',
    '1B': '1B',
    '2A': '2A',
    '2B': '2B',
    VDD: 'VDD',
    STP: 'STEP',
    STEP: 'STEP',
    DIR: 'DIR',
    EN: 'ENABLE',
    ENABLE: 'ENABLE',
    MS1: 'MS1',
    MS2: 'MS2',
    MS3: 'MS3',
    RST: 'RESET',
    RESET: 'RESET',
    SLP: 'SLEEP',
    SLEEP: 'SLEEP',
  }),
  // Slide pot: same three-pin shape as the rotary pot.
  'wokwi-slide-potentiometer': table({ A: 'VCC', WIPER: 'SIG', B: 'GND' }),
  // DIP switch poles are named 1A/1B… on the catalog, 1a/1b… on the element.
  'wokwi-dip-switch-8': table(
    Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [
        [`${n}A`, `${n}a`],
        [`${n}B`, `${n}b`],
        [`${n}a`, `${n}a`],
        [`${n}b`, `${n}b`],
      ]),
    ),
  ),
  // 7-segment: shared catalog COM pin → the element's COM.1 (COM.2 exists too).
  'wokwi-7segment': table({ A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', F: 'F', G: 'G', DP: 'DP', DOT: 'DP', COM: 'COM.1', CATHODE: 'COM.1' }),
  // Bar graph: anodes/cathodes share the element's A1-A10/C1-C10 names.
  'wokwi-led-bar-graph': table(
    Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap((n) => [
        [`A${n}`, `A${n}`],
        [`C${n}`, `C${n}`],
        [`K${n}`, `C${n}`],
      ]),
    ),
  ),
  'wokwi-led-ring': table({ VCC: 'VCC', GND: 'GND', DIN: 'DIN', DOUT: 'DOUT' }),
  // SPI microSD: catalog SPI names onto the element's DI/DO.
  'wokwi-microsd-card': table({ VCC: 'VCC', GND: 'GND', CS: 'CS', MOSI: 'DI', DI: 'DI', MISO: 'DO', DO: 'DO', SCK: 'SCK', CD: 'CD' }),
  // DS1307 module: the element's supply pin is literally named "5V".
  'wokwi-ds1307': table({ VCC: '5V', '5V': '5V', GND: 'GND', SDA: 'SDA', SCL: 'SCL', SQW: 'SQW' }),
  // Slide switch: the element names its poles 1/2/3 with 2 the common — the
  // catalog's COM/NO/NC previously passed through and every wire was dropped
  // on import (caught by the verify:simulator end-to-end check).
  'wokwi-slide-switch': table({ COM: '2', C: '2', NO: '1', NC: '3', A: '1', B: '3' }),
  // Keypad rows/columns already match the element 1:1; pinned explicitly so a
  // rename upstream becomes a visible gate failure instead of a silent
  // pass-through.
  'wokwi-membrane-keypad': table({ R1: 'R1', R2: 'R2', R3: 'R3', R4: 'R4', C1: 'C1', C2: 'C2', C3: 'C3', C4: 'C4' }),
  // 8x8 matrix: DIN/DOUT/VCC/GND are already the element's names (note: VCC/GND,
  // NOT VDD/VSS like the single wokwi-neopixel). Pinned for the same reason.
  'wokwi-neopixel-matrix': table({ DIN: 'DIN', DOUT: 'DOUT', VCC: 'VCC', GND: 'GND' }),
  // ILI9341 module: silkscreen variations (SDI/MOSI, SDO/MISO, D/C or RS,
  // RST/RESET) all resolve onto the element's exact pin names.
  'wokwi-ili9341': table({
    VCC: 'VCC',
    GND: 'GND',
    CS: 'CS',
    RESET: 'RST',
    RST: 'RST',
    DC: 'D/C',
    'D/C': 'D/C',
    RS: 'D/C',
    SDI: 'MOSI',
    MOSI: 'MOSI',
    SCK: 'SCK',
    SCLK: 'SCK',
    LED: 'LED',
    SDO: 'MISO',
    MISO: 'MISO',
  }),
  // NEO-6M module TX/RX match the element directly.
  'wokwi-gps-neo6m': table({ VCC: 'VCC', GND: 'GND', TX: 'TX', TXD: 'TX', RX: 'RX', RXD: 'RX' }),
  // DS3231: I2C pins match; the module's SQW/32K outputs have no element
  // counterpart — wires to them are reported as unsupported, not silently mapped.
  'wokwi-ds3231': table({ VCC: 'VCC', GND: 'GND', SDA: 'SDA', SCL: 'SCL' }),

  /* ---- SPICE tier: the catalog's K (cathode) lands on the element's C; the
     schematic-symbol elements use single-letter pin names. ------------------ */
  'wokwi-diode-1n4007': table({ A: 'A', ANODE: 'A', K: 'C', CATHODE: 'C' }),
  'wokwi-diode-1n4148': table({ A: 'A', ANODE: 'A', K: 'C', CATHODE: 'C' }),
  'wokwi-diode-1n5819': table({ A: 'A', ANODE: 'A', K: 'C', CATHODE: 'C' }),
  // Schematic symbols: C/B/E and D/G/S are the element's exact pin names.
  'wokwi-bjt-2n2222': table({ B: 'B', BASE: 'B', C: 'C', COLLECTOR: 'C', E: 'E', EMITTER: 'E' }),
  'wokwi-mosfet-2n7000': table({ G: 'G', GATE: 'G', D: 'D', DRAIN: 'D', S: 'S', SOURCE: 'S' }),
  'wokwi-mosfet-irf540': table({ G: 'G', GATE: 'G', D: 'D', DRAIN: 'D', S: 'S', SOURCE: 'S' }),
  // PC817 element pins are AN/CAT/COL/EMIT.
  'wokwi-opto-pc817': table({ ANODE: 'AN', A: 'AN', CATHODE: 'CAT', K: 'CAT', COLLECTOR: 'COL', OUT: 'COL', EMITTER: 'EMIT' }),
  // Regulator: catalog IN/OUT onto the element's VIN/VOUT.
  'wokwi-reg-7805': table({ IN: 'VIN', VIN: 'VIN', GND: 'GND', OUT: 'VOUT', VOUT: 'VOUT' }),
  // Battery: '+' matches; the exporter renames '-' to the element's U+2212 minus.
  'wokwi-battery-9v': table({ '+': '+', '-': '-' }),
};

/** Attributes Wokwi needs for a part to behave like the catalog entry. */
const DEFAULT_ATTRS: Record<string, Record<string, string>> = {
  'wokwi-led': { color: 'red' },
  'wokwi-rgb-led': { common: 'cathode' },
  'wokwi-lcd1602': { pins: 'i2c' },
  'wokwi-lcd2004': { pins: 'i2c' },
};

/** Approximate Wokwi footprint (px) so parts are spaced without overlap. */
const PART_SIZE: Record<string, { width: number; height: number }> = {
  'wokwi-arduino-uno': { width: 290, height: 210 },
  'wokwi-arduino-nano': { width: 180, height: 70 },
  'wokwi-arduino-mega': { width: 390, height: 210 },
  'wokwi-esp32-devkit-v1': { width: 110, height: 210 },
  'wokwi-ssd1306': { width: 150, height: 120 },
  'wokwi-lcd1602': { width: 310, height: 140 },
  'wokwi-lcd2004': { width: 370, height: 180 },
  'wokwi-7segment': { width: 100, height: 160 },
  'wokwi-led-bar-graph': { width: 140, height: 100 },
  'wokwi-led-ring': { width: 110, height: 110 },
  'wokwi-neopixel-matrix': { width: 180, height: 180 },
  'wokwi-ili9341': { width: 220, height: 310 },
  'wokwi-gps-neo6m': { width: 110, height: 80 },
  'wokwi-ds3231': { width: 100, height: 70 },
  'wokwi-diode-1n4007': { width: 80, height: 40 },
  'wokwi-diode-1n4148': { width: 80, height: 40 },
  'wokwi-diode-1n5819': { width: 80, height: 40 },
  'wokwi-bjt-2n2222': { width: 72, height: 72 },
  'wokwi-mosfet-2n7000': { width: 72, height: 72 },
  'wokwi-mosfet-irf540': { width: 72, height: 72 },
  'wokwi-opto-pc817': { width: 90, height: 60 },
  'wokwi-battery-9v': { width: 70, height: 100 },
  'wokwi-reg-7805': { width: 72, height: 56 },
  'wokwi-servo': { width: 120, height: 90 },
  'wokwi-stepper-motor': { width: 140, height: 140 },
  'wokwi-a4988': { width: 72, height: 96 },
  'wokwi-hc-sr04': { width: 180, height: 100 },
  'wokwi-pir-motion-sensor': { width: 70, height: 90 },
  'wokwi-photoresistor-sensor': { width: 80, height: 90 },
  'wokwi-gas-sensor': { width: 90, height: 100 },
  'wokwi-ntc-temperature-sensor': { width: 70, height: 80 },
  'wokwi-tilt-switch': { width: 70, height: 80 },
  'wokwi-analog-joystick': { width: 110, height: 130 },
  'wokwi-ky-040': { width: 90, height: 90 },
  'wokwi-hx711': { width: 110, height: 80 },
  'wokwi-ir-receiver': { width: 50, height: 70 },
  'wokwi-dip-switch-8': { width: 160, height: 120 },
  'wokwi-slide-potentiometer': { width: 150, height: 60 },
  'wokwi-microsd-card': { width: 130, height: 110 },
  'wokwi-ds1307': { width: 130, height: 100 },
  'wokwi-breadboard': { width: 650, height: 210 },
  'wokwi-resistor': { width: 70, height: 30 },
  'wokwi-capacitor': { width: 60, height: 40 },
  'wokwi-led': { width: 50, height: 50 },
  'wokwi-pushbutton': { width: 50, height: 50 },
};

const COLOR_NAMES: { name: string; hexes: string[] }[] = [
  { name: 'red', hexes: ['#c62828', '#d32f2f', '#f44336', 'red'] },
  { name: 'black', hexes: ['#212121', '#000000', 'black'] },
  { name: 'blue', hexes: ['#1565c0', '#0277bd', '#2196f3', 'blue'] },
  { name: 'green', hexes: ['#2e7d32', '#558b2f', '#4caf50', 'green'] },
  { name: 'orange', hexes: ['#ef6c00', '#ff9800', 'orange'] },
  { name: 'purple', hexes: ['#6a1b9a', '#9c27b0', 'purple'] },
  { name: 'cyan', hexes: ['#00838f', '#00bcd4', 'cyan'] },
  { name: 'brown', hexes: ['#4e342e', '#795548', 'brown'] },
  { name: 'yellow', hexes: ['#f9a825', '#fdd835', 'yellow'] },
];

const PALETTE = ['green', 'blue', 'orange', 'purple', 'cyan', 'brown', 'yellow', 'white', 'grey'];

function colourFor(value: string | undefined, kind: string, index: number): string {
  if (kind === 'ground') return 'black';
  if (kind === 'power') return 'red';
  if (value) {
    const normalised = value.toLowerCase().trim();
    const match = COLOR_NAMES.find((entry) => entry.hexes.includes(normalised));
    if (match) return match.name;
  }
  return PALETTE[index % PALETTE.length] as string;
}

/* ------------------------------------------------------------------------- */
/* Placement                                                                  */
/* ------------------------------------------------------------------------- */

interface Placement {
  top: number;
  left: number;
}

/**
 * Lay parts out in three columns — inputs left, controller centre, outputs and
 * displays right — with the controller's footprint deciding the column width.
 * Wireup's own canvas coordinates are tuned for its renderer, not for the
 * physical size of Wokwi parts, so we do not reuse them.
 */
function placeParts(components: DiagramComponent[]): Map<string, Placement> {
  const columnOf = (component: DiagramComponent): number => {
    switch (component.category) {
      case 'microcontroller':
        return 1;
      case 'sensor':
      case 'input_device':
      case 'power':
      case 'communication':
        return 0;
      default:
        return 2;
    }
  };

  const columns: DiagramComponent[][] = [[], [], []];
  for (const component of components) columns[columnOf(component)]!.push(component);

  const GAP = 40;
  const placements = new Map<string, Placement>();
  let left = 0;
  for (const column of columns) {
    let top = 0;
    let widest = 0;
    for (const component of column) {
      const size = PART_SIZE[component.simulator?.part ?? ''] ?? { width: 100, height: 60 };
      placements.set(component.id, { top, left });
      top += size.height + GAP;
      widest = Math.max(widest, size.width);
    }
    left += (widest || 100) + GAP * 2;
  }
  return placements;
}

/* ------------------------------------------------------------------------- */
/* Projection                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Catalog metadata is deliberately simulator-neutral.  Normalize the small
 * set of Wokwi attribute names here; leaking catalog names into diagram.json
 * produces a file that parses but silently ignores the setting.
 */
function normalizeAttrs(part: string, attrs: Record<string, string>): Record<string, string> {
  const result = { ...attrs };
  if (part === 'wokwi-ssd1306' && result.i2cAddress !== undefined) {
    result.address = result.i2cAddress;
    delete result.i2cAddress;
  }
  return result;
}

/**
 * Catalog pin name → the simulator element's own pin name.
 *
 * Exported because the CAD bench wire builder in `velxio-project.ts` also has
 * to translate the SIMULATED end of a mixed wire (a pump wired through a
 * MOSFET to an Arduino pin): the part end keeps its catalog names, but the
 * simulated end must speak the element's vocabulary or Velxio drops the wire
 * on import. Returns undefined when the part has no mapping for that pin.
 */
export function translatePin(simulatorPart: string | undefined, pin: string): string | undefined {
  const mapper = PIN_MAPS[simulatorPart ?? ''] ?? identity;
  return mapper(pin);
}

/** Runtime guard for the actual Wokwi contract (useful at API boundaries). */
export function checkWokwiDiagram(value: unknown): value is WokwiDiagram {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WokwiDiagram>;
  if (candidate.version !== 1 || candidate.editor !== 'wokwi' || !Array.isArray(candidate.parts) || !Array.isArray(candidate.connections)) {
    return false;
  }
  const ids = new Set<string>();
  const partsAreValid = candidate.parts.every(
    (part) => {
      if (
        typeof part?.type !== 'string' ||
        /^board-velxio-/i.test(part.type) ||
        typeof part.id !== 'string' ||
        ids.has(part.id) ||
        !Number.isFinite(part.top) ||
        !Number.isFinite(part.left) ||
        !part.attrs ||
        typeof part.attrs !== 'object'
      ) return false;
      ids.add(part.id);
      return true;
    },
  );
  if (!partsAreValid) return false;

  return candidate.connections.every(
    (connection) => {
      if (
        !Array.isArray(connection) ||
        connection.length !== 4 ||
        typeof connection[0] !== 'string' ||
        typeof connection[1] !== 'string' ||
        typeof connection[2] !== 'string' ||
        !Array.isArray(connection[3]) ||
        !connection[3].every((hint) => typeof hint === 'string')
      ) return false;
      const endpoints = [connection[0], connection[1]] as string[];
      return endpoints.every((endpoint) => {
        const separator = endpoint.indexOf(':');
        return separator > 0 && ids.has(endpoint.slice(0, separator)) && endpoint.slice(separator + 1).length > 0;
      });
    },
  );
}

export function toWokwiDiagram(diagram: Diagram): WokwiProjection {
  const parts: WokwiPart[] = [];
  const skippedParts: WokwiProjection['skippedParts'] = [];
  const cadBench: WokwiProjection['cadBench'] = [];
  const skippedConnections: WokwiProjection['skippedConnections'] = [];
  const warnings: string[] = [];

  const included = new Map<string, DiagramComponent>();
  const unmappedTypes = new Set<string>();

  for (const component of diagram.components) {
    const simulatorPart = component.simulator?.part;
    if (!simulatorPart) {
      if (isCadBenchComponent(component)) {
        // Not an unknown: the catalog has a CAD spec for it, so the project
        // keeps the part and the 3D/canvas target draws it — but a Wokwi
        // diagram cannot, and a lookalike element would be a lie.
        cadBench.push({ id: component.id, ref: component.ref, name: component.name });
        skippedParts.push({
          id: component.id,
          ref: component.ref,
          reason:
            'No emulator element for this part in the pinned simulator build. Kept in the project as a CAD bench part ' +
            '(exact shape and pin anchors, no electrical simulation); a Wokwi diagram cannot draw it.',
          carriedAs: 'cad-bench',
          cadKey: component.ref,
        });
        continue;
      }
      skippedParts.push({
        id: component.id,
        ref: component.ref,
        reason: component.simulator?.notes ?? 'No simulator part mapping exists in the component catalog for this part.',
      });
      continue;
    }
    // `board-velxio-*` is Velxio's private canvas/export vocabulary, not a
    // native Wokwi part type. Passing it through makes diagram.json look valid
    // while Wokwi silently replaces or drops the actual controller. Never
    // substitute a fake board here; the warning tells the caller why it was
    // omitted and the canonical Wireup graph remains authoritative.
    if (/^board-velxio-/i.test(simulatorPart)) {
      skippedParts.push({
        id: component.id,
        ref: component.ref,
        reason: `Custom Velxio board type "${simulatorPart}" is not valid in a standalone Wokwi diagram; use the controller's native catalog mapping.`,
      });
      continue;
    }
    if (component.simulator?.supported === false) {
      // The catalog may still have a CAD spec for it; if so it is carried as a
      // CAD bench part rather than dropped, and the claim stays honest.
      const carried = isCadBenchComponent(component);
      if (carried) cadBench.push({ id: component.id, ref: component.ref, name: component.name });
      skippedParts.push({
        id: component.id,
        ref: component.ref,
        reason:
          component.simulator.notes ??
          `Part mapping "${simulatorPart}" is not verified as supported by the target simulator.`,
        ...(carried ? { carriedAs: 'cad-bench' as const, cadKey: component.ref } : {}),
      });
      continue;
    }
    // The wiring medium (breadboard, jumper wires) carries no connections in
    // the Wireup graph; a floating breadboard only clutters the simulator.
    if (component.metadata?.electrical === false) {
      skippedParts.push({ id: component.id, ref: component.ref, reason: 'Wiring medium — not part of the electrical graph.' });
      continue;
    }
    included.set(component.id, component);
  }

  const placements = placeParts([...included.values()]);
  for (const component of included.values()) {
    const simulatorPart = component.simulator?.part as string;
    const placement = placements.get(component.id) ?? { top: component.y, left: component.x };
    parts.push({
      type: simulatorPart,
      id: component.id,
      top: placement.top,
      left: placement.left,
      attrs: normalizeAttrs(simulatorPart, { ...(DEFAULT_ATTRS[simulatorPart] ?? {}), ...(component.simulator?.attrs ?? {}) }),
    });
    if (!PIN_MAPS[simulatorPart]) unmappedTypes.add(simulatorPart);
  }

  const translate = (component: DiagramComponent, pin: string): string | undefined =>
    translatePin(component.simulator?.part, pin);

  const connections: WokwiConnection[] = [];
  const seen = new Set<string>();
  let signalIndex = 0;
  for (const connection of diagram.connections) {
    const from = included.get(connection.from.component);
    const to = included.get(connection.to.component);
    if (!from || !to) {
      skippedConnections.push({
        id: connection.id,
        reason: `Endpoint part is not representable in the target simulator (${connection.from.component} → ${connection.to.component}).`,
      });
      continue;
    }
    if (from.id === to.id) {
      skippedConnections.push({ id: connection.id, reason: `Self-connection on ${from.id}.` });
      continue;
    }

    const fromPin = translate(from, connection.from.pin);
    const toPin = translate(to, connection.to.pin);
    if (!fromPin || !toPin) {
      const missing = !fromPin ? `${from.id}:${connection.from.pin}` : `${to.id}:${connection.to.pin}`;
      skippedConnections.push({ id: connection.id, reason: `Pin ${missing} has no equivalent on the simulator part.` });
      continue;
    }

    const key = [`${from.id}:${fromPin}`, `${to.id}:${toPin}`].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);

    const colour = colourFor(connection.wireColor, connection.kind, signalIndex);
    if (connection.kind === 'signal') signalIndex += 1;
    connections.push([`${from.id}:${fromPin}`, `${to.id}:${toPin}`, colour, []]);
  }

  /*
   * A skipped peripheral is an inconvenience; a skipped CONTROLLER means there
   * is no board on the canvas, no wires to it, and nothing to run the firmware
   * on. That must never be one line in a list of twenty — it goes first, and it
   * says what the downstream simulator will do about it.
   */
  const skippedController = diagram.components.find(
    (component) => component.category === 'microcontroller' && skippedParts.some((part) => part.id === component.id),
  );
  if (skippedController) {
    const reason = skippedParts.find((part) => part.id === skippedController.id)?.reason ?? 'no reason recorded';
    warnings.unshift(
      `The controller ${skippedController.id} (${skippedController.ref}) is not representable in the target simulator: ${reason} ` +
        'The exported diagram therefore has NO board — every wire to the MCU is dropped. Wireup does not substitute a lookalike board; this file is not runnable until a verified controller mapping exists.',
    );
  }
  if (!parts.some((part) => /^wokwi-(?:arduino|esp32|pi-pico|raspberry)/i.test(part.type))) {
    warnings.unshift('No native microcontroller board is present in this projection; it is not runnable until the selected controller has a verified target mapping.');
  }

  const carriedIds = skippedParts.filter((part) => part.carriedAs === 'cad-bench').map((part) => part.id);
  const droppedIds = skippedParts
    .filter((part) => part.carriedAs !== 'cad-bench' && !part.reason.startsWith('Wiring medium'))
    .map((part) => part.id);
  if (carriedIds.length > 0) {
    warnings.push(
      `${carriedIds.length} part(s) have no verified simulator element and are carried as CAD bench parts ` +
        `(real shape and pin anchors, no electrical model) in Wireup's own simulator and 3D view: ${carriedIds.join(', ')}. ` +
        'A plain Wokwi diagram cannot draw them; their wires are absent from THIS file only.',
    );
  }
  if (droppedIds.length > 0) {
    warnings.push(`${droppedIds.length} part(s) have no verified simulator mapping and were omitted: ${droppedIds.join(', ')}.`);
  }
  if (skippedConnections.length > 0) {
    warnings.push(`${skippedConnections.length} connection(s) were dropped because an endpoint is not representable in the simulator.`);
  }
  if (unmappedTypes.size > 0) {
    warnings.push(
      `Pin names for ${[...unmappedTypes].join(', ')} are passed through from the Wireup catalog — confirm they match the simulator part before running.`,
    );
  }

  return {
    diagram: {
      version: 1,
      author: 'Wireup',
      editor: 'wokwi',
      parts,
      connections,
    },
    skippedParts,
    skippedConnections,
    warnings,
    cadBench,
  };
}
