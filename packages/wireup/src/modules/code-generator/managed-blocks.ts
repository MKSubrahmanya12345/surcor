/**
 * The machine-managed blocks of a sketch.
 *
 * Two regions of every generated source file belong to Wireup, not to the
 * model: the include list and the pin map. Both are re-derived from the
 * authoritative pin plan and library manifest whenever a fix lands, so the
 * firmware can never disagree with `diagram.json` or the wiring table.
 *
 * These primitives live apart from the sketch builders so a behaviour module
 * (see `behaviours/`) can compose a complete sketch without importing — and
 * therefore circularly depending on — the generic template.
 */

import type { LibraryRequirement } from '@/types/component';
import type { PinAssignment } from '@/types/wiring';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';

export const PIN_MAP_START = '// >>> WIREUP PIN MAP >>>';
export const PIN_MAP_END = '// <<< WIREUP PIN MAP <<<';
export const INCLUDES_START = '// >>> WIREUP INCLUDES >>>';
export const INCLUDES_END = '// <<< WIREUP INCLUDES <<<';

/* ------------------------------------------------------------------------- */
/* Pin constants                                                              */
/* ------------------------------------------------------------------------- */

/**
 * A peripheral pin name as a C identifier fragment.
 *
 * Pure-symbol pins are common on real parts (a buzzer's `+`/`-`, an op-amp's
 * `IN+`). Stripping the symbol used to leave an empty token, producing
 * `PIN_BUZZER_PASSIVE_1_` — a legal but meaningless identifier that also
 * collides with any other symbol pin on the same part.
 */
function pinToken(pinName: string): string {
  const upper = String(pinName).trim().toUpperCase();
  const direct = upper.replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (direct.length > 0) return direct;
  const spelled = upper
    .replace(/\+/g, 'PLUS')
    .replace(/-/g, 'MINUS')
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return spelled.length > 0 ? spelled : 'PIN';
}

export function constantName(assignment: PinAssignment): string {
  const target = assignment.targetInstanceId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `PIN_${target}_${pinToken(assignment.targetPin)}`;
}

/**
 * One assignment per (instance, pin) — the set the sketch is generated from.
 *
 * Two assignments for the same peripheral pin used to emit two `const int`
 * declarations with the *same* name, which is a redefinition error: the sketch
 * could not compile and the report gave no clue why. The first assignment wins
 * (it is the one the wiring graph was built from); the dropped duplicates are
 * returned so the caller can say so out loud.
 */
export function uniqueCodeAssignments(assignments: PinAssignment[]): {
  assignments: PinAssignment[];
  duplicates: { instanceId: string; pin: string; kept: string; dropped: string }[];
} {
  const kept: PinAssignment[] = [];
  const duplicates: { instanceId: string; pin: string; kept: string; dropped: string }[] = [];
  const seen = new Map<string, PinAssignment>();

  for (const assignment of assignments) {
    const key = `${assignment.targetInstanceId}\u0000${assignment.targetPin.toLowerCase()}`;
    const previous = seen.get(key);
    if (previous) {
      duplicates.push({
        instanceId: assignment.targetInstanceId,
        pin: assignment.targetPin,
        kept: previous.pin,
        dropped: assignment.pin,
      });
      continue;
    }
    seen.set(key, assignment);
    kept.push(assignment);
  }

  return { assignments: kept, duplicates };
}

/** The C++ literal for an MCU pin (`GPIO25` -> `25`, `A0` -> `A0`, `D5` -> `5`). */
export function pinLiteral(assignment: PinAssignment): string {
  const pin = assignment.pin;
  if (/^A\d+$/i.test(pin)) return pin.toUpperCase();
  if (assignment.pinNumber !== undefined) return String(assignment.pinNumber);
  const digits = pin.replace(/[^0-9]/g, '');
  return digits.length > 0 ? digits : `"${pin}"`;
}

export function pinConstantMap(assignments: PinAssignment[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const assignment of uniqueCodeAssignments(assignments).assignments) {
    map.set(constantName(assignment), pinLiteral(assignment));
  }
  return map;
}

/**
 * Start the I2C bus in the way this board actually wants.
 *
 * On an ESP32 (and most non-AVR cores) SDA/SCL can be routed to any pin, so
 * the sketch must hand the planned pins to `Wire.begin()` — otherwise the bus
 * comes up on the core's defaults and every I2C device silently fails to
 * answer. On AVR the pins are hard-wired and `Wire.begin()` takes no argument;
 * there the planned constants are checked instead, so a pin plan that put the
 * display anywhere other than A4/A5 says so at run time rather than presenting
 * a dead bus.
 */
