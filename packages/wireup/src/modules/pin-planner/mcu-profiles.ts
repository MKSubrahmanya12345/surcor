/**
 * MCU pin capability profiles.
 *
 * Real pin planning needs real silicon knowledge: which pins exist, which are
 * PWM/ADC/UART/I2C capable, which are strapping or input-only, which belong to
 * the flash interface. This table is the ground truth the pin planner consults
 * so it never "blindly assigns GPIO numbers".
 */

import type { ComponentDefinition } from '@/types/component';

export type PinCapability =
  | 'digital'
  | 'analog'
  | 'adc'
  | 'pwm'
  | 'dac'
  | 'uart'
  | 'i2c'
  | 'spi'
  | 'touch'
  | 'interrupt'
  | 'input-only'
  | 'strapping';

export interface McuPinSpec {
  name: string;
  number?: number;
  capabilities: PinCapability[];
  /** Lower value = preferred. The planner walks pins in this order. */
  preference: number;
  /** Engineering caveat the user should see. */
  caution?: string;
}

export interface McuUartPort {
  id: string;
  tx: string;
  rx: string;
  /** False for the port used by the USB serial bridge / bootloader. */
  recommended: boolean;
  note?: string;
}

export interface McuProfile {
  componentId: string;
  name: string;
  logicVoltage: number;
  supplyVoltageRange?: [number, number];
  pins: McuPinSpec[];
  reserved: { pin: string; reason: string }[];
  i2c: { sda: string; scl: string };
  /**
   * True when the core lets firmware route I2C to any GPIO (ESP32, RP2040,
   * SAMD). On AVR the bus pins are hard-wired and `Wire.begin()` takes no
   * argument, so generated sketches must not pass pins there.
   */
  i2cRemappable?: boolean;
  spi: { mosi: string; miso: string; sck: string; cs: string };
  uarts: McuUartPort[];
  maxGpioSinkMa: number;
  recommendedGpioSinkMa: number;
  adcBits: number;
  notes: string[];
}

const esp32Pin = (
  number: number,
  preference: number,
  capabilities: PinCapability[],
  caution?: string,
): McuPinSpec => ({
  name: `GPIO${number}`,
  number,
  capabilities,
  preference,
  ...(caution ? { caution } : {}),
});

const ESP32_IO: PinCapability[] = ['digital', 'pwm', 'touch'];
const ESP32_ADC1: PinCapability[] = ['digital', 'pwm', 'adc', 'touch'];

