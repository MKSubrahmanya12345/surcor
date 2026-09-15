/**
 * Firmware hygiene passes.
 *
 * Deterministic repairs applied to model-authored sketches after the pin map
 * and include block have been synchronised. Each pass targets a defect class
 * that showed up in real generations and that a compiler or simulator will not
 * forgive:
 *
 *   - I2C addresses written as decimals (`#define OLED_ADDRESS 7`) instead of
 *     the hex address the catalog documents (`0x3C`);
 *   - `Wire.begin()` missing even though an I2C peripheral is driven;
 *   - headers included that no library in the plan provides (a stray
 *     `Adafruit_Sensor.h` breaks the build on a clean machine);
 *   - the same header included twice (once in the managed block, once by hand).
 */

import type { ComponentDefinition, ComponentSelection, LibraryRequirement } from '@/types/component';

import { INCLUDES_END, INCLUDES_START, normaliseI2cAddress } from './templates';

export interface HygieneContext {
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  libraries: LibraryRequirement[];
}

export interface HygieneResult {
  content: string;
  notes: string[];
}

interface I2cDevice {
  instanceId: string;
  componentId: string;
  address: string;
  roleWords: string[];
}

function i2cDevices(ctx: HygieneContext): I2cDevice[] {
  const devices: I2cDevice[] = [];
  for (const selection of ctx.selections) {
    const definition = ctx.catalog.find((component) => component.id === selection.componentId);
    if (!definition) continue;
    const protocols = (definition.communicationProtocols ?? []).map((protocol) => String(protocol).toLowerCase());
    if (!protocols.includes('i2c')) continue;
    const raw = definition.metadata.i2cAddress;
    if (raw === undefined) continue;
    const address = normaliseI2cAddress(raw, '');
    if (!address) continue;
    const id = `${definition.id} ${definition.name}`.toLowerCase();
    const roleWords: string[] = [];
    if (/oled|ssd1306/.test(id)) roleWords.push('OLED', 'SSD1306', 'DISPLAY', 'SCREEN');
    if (/lcd|1602|2004/.test(id)) roleWords.push('LCD', 'DISPLAY', 'SCREEN');
    if (/mpu6050|imu/.test(id)) roleWords.push('MPU', 'MPU6050', 'IMU');
    if (/bme|bmp/.test(id)) roleWords.push('BME', 'BMP');
    if (/rtc|ds3231/.test(id)) roleWords.push('RTC');
    for (const instance of selection.instances) {
      devices.push({ instanceId: instance.instanceId, componentId: definition.id, address, roleWords });
    }
  }
  return devices;
}

function usesI2c(content: string, ctx: HygieneContext): boolean {
  if (i2cDevices(ctx).length > 0) return true;
  return ctx.libraries.some((library) => /^Wire\.h$/i.test(library.import)) && /Wire\.h/.test(content);
}

/* ------------------------------------------------------------------------- */
/* 1. I2C address literals                                                    */
/* ------------------------------------------------------------------------- */