export function i2cBusInitLines(input: {
  assignments: PinAssignment[];
  buses: { sdaPin: string; sclPin: string }[];
  profile?: McuProfile;
  linkIdentifier?: string;
}): string[] {
  const bus = input.buses[0];
  const candidates = uniqueCodeAssignments(input.assignments).assignments;
  const constantFor = (pin: string): string | undefined => {
    const match =
      candidates.find((assignment) => assignment.pin === pin && assignment.protocol === 'i2c') ??
      candidates.find((assignment) => assignment.pin === pin);
    return match ? constantName(match) : undefined;
  };

  if (!bus) return ['Wire.begin(); // start the I2C bus'];

  const sda = constantFor(bus.sdaPin);
  const scl = constantFor(bus.sclPin);

  if (input.profile?.i2cRemappable === true && sda && scl) {
    return [`Wire.begin(${sda}, ${scl}); // this board can route I2C to any pin — use the ones in the pin map`];
  }

  const fixed = input.profile?.i2c;
  if (fixed && sda && scl && input.linkIdentifier) {
    return [
      'Wire.begin(); // I2C bus: on this board SDA/SCL are hard-wired, not configurable',
      `if (${sda} != ${fixed.sda} || ${scl} != ${fixed.scl}) {`,
      `  ${input.linkIdentifier}.println("warn: this board's I2C bus is fixed to ${fixed.sda}/${fixed.scl} — move the device there");`,
      '}',
    ];
  }

  return ['Wire.begin(); // start the I2C bus before any I2C peripheral is initialised'];
}

export function isAnalogAssignment(assignment: PinAssignment): boolean {
  return assignment.protocol === 'adc' || assignment.signal === 'analog';
}

export function buildPinMapBlock(assignments: PinAssignment[], profile?: McuProfile): string {
  if (assignments.length === 0) {
    return [PIN_MAP_START, '// No MCU pin assignments were produced for this project.', PIN_MAP_END].join('\n');
  }

  const unique = uniqueCodeAssignments(assignments);
  const lines: string[] = [PIN_MAP_START];
  lines.push(`// Pin map generated by the Wireup pin planner for ${profile?.name ?? 'the selected microcontroller'}.`);
  lines.push('// These constants are authoritative: wiring, diagram.json and firmware all agree on them.');
  for (const duplicate of unique.duplicates) {
    lines.push(
      `// WARNING: ${duplicate.instanceId}.${duplicate.pin} was assigned twice (${duplicate.kept} and ${duplicate.dropped}); ` +
        `only ${duplicate.kept} is declared here. Fix the pin plan — a second declaration would not compile.`,
    );
  }

  const byTarget = new Map<string, PinAssignment[]>();
  for (const assignment of unique.assignments) {
    const list = byTarget.get(assignment.targetInstanceId) ?? [];
    list.push(assignment);
    byTarget.set(assignment.targetInstanceId, list);
  }

  for (const [instanceId, group] of byTarget) {
    lines.push('');
    lines.push(`// ${instanceId}`);
    for (const assignment of group) {
      const declaration = `const int ${constantName(assignment)} = ${pinLiteral(assignment)};`;
      const comment = `// ${assignment.pin} -> ${assignment.targetPin} (MCU ${assignment.direction}, ${assignment.protocol})`;
      lines.push(`${declaration}${' '.repeat(Math.max(1, 56 - declaration.length))}${comment}`);
    }
  }

  lines.push('');
  lines.push(PIN_MAP_END);
  return lines.join('\n');
}

/* ------------------------------------------------------------------------- */
/* Includes                                                                   */
/* ------------------------------------------------------------------------- */

export function includeStatement(library: LibraryRequirement): string | null {
  if (!library.import) return null;
  if (/^Arduino\.h$/i.test(library.import)) return null;
  const path = library.import.startsWith('<') ? library.import : `<${library.import}>`;
  return `#include ${path}`;
}

function isDependentHeaderRequired(importName: string, libraries: LibraryRequirement[]): boolean {
  if (!/^Adafruit_Sensor\.h$/i.test(importName)) return true;
  // Adafruit_Sensor.h is a dependency of sensor drivers, not of displays
  // such as SSD1306. Keeping it for every project makes clean builds fail.
  return libraries.some((library) => /^(Adafruit_(MPU6050|BME280|BMP280|BNO055|TSL2561|LSM|ADXL|HTU|SHT)|DHT)\S*\.h$/i.test(library.import));
}

export function buildIncludesBlock(libraries: LibraryRequirement[], platformIsEsp32: boolean): string {
  const statements: string[] = [];

  for (const library of libraries) {
    if (!isDependentHeaderRequired(library.import, libraries)) continue;
    const statement = includeStatement(library);
    if (!statement) continue;
    // Radio headers only exist in the ESP32 core.
    if (/BluetoothSerial\.h|BLEDevice\.h|WiFi\.h/i.test(library.import) && !platformIsEsp32) continue;
    if (!statements.includes(statement)) statements.push(statement);
  }

  const lines: string[] = [INCLUDES_START, '#include <Arduino.h>'];
  for (const statement of statements) lines.push(statement);
  lines.push(INCLUDES_END);
  return lines.join('\n');
}


/* ------------------------------------------------------------------------- */
/* Shared helpers                                                            */
/* ------------------------------------------------------------------------- */

export function safeIdentifier(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Render an I2C address as a hex literal the compiler accepts (`0x3C`). */
export function normaliseI2cAddress(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^0x[0-9a-f]+$/i.test(trimmed)) return `0x${trimmed.slice(2).toUpperCase()}`;
    if (/^[0-9a-f]{2}$/i.test(trimmed)) return `0x${trimmed.toUpperCase()}`;
    if (/^\d+$/.test(trimmed)) return `0x${Number(trimmed).toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return fallback;
}