export const MCU_PROFILES: McuProfile[] = [
  {
    componentId: 'esp32-devkit-v1',
    name: 'ESP32 DevKit V1',
    logicVoltage: 3.3,
    supplyVoltageRange: [4.5, 5.5],
    pins: [
      esp32Pin(25, 1, [...ESP32_IO, 'adc', 'dac'], 'ADC2 — unusable while Wi-Fi is active'),
      esp32Pin(26, 2, [...ESP32_IO, 'adc', 'dac'], 'ADC2 — unusable while Wi-Fi is active'),
      esp32Pin(27, 3, [...ESP32_IO, 'adc'], 'ADC2 — unusable while Wi-Fi is active'),
      esp32Pin(14, 4, [...ESP32_IO, 'adc'], 'ADC2 — unusable while Wi-Fi is active'),
      esp32Pin(32, 5, ESP32_ADC1, 'ADC1 — safe to use with Wi-Fi active'),
      esp32Pin(33, 6, ESP32_ADC1, 'ADC1 — safe to use with Wi-Fi active'),
      esp32Pin(4, 7, [...ESP32_IO, 'adc'], 'ADC2 — unusable while Wi-Fi is active'),
      esp32Pin(5, 8, ['digital', 'pwm', 'spi'], 'Default VSPI CS'),
      esp32Pin(18, 9, ['digital', 'pwm', 'spi'], 'Default VSPI SCK'),
      esp32Pin(19, 10, ['digital', 'pwm', 'spi'], 'Default VSPI MISO'),
      esp32Pin(23, 11, ['digital', 'pwm', 'spi'], 'Default VSPI MOSI'),
      esp32Pin(13, 12, [...ESP32_IO, 'adc'], 'ADC2 — unusable while Wi-Fi is active'),
      esp32Pin(16, 13, ['digital', 'pwm', 'uart'], 'Default Serial2 RX; shared with PSRAM on WROVER modules'),
      esp32Pin(17, 14, ['digital', 'pwm', 'uart'], 'Default Serial2 TX; shared with PSRAM on WROVER modules'),
      esp32Pin(21, 15, ['digital', 'pwm', 'i2c'], 'Default I2C SDA'),
      esp32Pin(22, 16, ['digital', 'pwm', 'i2c'], 'Default I2C SCL'),
      esp32Pin(15, 17, [...ESP32_IO, 'adc', 'strapping'], 'Strapping pin (MTDO): must not be driven low at boot'),
      esp32Pin(2, 18, [...ESP32_IO, 'strapping'], 'Strapping pin; also the on-board LED on most DevKits'),
      esp32Pin(0, 19, [...ESP32_IO, 'adc', 'strapping'], 'Strapping pin: must be HIGH at boot or the board enters download mode'),
      esp32Pin(12, 20, [...ESP32_IO, 'adc', 'strapping'], 'Strapping pin (MTDI): HIGH at boot selects 1.8 V flash and bricks startup'),
      esp32Pin(1, 21, ['digital', 'uart'], 'UART0 TX — shared with the USB serial bridge and boot logs'),
      esp32Pin(3, 22, ['digital', 'uart'], 'UART0 RX — shared with the USB serial bridge'),
      esp32Pin(34, 30, ['analog', 'adc', 'input-only'], 'INPUT ONLY, no internal pull-up'),
      esp32Pin(35, 31, ['analog', 'adc', 'input-only'], 'INPUT ONLY, no internal pull-up'),
      esp32Pin(36, 32, ['analog', 'adc', 'input-only'], 'INPUT ONLY (VP), no internal pull-up'),
      esp32Pin(39, 33, ['analog', 'adc', 'input-only'], 'INPUT ONLY (VN), no internal pull-up'),
    ],
    reserved: [
      { pin: 'GPIO6', reason: 'Wired to the SPI flash (SPICS0)' },
      { pin: 'GPIO7', reason: 'Wired to the SPI flash (SPID)' },
      { pin: 'GPIO8', reason: 'Wired to the SPI flash (SPIQ)' },
      { pin: 'GPIO9', reason: 'Wired to the SPI flash (SPIHD)' },
      { pin: 'GPIO10', reason: 'Wired to the SPI flash (SPIWP)' },
      { pin: 'GPIO11', reason: 'Wired to the SPI flash (SPICLK)' },
    ],
    i2c: { sda: 'GPIO21', scl: 'GPIO22' },
    i2cRemappable: true,
    spi: { mosi: 'GPIO23', miso: 'GPIO19', sck: 'GPIO18', cs: 'GPIO5' },
    uarts: [
      { id: 'Serial', tx: 'GPIO1', rx: 'GPIO3', recommended: false, note: 'USB serial bridge / bootloader logs' },
      { id: 'Serial1', tx: 'GPIO17', rx: 'GPIO16', recommended: false, note: 'Remappable; shared with PSRAM on WROVER' },
      { id: 'Serial2', tx: 'GPIO17', rx: 'GPIO16', recommended: true, note: 'Commonly remapped to free pins for peripherals' },
    ],
    maxGpioSinkMa: 12,
    recommendedGpioSinkMa: 8,
    adcBits: 12,
    notes: [
      '3.3 V logic only — 5 V signals will damage the pins. Use a level shifter or a divider from 5 V outputs (e.g. HC-SR04 ECHO, HC-05 TXD).',
      'GPIO34–GPIO39 are input-only and have no internal pull-ups: add external pull-up/pull-down resistors.',
      'Avoid strapping pins (GPIO0/2/12/15) for outputs that could hold a boot-critical level at reset.',
      'Wi-Fi/Bluetooth transmit bursts draw up to ~500 mA on the 3.3 V rail: keep the supply well decoupled.',
    ],
  },

  {
    componentId: 'arduino-uno-r3',
    name: 'Arduino Uno R3',
    logicVoltage: 5,
    supplyVoltageRange: [7, 12],
    pins: [
      { name: 'D4', number: 4, capabilities: ['digital'], preference: 1 },
      { name: 'D7', number: 7, capabilities: ['digital'], preference: 2 },
      { name: 'D8', number: 8, capabilities: ['digital'], preference: 3 },
      { name: 'D2', number: 2, capabilities: ['digital', 'interrupt'], preference: 4 },
      { name: 'D5', number: 5, capabilities: ['digital', 'pwm'], preference: 5 },
      { name: 'D6', number: 6, capabilities: ['digital', 'pwm'], preference: 6 },
      { name: 'D9', number: 9, capabilities: ['digital', 'pwm'], preference: 7 },
      { name: 'D10', number: 10, capabilities: ['digital', 'pwm', 'spi'], preference: 8, caution: 'SPI SS' },
      { name: 'D11', number: 11, capabilities: ['digital', 'pwm', 'spi'], preference: 9, caution: 'SPI MOSI' },
      { name: 'D12', number: 12, capabilities: ['digital', 'spi'], preference: 10, caution: 'SPI MISO' },
      { name: 'D13', number: 13, capabilities: ['digital', 'spi'], preference: 11, caution: 'SPI SCK and the on-board LED' },
      { name: 'D3', number: 3, capabilities: ['digital', 'pwm', 'interrupt'], preference: 12 },
      { name: 'A0', number: 14, capabilities: ['analog', 'adc', 'digital'], preference: 13 },
      { name: 'A1', number: 15, capabilities: ['analog', 'adc', 'digital'], preference: 14 },
      { name: 'A2', number: 16, capabilities: ['analog', 'adc', 'digital'], preference: 15 },
      { name: 'A3', number: 17, capabilities: ['analog', 'adc', 'digital'], preference: 16 },
      { name: 'A4', number: 18, capabilities: ['analog', 'adc', 'digital', 'i2c'], preference: 17, caution: 'Default I2C SDA' },
      { name: 'A5', number: 19, capabilities: ['analog', 'adc', 'digital', 'i2c'], preference: 18, caution: 'Default I2C SCL' },
      { name: 'D0', number: 0, capabilities: ['digital', 'uart'], preference: 21, caution: 'Hardware UART RX — shared with the USB serial bridge' },
      { name: 'D1', number: 1, capabilities: ['digital', 'uart'], preference: 22, caution: 'Hardware UART TX — shared with the USB serial bridge' },
    ],
    reserved: [],
    i2c: { sda: 'A4', scl: 'A5' },
    spi: { mosi: 'D11', miso: 'D12', sck: 'D13', cs: 'D10' },
    uarts: [{ id: 'Serial', tx: 'D1', rx: 'D0', recommended: false, note: 'Shared with the USB serial bridge; use SoftwareSerial for extra UARTs' }],
    maxGpioSinkMa: 40,
    recommendedGpioSinkMa: 20,
    adcBits: 10,
    notes: [
      '5 V logic: 3.3 V-only peripherals (HC-05/HC-06, ESP8266) need level shifting or a divider on their RX line.',
      'Only one hardware UART, shared with programming — use SoftwareSerial for Bluetooth modules.',
      'Total board current from the 5 V pin is limited (~200 mA via the regulator); use VIN for motor supplies.',
    ],
  },

  {
    componentId: 'arduino-nano',
    name: 'Arduino Nano',
    logicVoltage: 5,
    supplyVoltageRange: [7, 12],
    pins: [
      { name: 'D4', number: 4, capabilities: ['digital'], preference: 1 },
      { name: 'D7', number: 7, capabilities: ['digital'], preference: 2 },
      { name: 'D8', number: 8, capabilities: ['digital'], preference: 3 },
      { name: 'D2', number: 2, capabilities: ['digital', 'interrupt'], preference: 4 },
      { name: 'D5', number: 5, capabilities: ['digital', 'pwm'], preference: 5 },
      { name: 'D6', number: 6, capabilities: ['digital', 'pwm'], preference: 6 },
      { name: 'D9', number: 9, capabilities: ['digital', 'pwm'], preference: 7 },
      { name: 'D10', number: 10, capabilities: ['digital', 'pwm', 'spi'], preference: 8, caution: 'SPI SS' },
      { name: 'D11', number: 11, capabilities: ['digital', 'pwm', 'spi'], preference: 9, caution: 'SPI MOSI' },
      { name: 'D12', number: 12, capabilities: ['digital', 'spi'], preference: 10, caution: 'SPI MISO' },
      { name: 'D13', number: 13, capabilities: ['digital', 'spi'], preference: 11, caution: 'SPI SCK and the on-board LED' },
      { name: 'D3', number: 3, capabilities: ['digital', 'pwm', 'interrupt'], preference: 12 },
      { name: 'A0', number: 14, capabilities: ['analog', 'adc', 'digital'], preference: 13 },
      { name: 'A1', number: 15, capabilities: ['analog', 'adc', 'digital'], preference: 14 },
      { name: 'A2', number: 16, capabilities: ['analog', 'adc', 'digital'], preference: 15 },
      { name: 'A3', number: 17, capabilities: ['analog', 'adc', 'digital'], preference: 16 },
      { name: 'A4', number: 18, capabilities: ['analog', 'adc', 'digital', 'i2c'], preference: 17, caution: 'Default I2C SDA' },
      { name: 'A5', number: 19, capabilities: ['analog', 'adc', 'digital', 'i2c'], preference: 18, caution: 'Default I2C SCL' },
      { name: 'A6', number: 20, capabilities: ['analog', 'adc', 'input-only'], preference: 19, caution: 'Analog only — cannot be used as a digital pin' },
      { name: 'A7', number: 21, capabilities: ['analog', 'adc', 'input-only'], preference: 20, caution: 'Analog only — cannot be used as a digital pin' },
      { name: 'D0', number: 0, capabilities: ['digital', 'uart'], preference: 23, caution: 'Hardware UART RX — shared with the USB serial bridge' },
      { name: 'D1', number: 1, capabilities: ['digital', 'uart'], preference: 24, caution: 'Hardware UART TX — shared with the USB serial bridge' },
    ],
    reserved: [],
    i2c: { sda: 'A4', scl: 'A5' },
    spi: { mosi: 'D11', miso: 'D12', sck: 'D13', cs: 'D10' },
    uarts: [{ id: 'Serial', tx: 'D1', rx: 'D0', recommended: false, note: 'Shared with the USB serial bridge' }],
    maxGpioSinkMa: 40,
    recommendedGpioSinkMa: 20,
    adcBits: 10,
    notes: [
      '5 V logic; A6/A7 are analog-only inputs.',
      'VIN accepts 7–12 V; the on-board 5 V regulator is limited to a few hundred mA.',
    ],
  },

  {
    componentId: 'arduino-mega',
    name: 'Arduino Mega 2560',
    logicVoltage: 5,
    supplyVoltageRange: [7, 12],
    pins: [
      // Plain digital D22-D49: the reason the board exists — 28 conflict-free pins.
      ...([22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 47, 48, 49] as const).map(
        (n, index): McuPinSpec => ({ name: `D${n}`, number: n, capabilities: ['digital'], preference: index + 1 }),
      ),
      // PWM-capable pins.
      ...([44, 45, 46] as const).map(
        (n, index): McuPinSpec => ({ name: `D${n}`, number: n, capabilities: ['digital', 'pwm'], preference: 26 + index }),
      ),
      ...([4, 7, 8, 9, 10, 11, 12, 13, 5, 6, 2, 3] as const).map((n, index): McuPinSpec => {
        const extra: PinCapability[] = n === 2 || n === 3 ? ['interrupt'] : [];
        return { name: `D${n}`, number: n, capabilities: ['digital', 'pwm', ...extra], preference: 29 + index, ...(n === 13 ? { caution: 'Also the on-board LED' } : {}) };
      }),
      // SPI + the four UARTs + I2C.
      { name: 'D50', number: 50, capabilities: ['digital', 'spi'], preference: 41, caution: 'SPI MISO' },
      { name: 'D51', number: 51, capabilities: ['digital', 'spi'], preference: 42, caution: 'SPI MOSI' },
      { name: 'D52', number: 52, capabilities: ['digital', 'spi'], preference: 43, caution: 'SPI SCK' },
      { name: 'D53', number: 53, capabilities: ['digital', 'spi'], preference: 44, caution: 'SPI SS — must stay an OUTPUT or the SPI peripheral drops to slave mode' },
      { name: 'D20', number: 20, capabilities: ['digital', 'i2c', 'interrupt'], preference: 45, caution: 'Default I2C SDA' },
      { name: 'D21', number: 21, capabilities: ['digital', 'i2c', 'interrupt'], preference: 46, caution: 'Default I2C SCL' },
      { name: 'D18', number: 18, capabilities: ['digital', 'uart', 'interrupt'], preference: 47, caution: 'Serial1 TX' },
      { name: 'D19', number: 19, capabilities: ['digital', 'uart', 'interrupt'], preference: 48, caution: 'Serial1 RX' },
      { name: 'D16', number: 16, capabilities: ['digital', 'uart'], preference: 49, caution: 'Serial2 TX' },
      { name: 'D17', number: 17, capabilities: ['digital', 'uart'], preference: 50, caution: 'Serial2 RX' },
      { name: 'D14', number: 14, capabilities: ['digital', 'uart'], preference: 51, caution: 'Serial3 TX' },
      { name: 'D15', number: 15, capabilities: ['digital', 'uart'], preference: 52, caution: 'Serial3 RX' },
      // Analog inputs A0-A15 (A0-A5 also serve as digital on the shield header).
      ...([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const).map(
        (n, index): McuPinSpec => ({
          name: `A${n}`,
          number: 54 + n,
          capabilities: ['analog', 'adc', 'digital'],
          preference: 53 + index,
        }),
      ),
      { name: 'D0', number: 0, capabilities: ['digital', 'uart'], preference: 69, caution: 'Serial RX — shared with the USB serial bridge' },
      { name: 'D1', number: 1, capabilities: ['digital', 'uart'], preference: 70, caution: 'Serial TX — shared with the USB serial bridge' },
    ],
    reserved: [],
    i2c: { sda: 'D20', scl: 'D21' },
    spi: { mosi: 'D51', miso: 'D50', sck: 'D52', cs: 'D53' },
    uarts: [
      { id: 'Serial', tx: 'D1', rx: 'D0', recommended: false, note: 'Shared with the USB serial bridge' },
      { id: 'Serial1', tx: 'D18', rx: 'D19', recommended: true, note: 'Free hardware UART' },
      { id: 'Serial2', tx: 'D16', rx: 'D17', recommended: true, note: 'Free hardware UART' },
      { id: 'Serial3', tx: 'D14', rx: 'D15', recommended: true, note: 'Free hardware UART' },
    ],
    maxGpioSinkMa: 40,
    recommendedGpioSinkMa: 20,
    adcBits: 10,
    notes: [
      '5 V logic: 3.3 V-only peripherals need level shifting, as on the Uno.',
      'Four hardware UARTs — no SoftwareSerial needed for extra serial links.',
      'D53 (SS) must remain an OUTPUT for the SPI peripheral to stay master.',
      'The 5 V regulator is the same class as the Uno: ~200 mA total for peripherals before you move loads to VIN.',
    ],
  },
  /* Raspberry Pi 5 — an SBC, not an MCU: every GPIO is pin-muxable, and the
   * "firmware" is user-space Python. The profile exists so the pin planner
   * stays honest about 3.3 V logic, the 16 mA per-pin limit and the default
   * bus pins instead of blindly numbering header positions. */
  {
    componentId: 'raspberry-pi-5',
    name: 'Raspberry Pi 5 (40-pin header)',
    logicVoltage: 3.3,
    supplyVoltageRange: [5, 5.25],
    pins: [
      { name: 'GPIO2', number: 2, capabilities: ['digital', 'i2c'], preference: 1, caution: 'Default I2C1 SDA' },
      { name: 'GPIO3', number: 3, capabilities: ['digital', 'i2c'], preference: 2, caution: 'Default I2C1 SCL' },
      { name: 'GPIO14', number: 14, capabilities: ['digital', 'uart'], preference: 3, caution: 'UART0 TX — reserved for the serial console by default' },
      { name: 'GPIO15', number: 15, capabilities: ['digital', 'uart'], preference: 4, caution: 'UART0 RX — reserved for the serial console by default' },
      { name: 'GPIO8', number: 8, capabilities: ['digital', 'spi'], preference: 5, caution: 'SPI0 CS0' },
      { name: 'GPIO9', number: 9, capabilities: ['digital', 'spi'], preference: 6, caution: 'SPI0 MISO' },
      { name: 'GPIO10', number: 10, capabilities: ['digital', 'spi'], preference: 7, caution: 'SPI0 MOSI' },
      { name: 'GPIO11', number: 11, capabilities: ['digital', 'spi'], preference: 8, caution: 'SPI0 SCLK' },
      { name: 'GPIO4', number: 4, capabilities: ['digital'], preference: 9 },
      { name: 'GPIO17', number: 17, capabilities: ['digital'], preference: 10 },
      { name: 'GPIO22', number: 22, capabilities: ['digital'], preference: 11 },
      { name: 'GPIO23', number: 23, capabilities: ['digital'], preference: 12 },
      { name: 'GPIO24', number: 24, capabilities: ['digital'], preference: 13 },
      { name: 'GPIO25', number: 25, capabilities: ['digital'], preference: 14 },
      { name: 'GPIO27', number: 27, capabilities: ['digital'], preference: 15 },
      { name: 'GPIO5', number: 5, capabilities: ['digital'], preference: 16 },
      { name: 'GPIO6', number: 6, capabilities: ['digital'], preference: 17 },
    ],
    reserved: [
      { pin: 'CSI', reason: 'CSI-2 camera ribbon — not a GPIO, the Pi camera attaches here' },
      { pin: 'USB3-A', reason: 'USB devices and webcams — not a GPIO' },
    ],
    i2c: { sda: 'GPIO2', scl: 'GPIO3' },
    i2cRemappable: true,
    spi: { mosi: 'GPIO10', miso: 'GPIO9', sck: 'GPIO11', cs: 'GPIO8' },
    uarts: [
      { id: 'UART0', tx: 'GPIO14', rx: 'GPIO15', recommended: false, note: 'Reserved for the serial console by default — free it in config.txt if needed' },
    ],
    maxGpioSinkMa: 16,
    recommendedGpioSinkMa: 4,
    adcBits: 12,
    notes: [
      '3.3 V logic: 5 V parts (most Arduino modules) need level shifting.',
      '16 mA max per GPIO, 4 mA recommended — light indicators only.',
      'ADC via the on-board I2C ADC12L021 (GPIO26/GPIO27), not direct GPIO ADC.',
      'Cameras and USB devices attach by connector (CSI / USB), not by GPIO wiring.',
      'Software is user-space (Python etc.) — no sketch, no flash.',
    ],
  },
];


export function getMcuProfile(componentId: string): McuProfile | undefined {
  return MCU_PROFILES.find((profile) => profile.componentId === componentId);
}

/** Resolve a profile for a catalog component, falling back to its metadata. */
export function profileForComponent(component: ComponentDefinition | undefined): McuProfile | undefined {
  if (!component) return undefined;
  const explicit = getMcuProfile(component.id);
  if (explicit) return explicit;

  const metadata = component.metadata as Record<string, unknown>;
  const profileId = typeof metadata.mcuProfileId === 'string' ? metadata.mcuProfileId : undefined;
  return profileId ? getMcuProfile(profileId) : undefined;
}

export function listMcuProfiles(): McuProfile[] {
  return MCU_PROFILES;
}

export interface UsablePinFilter {
  /** Pin must expose every one of these capabilities. */
  capabilities?: PinCapability[];
  /** Pin names already taken. */
  exclude?: Set<string>;
  /** Allow strapping/boot pins only if nothing else is left. */
  allowStrapping?: boolean;
  /** Direction we intend to drive. */
  direction?: 'input' | 'output';
}

/** Pins of an MCU sorted by preference, filtered by capability needs. */
export function usablePins(profile: McuProfile, filter: UsablePinFilter = {}): McuPinSpec[] {
  const capabilities = filter.capabilities ?? [];
  const exclude = filter.exclude ?? new Set<string>();

  return profile.pins
    .filter((spec) => {
      if (exclude.has(spec.name)) return false;
      if (!capabilities.every((capability) => spec.capabilities.includes(capability))) return false;
      if (filter.direction === 'output' && spec.capabilities.includes('input-only')) return false;
      if (!filter.allowStrapping && spec.capabilities.includes('strapping')) return false;
      return true;
    })
    .sort((a, b) => a.preference - b.preference);
}

export function pinSpec(profile: McuProfile, pinName: string): McuPinSpec | undefined {
  return profile.pins.find((spec) => spec.name.toLowerCase() === pinName.toLowerCase());
}

/** Normalise model/user pin names ("gpio 25", "D25", "25") to the profile name. */
export function normaliseMcuPin(profile: McuProfile, candidate: string): string | undefined {
  const raw = candidate.trim();
  if (!raw) return undefined;

  const exact = profile.pins.find((spec) => spec.name.toLowerCase() === raw.toLowerCase());
  if (exact) return exact.name;

  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length > 0) {
    const byNumber = profile.pins.find((spec) => spec.number !== undefined && String(spec.number) === digits);
    if (byNumber) return byNumber.name;
  }

  const withoutPrefix = raw.toLowerCase().replace(/^(gpio|d|a|pin)\s*/i, '');
  const byAlias = profile.pins.find((spec) => spec.name.toLowerCase().endsWith(withoutPrefix));
  return byAlias?.name;
}