const ADDRESS_PATTERN =
  /(#define\s+([A-Za-z_][A-Za-z0-9_]*(?:ADDR|ADDRESS)[A-Za-z0-9_]*)\s+)([A-Za-z0-9_]+)|(\bconst\s+(?:uint8_t|int|byte|unsigned\s+char)\s+([A-Za-z_][A-Za-z0-9_]*(?:ADDR|ADDRESS)[A-Za-z0-9_]*)\s*=\s*)([A-Za-z0-9_]+)(\s*;)/g;

export function fixI2cAddressLiterals(content: string, ctx: HygieneContext): { content: string; fixed: { name: string; from: string; to: string }[] } {
  const devices = i2cDevices(ctx);
  if (devices.length === 0) return { content, fixed: [] };
  const fixed: { name: string; from: string; to: string }[] = [];

  const result = content.replace(ADDRESS_PATTERN, (whole, definePrefix, defineName, defineValue, constPrefix, constName, constValue, constSuffix) => {
    const name: string = defineName ?? constName ?? '';
    const value: string = defineValue ?? constValue ?? '';
    if (!name || !value) return whole;
    if (/^0x[0-9a-f]+$/i.test(value)) return whole; // already hex
    if (!/^\d+$/.test(value)) return whole; // a macro/identifier — leave it

    const upper = name.toUpperCase();
    const matching = devices.filter((device) => device.roleWords.some((word) => upper.includes(word)));
    const device = matching[0] ?? (devices.length === 1 ? devices[0] : undefined);
    if (!device) return whole;

    // A plausible decimal 7-bit address that equals the catalog address is fine as-is.
    if (Number(value) === Number.parseInt(device.address, 16)) return whole;

    fixed.push({ name, from: value, to: device.address });
    if (definePrefix !== undefined) return `${definePrefix}${device.address}`;
    return `${constPrefix}${device.address}${constSuffix}`;
  });

  return { content: result, fixed };
}

/* ------------------------------------------------------------------------- */
/* 2. Wire.begin()                                                            */
/* ------------------------------------------------------------------------- */

export function ensureWireBegin(content: string, ctx: HygieneContext): { content: string; added: boolean } {
  if (!usesI2c(content, ctx)) return { content, added: false };
  if (/\bWire\s*\.\s*begin\s*\(/.test(content)) return { content, added: false };

  const setupMatch = /void\s+setup\s*\(\s*(?:void)?\s*\)\s*\{/.exec(content);
  if (!setupMatch) return { content, added: false };
  const bodyStart = setupMatch.index + setupMatch[0].length;

  // Prefer the line right after Serial.begin(...) inside setup(); otherwise the first statement.
  const setupEnd = findBlockEnd(content, bodyStart - 1);
  const body = content.slice(bodyStart, setupEnd);
  const serialBegin = /^[ \t]*Serial\s*\.\s*begin\s*\([^;]*\)\s*;[^\n]*\n/m.exec(body);
  const indent = (/\n([ \t]+)\S/.exec(body)?.[1]) ?? '  ';
  const line = `${indent}Wire.begin(); // start the I2C bus before any I2C peripheral is initialised\n`;

  let insertAt: number;
  if (serialBegin) insertAt = bodyStart + serialBegin.index + serialBegin[0].length;
  else {
    const newline = content.indexOf('\n', bodyStart);
    insertAt = newline === -1 ? bodyStart : newline + 1;
  }
  return { content: `${content.slice(0, insertAt)}${line}${content.slice(insertAt)}`, added: true };
}

function findBlockEnd(content: string, openBraceIndex: number): number {
  let depth = 0;
  for (let i = openBraceIndex; i < content.length; i += 1) {
    const char = content[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return content.length;
}

/* ------------------------------------------------------------------------- */
/* 3. Includes                                                                */
/* ------------------------------------------------------------------------- */

/** Headers that are always available on the Arduino toolchain and never need a library entry. */
const TOOLCHAIN_HEADERS =
  /^(Arduino|Wire|SPI|EEPROM|SoftwareSerial|Servo|math|stdint|stdlib|string|stdio|avr\/.*|util\/.*|esp_.*|freertos\/.*|WiFi|BluetoothSerial|BLEDevice|BLEServer|BLEUtils|BLE2902|Preferences|HardwareSerial|pgmspace|limits|ctype)\.h$/i;

/** Headers that are only meaningful together with a specific driver family. */
const DEPENDENT_HEADERS: { header: RegExp; requires: RegExp }[] = [
  { header: /^Adafruit_Sensor\.h$/i, requires: /^(Adafruit_(MPU6050|BME280|BMP280|BNO055|TSL2561|LSM|ADXL|HTU|SHT)|DHT)\S*\.h$/i },
];

export function pruneIncludes(content: string, ctx: HygieneContext): { content: string; removed: string[] } {
  const planned = new Set(ctx.libraries.map((library) => library.import.replace(/[<>"]/g, '').toLowerCase()));
  const removed: string[] = [];

  const blockStart = content.indexOf(INCLUDES_START);
  const blockEnd = content.indexOf(INCLUDES_END);
  const managed: [number, number] | null = blockStart >= 0 && blockEnd > blockStart ? [blockStart, blockEnd + INCLUDES_END.length] : null;

  const seenInBlock = new Set<string>();
  if (managed) {
    for (const match of content.slice(managed[0], managed[1]).matchAll(/#\s*include\s*[<"]([^>"]+)[>"]/g)) {
      seenInBlock.add((match[1] ?? '').toLowerCase());
    }
  }

  const lines = content.split('\n');
  let offset = 0;
  const kept: string[] = [];
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;
    const match = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/.exec(line);
    if (!match) {
      kept.push(line);
      continue;
    }
    const header = (match[1] ?? '').trim();
    const lower = header.toLowerCase();
    const insideManaged = managed !== null && lineStart >= managed[0] && lineStart < managed[1];
    if (insideManaged) {
      kept.push(line);
      continue;
    }
    // Duplicate of a managed include.
    if (seenInBlock.has(lower)) {
      removed.push(header);
      continue;
    }
    // A dependency header nobody in the plan depends on.
    const dependent = DEPENDENT_HEADERS.find((entry) => entry.header.test(header));
    if (dependent && ![...planned].some((name) => name !== lower && dependent.requires.test(name))) {
      removed.push(header);
      continue;
    }
    void TOOLCHAIN_HEADERS;
    kept.push(line);
  }

  return { content: removed.length > 0 ? kept.join('\n') : content, removed };
}

/* ------------------------------------------------------------------------- */
/* Entry point                                                                */
/* ------------------------------------------------------------------------- */

export function applyFirmwareHygiene(content: string, ctx: HygieneContext): HygieneResult {
  const notes: string[] = [];
  let output = content;

  const addresses = fixI2cAddressLiterals(output, ctx);
  if (addresses.fixed.length > 0) {
    output = addresses.content;
    notes.push(
      `Corrected I2C address literal(s) to the catalog value: ${addresses.fixed.map((entry) => `${entry.name} ${entry.from} → ${entry.to}`).join(', ')}.`,
    );
  }

  const wire = ensureWireBegin(output, ctx);
  if (wire.added) {
    output = wire.content;
    notes.push('Inserted Wire.begin() in setup(): an I2C peripheral is driven but the bus was never started.');
  }

  const includes = pruneIncludes(output, ctx);
  if (includes.removed.length > 0) {
    output = includes.content;
    notes.push(`Removed include(s) no library in the plan provides or that duplicated the managed block: ${includes.removed.join(', ')}.`);
  }

  return { content: output, notes };
}