/** Format MCU capability information for prompts and documentation. */
export function formatMcuProfile(profile: McuProfile): string {
  const lines: string[] = [];
  lines.push(`${profile.name} (${profile.componentId}) — ${profile.logicVoltage} V logic, ADC ${profile.adcBits}-bit`);
  lines.push(`  usable pins (preference order): ${[...profile.pins].sort((a, b) => a.preference - b.preference).map((p) => p.name).join(', ')}`);
  const pwm = profile.pins.filter((p) => p.capabilities.includes('pwm')).map((p) => p.name);
  const adc = profile.pins.filter((p) => p.capabilities.includes('adc')).map((p) => p.name);
  const inputOnly = profile.pins.filter((p) => p.capabilities.includes('input-only')).map((p) => p.name);
  const strapping = profile.pins.filter((p) => p.capabilities.includes('strapping')).map((p) => p.name);
  if (pwm.length > 0) lines.push(`  pwm capable: ${pwm.join(', ')}`);
  if (adc.length > 0) lines.push(`  adc capable: ${adc.join(', ')}`);
  if (inputOnly.length > 0) lines.push(`  INPUT ONLY (never drive as output): ${inputOnly.join(', ')}`);
  if (strapping.length > 0) lines.push(`  strapping pins (avoid for outputs if possible): ${strapping.join(', ')}`);
  if (profile.reserved.length > 0) {
    lines.push(`  RESERVED / UNUSABLE: ${profile.reserved.map((entry) => `${entry.pin} (${entry.reason})`).join('; ')}`);
  }
  lines.push(`  i2c: SDA=${profile.i2c.sda} SCL=${profile.i2c.scl}`);
  lines.push(`  spi: MOSI=${profile.spi.mosi} MISO=${profile.spi.miso} SCK=${profile.spi.sck} CS=${profile.spi.cs}`);
  lines.push(`  uart: ${profile.uarts.map((uart) => `${uart.id} TX=${uart.tx} RX=${uart.rx}${uart.recommended ? '' : ' (not recommended)'}`).join(' | ')}`);
  lines.push(`  gpio current: ${profile.recommendedGpioSinkMa} mA recommended, ${profile.maxGpioSinkMa} mA absolute max`);
  for (const note of profile.notes) lines.push(`  note: ${note}`);
  return lines.join('\n');
}
