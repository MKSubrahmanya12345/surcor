/** Sensor seed entries. */

import type { ComponentDefinition } from '@/types/component';

import { def, pin } from './helpers';

export const SENSORS: ComponentDefinition[] = [
  def({
    id: 'dht11-temperature-humidity',
    name: 'DHT11 temperature & humidity sensor',
    category: 'sensor',
    description:
      'Single-wire digital temperature (0–50 °C, ±2 °C) and humidity (20–90 %RH, ±5 %) sensor. 1 Hz maximum sample rate. Needs a 4.7–10 kΩ pull-up on DATA (many 3-pin modules include one).',
    voltage: 5,
    minVoltage: 3.3,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 0.5, maxMa: 2.5, note: 'Standby ~0.06 mA; 0.5–2.5 mA during conversion.' },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('DATA', 'one_wire', 'bidirectional', { required: true, signal: 'Single-wire digital data', aliases: ['OUT', 'S', 'SIG', 'DQ'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
    ],
    libraryRequirements: [
      { name: 'DHT sensor library', import: 'DHT.h', manager: 'arduino', repository: 'https://github.com/adafruit/DHT-sensor-library', purpose: 'Decodes the DHT single-wire protocol' },
      { name: 'Adafruit Unified Sensor', import: 'Adafruit_Sensor.h', manager: 'arduino', repository: 'https://github.com/adafruit/Adafruit_Sensor', purpose: 'Dependency of the DHT sensor library' },
    ],
    keywords: ['dht11', 'temperature', 'humidity', 'weather', 'climate'],
    aliases: ['dht11', 'dht 11', 'temp humidity sensor'],
    simulator: { supported: false, notes: 'Simulators commonly provide the DHT22 variant instead.' },
    metadata: { electrical: true, sampleRateHz: 1, requiresPullupOhm: 10000, protocolAddress: 'single-wire' },
  }),

  def({
    id: 'dht22-temperature-humidity',
    name: 'DHT22 (AM2302) temperature & humidity sensor',
    category: 'sensor',
    description:
      'Single-wire digital temperature (-40–80 °C, ±0.5 °C) and humidity (0–100 %RH, ±2 %) sensor. 0.5 Hz maximum sample rate, 3.3–6 V supply. Needs a 4.7–10 kΩ pull-up on DATA.',
    voltage: 5,
    minVoltage: 3.3,
    maxVoltage: 6,
    currentRequirements: { typicalMa: 0.5, maxMa: 2.5 },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('DATA', 'one_wire', 'bidirectional', { required: true, signal: 'Single-wire digital data', aliases: ['OUT', 'S', 'SIG', 'DQ'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
    ],
    libraryRequirements: [
      { name: 'DHT sensor library', import: 'DHT.h', manager: 'arduino', repository: 'https://github.com/adafruit/DHT-sensor-library', purpose: 'Decodes the DHT single-wire protocol' },
      { name: 'Adafruit Unified Sensor', import: 'Adafruit_Sensor.h', manager: 'arduino', repository: 'https://github.com/adafruit/Adafruit_Sensor', purpose: 'Dependency of the DHT sensor library' },
    ],
    keywords: ['dht22', 'am2302', 'temperature', 'humidity', 'weather'],
    aliases: ['dht22', 'am2302', 'dht 22'],
    simulator: { part: 'wokwi-dht22', supported: true },
    metadata: { electrical: true, sampleRateHz: 0.5, requiresPullupOhm: 4700 },
  }),

  def({
    id: 'hc-sr04-ultrasonic',
    name: 'HC-SR04 ultrasonic distance sensor',
    category: 'sensor',
    description:
      '2 cm – 4 m ultrasonic rangefinder. TRIG receives a 10 µs pulse, ECHO returns a pulse whose width is proportional to distance (58 µs per cm). 5 V supply; ECHO is a 5 V output, so a 3.3 V MCU needs a divider or level shifter on that line.',
    voltage: 5,
    minVoltage: 5,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 15, maxMa: 20, note: 'Quiescent 2 mA, 15 mA during a measurement cycle.' },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('TRIG', 'digital', 'input', { required: true, signal: '10 µs trigger pulse from the MCU', aliases: ['T', 'TRIGGER'] }),
      pin('ECHO', 'digital', 'output', { required: true, signal: '5 V pulse output — level shift for 3.3 V MCUs', aliases: ['E', 'OUT'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
    ],
    keywords: ['ultrasonic', 'hc-sr04', 'distance', 'range', 'obstacle', 'sonar', 'parking'],
    aliases: ['hc-sr04', 'hcsr04', 'ultrasonic sensor', 'ultrasonic distance sensor'],
    simulator: { part: 'wokwi-hc-sr04', supported: true },
    metadata: { electrical: true, echoOutputVoltage: 5, minRangeCm: 2, maxRangeCm: 400, usPerCm: 58 },
  }),

  def({
    id: 'pir-sensor-hc-sr501',
    name: 'HC-SR501 PIR motion sensor',
    category: 'sensor',
    description:
      'Passive infrared motion detector with on-board amplifier and comparator. Digital HIGH output on motion, adjustable sensitivity and delay pots, and a retrigger/non-retrigger jumper. 4.5–20 V supply, 3.3 V compatible output.',
    voltage: 5,
    minVoltage: 4.5,
    maxVoltage: 20,
    currentRequirements: { typicalMa: 0.05, maxMa: 65, note: '<50 µA quiescent; up to 65 mA during output high.' },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('OUT', 'digital', 'output', { required: true, signal: '3.3 V HIGH on motion', aliases: ['SIG', 'S', 'DATA'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
    ],
    keywords: ['pir', 'motion', 'hc-sr501', 'presence', 'intruder', 'security'],
    aliases: ['pir', 'pir sensor', 'hc-sr501', 'motion sensor'],
    simulator: {
      part: 'wokwi-pir-motion-sensor',
      supported: true,
      notes: 'Velxio registers real simulation logic: OUT idles LOW and pulses on a trigger. The HC-SR501 sensitivity/delay pots and the 30 s warm-up window are not modelled.',
    },
    metadata: { electrical: true, outputLogicVoltage: 3.3, warmUpSeconds: 30, detectionRangeM: 7, adjustableDelay: [1.3, 25] },
  }),

  def({
    id: 'ir-obstacle-sensor',
    name: 'IR obstacle avoidance sensor module',
    category: 'sensor',
    description:
      'Infrared LED + photodiode module with an on-board comparator and sensitivity trimmer. Digital OUT goes LOW when an obstacle is detected within roughly 2–30 cm. 3.3–5 V supply.',
    voltage: 5,
    minVoltage: 3.3,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 15, maxMa: 35 },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
      pin('OUT', 'digital', 'output', { required: true, signal: 'LOW = obstacle detected', aliases: ['DO', 'SIG', 'S'] }),
    ],
    keywords: ['ir', 'infrared', 'obstacle', 'avoidance', 'line follower', 'proximity'],
    aliases: ['ir obstacle sensor', 'ir sensor', 'obstacle sensor', 'infrared obstacle module'],
    simulator: { supported: false, notes: 'Represent as a digital input source.' },
    metadata: { electrical: true, activeLevel: 'low', detectionRangeCm: [2, 30] },
  }),

  def({
    id: 'ldr-photoresistor',
    name: 'LDR photoresistor (CdS cell)',
    category: 'sensor',
    description:
      'Light dependent resistor: ~1 MΩ in darkness down to ~1–10 kΩ in bright light. Two terminals, no polarity. Must be used in a voltage divider with a fixed resistor (10 kΩ is a good default) into an ADC pin.',
    minVoltage: 0,
    maxVoltage: 5,
    currentRequirements: { typicalMa: 0.5, maxMa: 5 },
    pins: [
      pin('1', 'analog', 'bidirectional', { required: true, signal: 'Terminal 1 (to supply rail in a divider)', aliases: ['A'] }),
      pin('2', 'analog', 'bidirectional', { required: true, signal: 'Terminal 2 (to ADC node)', aliases: ['B'] }),
    ],
    keywords: ['ldr', 'photoresistor', 'light', 'brightness', 'cds', 'ambient light'],
    aliases: ['ldr', 'photoresistor', 'light sensor', 'cds cell'],
    simulator: {
      supported: false,
      notes:
        'Wokwi and Velxio only model a four-pin photoresistor MODULE (VCC/GND/DO/AO), not a bare two-terminal LDR. ' +
        'Placing the module would connect the divider to pins this part does not have, so it stays out of the simulation.',
    },
    metadata: { electrical: true, noSupplyPins: true, requiresVoltageDivider: true, dividerResistorOhm: 10000, resistanceDarkOhm: 1000000, resistanceLightOhm: 5000 },
  }),

  def({
    id: 'soil-moisture-sensor',
    name: 'Resistive soil moisture sensor module',
    category: 'sensor',
    description:
      'Two-probe resistive soil moisture sensor with a comparator module providing an analog output (AO, more moisture = lower resistance = higher voltage) and a digital threshold output (DO). 3.3–5 V supply.',
    voltage: 5,
    minVoltage: 3.3,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 15, maxMa: 35 },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
      pin('AO', 'analog', 'output', { required: false, signal: 'Analog moisture level to an ADC pin', aliases: ['A0', 'ANALOG'] }),
      pin('DO', 'digital', 'output', { required: false, signal: 'Digital threshold output', aliases: ['D0', 'DIGITAL'] }),
    ],
    keywords: ['soil', 'moisture', 'plant', 'irrigation', 'water level', 'garden'],
    aliases: ['soil moisture sensor', 'soil sensor', 'moisture module'],
    simulator: { supported: false, notes: 'Represent as a potentiometer into an ADC pin.' },
    metadata: { electrical: true, corrosionNote: 'Resistive probes corrode quickly — sample infrequently and power the probe through a GPIO or transistor.' },
  }),

  def({
    id: 'mpu6050-imu',
    name: 'MPU6050 6-axis IMU (accelerometer + gyroscope)',
    category: 'sensor',
    description:
      'I2C 6-axis motion sensor (3-axis accelerometer ±2/4/8/16 g, 3-axis gyroscope ±250–2000 °/s) with a digital motion processor and programmable interrupt. Most breakouts include a 3.3 V regulator so they accept 5 V VCC while keeping 3.3 V logic. Default address 0x68 (0x69 with AD0 high).',
    voltage: 3.3,
    minVoltage: 3,
    maxVoltage: 5,
    currentRequirements: { typicalMa: 3.9, maxMa: 5 },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
      pin('SCL', 'i2c', 'input', { required: true, signal: 'I2C clock', aliases: ['SCLK'] }),
      pin('SDA', 'i2c', 'bidirectional', { required: true, signal: 'I2C data', aliases: ['SDI'] }),
      pin('INT', 'digital', 'output', { required: false, signal: 'Data-ready / motion interrupt', aliases: ['IRQ'] }),
      pin('AD0', 'digital', 'input', { required: false, signal: 'Address select: LOW = 0x68, HIGH = 0x69' }),
      pin('XDA', 'i2c', 'bidirectional', { required: false, signal: 'Auxiliary I2C data — master bus for an external magnetometer, leave unconnected otherwise' }),
      pin('XCL', 'i2c', 'output', { required: false, signal: 'Auxiliary I2C clock — master bus for an external magnetometer, leave unconnected otherwise' }),
    ],
    communicationProtocols: ['i2c'],
    keywords: ['mpu6050', 'imu', 'accelerometer', 'gyroscope', 'gyro', 'tilt', 'orientation', 'balance'],
    aliases: ['mpu6050', 'mpu 6050', 'imu', 'gyro accelerometer', '6-axis imu'],
    libraryRequirements: [
      { name: 'Adafruit MPU6050', import: 'Adafruit_MPU6050.h', manager: 'arduino', repository: 'https://github.com/adafruit/Adafruit_MPU6050', purpose: 'MPU6050 register driver' },
      { name: 'Adafruit Unified Sensor', import: 'Adafruit_Sensor.h', manager: 'arduino', repository: 'https://github.com/adafruit/Adafruit_Sensor', purpose: 'Dependency of the Adafruit sensor drivers' },
      { name: 'Wire', import: 'Wire.h', manager: 'arduino', purpose: 'I2C bus', builtIn: true },
    ],
    simulator: {
      part: 'wokwi-mpu6050',
      supported: true,
      notes:
        'Register-level I2C model at 0x68 (AD0 high → 0x69) with live acceleration, rotation and ' +
        'temperature controls; the auxiliary XDA/XCL master bus is wired but not modelled.',
    },
    metadata: { electrical: true, i2cAddress: '0x68', i2cAddressAlt: '0x69', i2cMaxClockHz: 400000, logicVoltage: 3.3 },
  }),

  def({
    id: 'bme280-environmental',
    name: 'BME280 temperature / humidity / pressure sensor',
    category: 'sensor',
    description:
      'Bosch environmental sensor combining temperature (±1 °C), relative humidity (±3 %) and barometric pressure (±1 hPa, ~1 m altitude resolution) in one package. Speaks I2C (0x76 or 0x77 depending on SDO) or 4-wire SPI. The die runs at 1.71–3.6 V; breakout boards add a regulator and level shifting so they tolerate 5 V on VIN.',
    voltage: 3.3,
    minVoltage: 1.71,
    maxVoltage: 3.6,
    currentRequirements: { typicalMa: 0.4, maxMa: 1, note: '~3.6 µA at 1 Hz in humidity+pressure mode; the breakout regulator dominates the module current.' },
    pins: [
      pin('VIN', 'power', 'power', { required: true, voltage: 3.3, signal: 'Module supply (3.3 V direct, or 5 V on regulated breakouts)', aliases: ['VCC', 'VDD', '3V3', '+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'VSS'] }),
      pin('SCL', 'i2c', 'input', { required: true, signal: 'I2C clock / SPI SCK', aliases: ['SCK', 'CLK'] }),
      pin('SDA', 'i2c', 'bidirectional', { required: true, signal: 'I2C data / SPI MOSI (SDI)', aliases: ['SDI', 'MOSI'] }),
      pin('CSB', 'control', 'input', { required: false, signal: 'Chip select — hold HIGH for I2C, drive LOW to select SPI', aliases: ['CS', 'NCS'] }),
      pin('SDO', 'spi', 'output', { required: false, signal: 'SPI MISO, or I2C address select (LOW = 0x76, HIGH = 0x77)', aliases: ['MISO', 'ADDR'] }),
    ],
    communicationProtocols: ['i2c', 'spi'],
    libraryRequirements: [
      { name: 'Adafruit BME280 Library', import: 'Adafruit_BME280.h', manager: 'arduino', repository: 'https://github.com/adafruit/Adafruit_BME280_Library', purpose: 'Calibrated temperature/humidity/pressure reads' },
      { name: 'Adafruit Unified Sensor', import: 'Adafruit_Sensor.h', manager: 'arduino', purpose: 'Dependency of the Adafruit sensor drivers' },
      { name: 'Wire', import: 'Wire.h', manager: 'arduino', purpose: 'I2C bus', builtIn: true },
    ],
    keywords: ['bme280', 'temperature', 'humidity', 'pressure', 'barometer', 'weather', 'altitude', 'environmental'],
    aliases: ['bme280', 'bme-280', 'bosch bme280', 'bmp280'],
    exampleUsage: ['Weather station logging to an OLED', 'Indoor air-comfort monitor over MQTT'],
    simulator: {
      // Deliberately NOT `supported: true`: the pinned Velxio build models the
      // BMP280 (pressure + temperature only). Rather than present a different
      // chip as this one, the BME280 stays a CAD bench part until a humidity
      // model exists. See `wokwi.ts` PIN_MAPS for the shared-pin mapping.
      supported: false,
      notes:
        'No emulator element with humidity in this build — the BMP280 element beside it models pressure and ' +
        'temperature only, so it is not a stand-in for this part.',
    },
    metadata: {
      electrical: true,
      i2cAddress: '0x76',
      i2cAddressAlt: '0x77',
      i2cMaxClockHz: 3400000,
      logicVoltage: 3.3,
      dimensionsMm: { width: 15.2, length: 12, height: 1.6 },
      note: 'A BMP280 is the same package without humidity; the driver differs.',
    },
  }),

  def({
    id: 'ds18b20-temperature',
    name: 'DS18B20 1-Wire digital thermometer',
    category: 'sensor',
    description:
      '1-Wire digital temperature sensor, -55 to +125 °C with ±0.5 °C accuracy from -10 to +85 °C and 9–12 bit selectable resolution. Every device has a unique 64-bit ROM id, so many sensors share a single data pin. The bus needs a 4.7 kΩ pull-up to VCC; waterproof probe versions use the same three wires.',
    voltage: 3.3,
    minVoltage: 3,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 1.5, maxMa: 4, note: '1.5 mA during a conversion, ~1 µA standby.' },
    pins: [
      pin('VDD', 'power', 'power', { required: true, voltage: 5, signal: 'Supply 3.0–5.5 V (tie to GND for parasite power)', aliases: ['VCC', '+', 'RED'] }),
      pin('DQ', 'one_wire', 'bidirectional', { required: true, signal: '1-Wire data — requires a 4.7 kΩ pull-up to VCC', aliases: ['DATA', 'OUT', 'SIG', 'YELLOW'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'BLACK'] }),
    ],
    communicationProtocols: ['one_wire'],
    libraryRequirements: [
      { name: 'OneWire', import: 'OneWire.h', manager: 'arduino', repository: 'https://github.com/PaulStoffregen/OneWire', purpose: '1-Wire bus transport' },
      { name: 'DallasTemperature', import: 'DallasTemperature.h', manager: 'arduino', repository: 'https://github.com/milesburton/Arduino-Temperature-Control-Library', purpose: 'DS18B20 conversion and scaling' },
    ],
    keywords: ['ds18b20', 'temperature', '1-wire', 'onewire', 'thermometer', 'probe', 'waterproof'],
    aliases: ['ds18b20', 'ds1820', 'dallas temperature sensor', '1-wire temperature'],
    exampleUsage: ['Multi-zone temperature logging on a single GPIO', 'Water temperature with the waterproof probe'],
    simulator: {
      part: 'wokwi-ds18b20',
      supported: false,
      notes:
        'Wokwi.com ships a DS18B20 part, but the bundled Velxio build has NO DS18B20 element (verified against its pinned ' +
        '@wokwi/elements and components-metadata.json). Claiming it would draw a part with no pins and silently drop ' +
        'every wire. For a simulated temperature input use the DHT22; on the bench the DS18B20 remains the better part.',
    },
    metadata: {
      electrical: true,
      requiresPullup: true,
      pullupOhms: 4700,
      resolutionBits: [9, 10, 11, 12],
      conversionTimeMs: 750,
      rangeC: [-55, 125],
      parasitePowerSupported: true,
    },
  }),

  def({
    id: 'bh1750-light-sensor',
    name: 'BH1750 digital ambient light sensor',
    category: 'sensor',
    description:
      'I2C 16-bit ambient light sensor reading directly in lux (1–65535 lx) with a spectral response close to the human eye — no calibration curve, unlike an LDR. Address is 0x23 with ADDR low, 0x5C with ADDR high.',
    voltage: 3.3,
    minVoltage: 2.4,
    maxVoltage: 3.6,
    currentRequirements: { typicalMa: 0.12, maxMa: 0.19, note: '120 µA active, 1 µA in power-down.' },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 3.3, signal: 'Supply 2.4–3.6 V (modules with a regulator accept 5 V)', aliases: ['VIN', 'VDD', '+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-'] }),
      pin('SCL', 'i2c', 'input', { required: true, signal: 'I2C clock', aliases: ['SCK'] }),
      pin('SDA', 'i2c', 'bidirectional', { required: true, signal: 'I2C data' }),
      pin('ADDR', 'digital', 'input', { required: false, signal: 'Address select: LOW/floating = 0x23, HIGH = 0x5C', aliases: ['ADD'] }),
    ],
    communicationProtocols: ['i2c'],
    libraryRequirements: [
      { name: 'BH1750', import: 'BH1750.h', manager: 'arduino', repository: 'https://github.com/claws/BH1750', purpose: 'Lux measurement modes' },
      { name: 'Wire', import: 'Wire.h', manager: 'arduino', purpose: 'I2C bus', builtIn: true },
    ],
    keywords: ['bh1750', 'light', 'lux', 'ambient light', 'illuminance', 'photometer'],
    aliases: ['bh1750', 'gy-302', 'lux sensor', 'light sensor i2c'],
    simulator: { supported: false },
    metadata: { electrical: true, i2cAddress: '0x23', i2cAddressAlt: '0x5C', rangeLux: [1, 65535], logicVoltage: 3.3 },
  }),

  def({
    id: 'ina219-current-sensor',
    name: 'INA219 current / voltage monitor',
    category: 'sensor',
    description:
      'High-side I2C current and bus-voltage monitor: measures up to ±3.2 A through the on-board 0.1 Ω shunt with 0.8 mA resolution, and bus voltage up to 26 V. Four address pins allow 16 devices on one bus. Use it to actually measure a power budget instead of estimating it.',
    voltage: 3.3,
    minVoltage: 3,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 1, maxMa: 1, note: 'Supply current of the monitor itself.' },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 3.3, signal: 'Logic supply 3–5.5 V', aliases: ['VIN', 'VS', '+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-'] }),
      pin('SCL', 'i2c', 'input', { required: true, signal: 'I2C clock' }),
      pin('SDA', 'i2c', 'bidirectional', { required: true, signal: 'I2C data' }),
      pin('VIN+', 'power', 'input', { required: true, signal: 'Shunt input from the supply side', aliases: ['IN+', 'VINP'] }),
      pin('VIN-', 'power', 'output', { required: true, signal: 'Shunt output to the load side', aliases: ['IN-', 'VINM'] }),
    ],
    communicationProtocols: ['i2c'],
    libraryRequirements: [
      { name: 'Adafruit INA219', import: 'Adafruit_INA219.h', manager: 'arduino', repository: 'https://github.com/adafruit/Adafruit_INA219', purpose: 'Shunt/bus voltage and current reads' },
      { name: 'Wire', import: 'Wire.h', manager: 'arduino', purpose: 'I2C bus', builtIn: true },
    ],
    keywords: ['ina219', 'current sensor', 'power monitor', 'shunt', 'voltage', 'battery monitoring'],
    aliases: ['ina219', 'current sensor', 'power monitor'],
    exampleUsage: ['Measuring real motor current draw during a stall test', 'Battery discharge logging'],
    simulator: { supported: false },
    metadata: { electrical: true, i2cAddress: '0x40', shuntOhms: 0.1, maxBusVoltage: 26, maxCurrentA: 3.2, measurementSide: 'high-side' },
  }),

  def({
    id: 'ir-receiver-tsop38238',
    name: 'TSOP38238 38 kHz IR receiver',
    category: 'sensor',
    description:
      'Three-pin demodulating infrared receiver tuned to a 38 kHz carrier: it outputs the decoded bitstream (active low) so the MCU only sees the data, not the carrier. Works with almost any consumer remote at up to ~10 m. A 100 Ω series resistor and 4.7 µF decoupling capacitor are recommended on the supply.',
    voltage: 5,
    minVoltage: 2.5,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 0.7, maxMa: 1.5 },
    pins: [
      pin('OUT', 'digital', 'output', { required: true, signal: 'Demodulated data, idles HIGH and pulses LOW (pin 1)', aliases: ['SIG', 'DATA', 'Y'] }),
      pin('GND', 'ground', 'ground', { required: true, signal: 'Ground (pin 2)', aliases: ['-'] }),
      pin('VS', 'power', 'power', { required: true, voltage: 5, signal: 'Supply 2.5–5.5 V (pin 3)', aliases: ['VCC', 'VDD', '+'] }),
    ],
    libraryRequirements: [
      { name: 'IRremote', import: 'IRremote.hpp', manager: 'arduino', repository: 'https://github.com/Arduino-IRremote/Arduino-IRremote', purpose: 'Decoding NEC/RC5/Sony remote protocols' },
    ],
    keywords: ['ir receiver', 'infrared', 'tsop', '38khz', 'remote control', 'nec'],
    aliases: ['tsop38238', 'ir receiver', 'vs1838b', 'infrared receiver'],
    exampleUsage: ['Controlling a robot from a TV remote', 'IR-triggered relay'],
    simulator: {
      part: 'wokwi-ir-receiver',
      supported: true,
      notes: '38 kHz demodulator on the element’s DAT pin; remote codes drive it, idle is HIGH.',
    },
    metadata: { electrical: true, carrierFrequencyHz: 38000, activeLow: true, pinOrder: 'OUT, GND, VS (looking at the domed face)' },
  }),

  def({
    id: 'load-cell-hx711',
    name: 'HX711 24-bit load-cell amplifier',
    category: 'sensor',
    description:
      '24-bit ADC dedicated to strain-gauge bridges: connects a 4-wire load cell (E+/E-/A+/A-) to two ordinary GPIOs through a bit-banged clock/data protocol. Selectable gain 128/64 (channel A) or 32 (channel B), 10 or 80 samples per second. Needs a tare and a known-mass calibration factor in firmware.',
    voltage: 5,
    minVoltage: 2.6,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 1.5, maxMa: 2 },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, signal: 'Digital supply 2.6–5.5 V', aliases: ['VDD', '+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-'] }),
      pin('DT', 'digital', 'output', { required: true, signal: 'Serial data out — goes LOW when a conversion is ready', aliases: ['DOUT', 'DATA', 'SDA'] }),
      pin('SCK', 'digital', 'input', { required: true, signal: 'Serial clock in (also sets gain by pulse count)', aliases: ['PD_SCK', 'CLK', 'SCL'] }),
      pin('E+', 'power', 'output', { required: true, signal: 'Bridge excitation + (to the load cell red wire)', aliases: ['EXC+', 'RED'] }),
      pin('E-', 'ground', 'output', { required: true, signal: 'Bridge excitation - (to the load cell black wire)', aliases: ['EXC-', 'BLACK'] }),
      pin('A+', 'analog', 'input', { required: true, signal: 'Channel A signal + (load cell white/green wire)', aliases: ['SIG+', 'WHITE'] }),
      pin('A-', 'analog', 'input', { required: true, signal: 'Channel A signal - (load cell green/white wire)', aliases: ['SIG-', 'GREEN'] }),
      pin('B+', 'analog', 'input', { required: false, signal: 'Channel B signal + (fixed gain 32)' }),
      pin('B-', 'analog', 'input', { required: false, signal: 'Channel B signal -' }),
    ],
    libraryRequirements: [
      { name: 'HX711', import: 'HX711.h', manager: 'arduino', repository: 'https://github.com/bogde/HX711', purpose: 'Reading and scaling the 24-bit bridge value' },
    ],
    keywords: ['hx711', 'load cell', 'weight', 'scale', 'strain gauge', 'force'],
    aliases: ['hx711', 'load cell amplifier', 'weight sensor', 'scale module'],
    exampleUsage: ['Digital kitchen/parcel scale', 'Filament runout and weight monitoring'],
    simulator: {
      part: 'wokwi-hx711',
      supported: true,
      notes: 'Velxio emulates the DT/SCK bit protocol and lets you set a known weight on the part. The bridge-side pins (E±/A±/B±) are real header pins, but the load cell itself has no model — the simulator reports the configured weight, not physics.',
    },
    metadata: { electrical: true, adcBits: 24, gainOptions: [128, 64, 32], sampleRateHz: [10, 80], requiresCalibration: true },
  }),

  def({
    id: 'mq-2-gas-sensor',
    name: 'MQ-2 gas / smoke sensor module',
    category: 'sensor',
    description:
      'Heated tin-dioxide sensor for LPG, propane, hydrogen, methane and smoke. The module carries an on-board heater, a comparator with a digital output (DO) and an analog output (AO) for ppm estimation. 5 V supply, heater draws 150–800 mA and needs 24–48 h burn-in for stable readings.',
    voltage: 5,
    minVoltage: 5,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 150, maxMa: 800, note: 'Heater current — cannot be powered from a 3.3 V MCU regulator pin.' },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
      pin('AO', 'analog', 'output', { required: false, signal: 'Analog gas concentration', aliases: ['A0', 'ANALOG'] }),
      pin('DO', 'digital', 'output', { required: false, signal: 'Digital threshold alarm (active low on most modules)', aliases: ['D0', 'DOUT'] }),
    ],
    keywords: ['mq-2', 'mq2', 'gas', 'smoke', 'lpg', 'air quality', 'flammable'],
    aliases: ['mq2', 'mq-2', 'mq series', 'gas sensor', 'smoke sensor'],
    simulator: {
      part: 'wokwi-gas-sensor',
      supported: true,
      notes: 'Velxio models AOUT/DOUT against a configurable gas level. The heater warm-up and the 24–48 h burn-in are not modelled.',
    },
    metadata: { electrical: true, heaterCurrentMa: 800, burnInHours: 24, detectionPpm: { lpg: [300, 10000], smoke: [100, 1000] } },
  }),

  def({
    id: 'ntc-thermistor-module',
    name: 'NTC thermistor temperature module (analog out)',
    category: 'sensor',
    description:
      '10 kΩ NTC thermistor on a comparator board with a single amplified output. Read OUT with an ADC pin and convert with the beta/Steinhart-Hart equation — the module only scales the divider, it does not linearise. Output falls as temperature rises (NTC: resistance drops when hot).',
    voltage: 5,
    minVoltage: 3.3,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 1, maxMa: 10, note: 'Divider + comparator quiescent current; the NTC leg dominates.' },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
      pin('OUT', 'analog', 'output', { required: true, signal: 'Scaled divider voltage — colder = higher', aliases: ['AO', 'A0', 'SIG', 'S'] }),
    ],
    keywords: ['ntc', 'thermistor', 'temperature', 'analog temperature', 'thermal'],
    aliases: ['ntc temperature sensor', 'thermistor module', 'ntc module', 'ntc sensor'],
    simulator: {
      part: 'wokwi-ntc-temperature-sensor',
      supported: true,
      notes: 'Velxio maps the temperature you set on the part to the OUT voltage. Only the single OUT pin is modelled — there is no digital threshold output on this element.',
    },
    metadata: { electrical: true, resistanceOhm: 10000, betaCoefficient: 3950, requiresAdc: true, accuracyNote: 'Beta equation ≈ ±1 °C over 0–70 °C after a two-point calibration.' },
  }),

  def({
    id: 'tilt-sensor-module',
    name: 'Tilt sensor module (SW-520D ball switch)',
    category: 'sensor',
    description:
      'Metal-ball tilt switch on a comparator board: OUT pulses LOW (on most boards) while the ball rolls and goes stable when the module settles past ~±10° from horizontal. Digital-only output — for a continuous angle use an accelerometer such as the MPU6050. Debounce: the ball chatters while moving.',
    voltage: 5,
    minVoltage: 3.3,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 1, maxMa: 10 },
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
      pin('OUT', 'digital', 'output', { required: true, signal: 'Tilt alarm — pulses while the ball rolls', aliases: ['DO', 'SIG', 'S'] }),
    ],
    keywords: ['tilt', 'sw-520d', 'ball switch', 'vibration', 'tilt sensor', 'fall detection'],
    aliases: ['tilt sensor', 'tilt switch', 'sw520d', 'ball tilt sensor'],
    simulator: {
      part: 'wokwi-tilt-switch',
      supported: true,
      notes: 'Velxio tilts the part on click and drives OUT accordingly. The comparator threshold and ball chatter are not modelled.',
    },
    metadata: { electrical: true, activeLevel: 'low', triggerAngleDeg: 10, requiresPullup: true, recommendedDebounceMs: 50 },
  }),

  def({
    id: 'gps-neo6m-module',
    name: 'u-blox NEO-6M GPS module',
    category: 'sensor',
    description:
      'u-blox NEO-6 receiver on a breakout with antenna, backup battery holder and status LED. Streams NMEA 0183 sentences (GGA/RMC/VTG) over UART at 9600 baud; a TinyGPS-class parser assembles position, altitude, speed, course and UTC time. 2.5 m CEP accuracy outdoors, 50 channels, ~27 s typical cold start (1 s hot). Give it clear sky view — accuracy collapses indoors.',
    voltage: 5,
    minVoltage: 3.3,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 45, maxMa: 67, note: 'Acquisition at full power; backup mode ~11 uA when main supply is removed.' },
    communicationProtocols: ['uart'],
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
      pin('TX', 'uart', 'output', { required: true, signal: 'NMEA data out — wire to the MCU RX', aliases: ['TXD'] }),
      pin('RX', 'uart', 'input', { required: true, signal: 'Configuration commands in — wire from the MCU TX (optional if you only read)', aliases: ['RXD'] }),
      pin('PPS', 'digital', 'output', { required: false, signal: 'Pulse-per-second, accurate to ~ns — wire only when time-syncing, not needed for position', aliases: ['PP', 'TIMEPULSE'] }),
    ],
    libraryRequirements: [
      { name: 'TinyGPSPlus', import: 'TinyGPS++.h', manager: 'arduino', repository: 'https://github.com/mikalhart/TinyGPSPlus', purpose: 'NMEA sentence parsing' },
    ],
    keywords: ['gps', 'neo-6m', 'neo6m', 'ublox', 'navigation', 'position', 'tracking', 'nmea'],
    aliases: ['gps', 'gps module', 'neo-6m', 'neo6m', 'ublox gps'],
    exampleUsage: ['Speedometer / trip logger for a bike or car', 'Geofence alert when leaving an area'],
    simulator: {
      part: 'wokwi-gps-neo6m',
      supported: true,
      notes: 'Velxio injects real NMEA sentences into the UART at ~9600 baud from the fix you set on the part (lat/lng/altitude/speed/course), so TinyGPS++ decodes them exactly like real hardware. PPS and cold-start fix timing are not modelled.',
    },
    metadata: { electrical: true, uartBaud: 9600, nmeaSentences: ['GGA', 'RMC', 'VTG'], accuracyCepM: 2.5, channels: 50, coldStartS: 27 },
  }),

  def({
    id: 'rtc-ds3231-module',
    name: 'DS3231 high-precision RTC module (ZS-042)',
    category: 'sensor',
    description:
      'Temperature-compensated real-time clock: ±2 ppm between 0-40 °C (about ±1 minute per year), seconds/minutes/hours/day/date/month/year with leap-year correction, on-chip aging trim and an integrated temperature sensor readable over I2C. The ZS-042 breakout adds a CR2032 backup holder so time survives power loss, plus SQW and 32K output pins. Careful on a shared bus: the DS3231 answers at 0x68 — the SAME address as an MPU6050. Move the IMU to 0x69 (AD0 high) or use one or the other.',
    voltage: 5,
    minVoltage: 3.3,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 0.3, maxMa: 1, note: 'Timekeeping ~84 uA on the backup battery; the module power LED dominates in-circuit.' },
    communicationProtocols: ['i2c'],
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
      pin('SDA', 'i2c', 'bidirectional', { required: true, signal: 'I2C data', aliases: ['D'] }),
      pin('SCL', 'i2c', 'input', { required: true, signal: 'I2C clock', aliases: ['C'] }),
      pin('SQW', 'digital', 'output', { required: false, signal: 'Programmable square wave 1 Hz-8 kHz (also a configurable alarm pin)', aliases: ['SQW/OUT'] }),
      pin('32K', 'digital', 'output', { required: false, signal: '32.768 kHz clock output, enabled by register', aliases: ['32KHZ'] }),
    ],
    libraryRequirements: [
      { name: 'RTClib', import: 'RTClib.h', manager: 'arduino', repository: 'https://github.com/adafruit/RTClib', purpose: 'DS3231 register driver and DateTime helpers' },
      { name: 'Wire', import: 'Wire.h', manager: 'arduino', purpose: 'I2C bus', builtIn: true },
    ],
    keywords: ['ds3231', 'rtc', 'real time clock', 'clock', 'timekeeping', 'alarm', 'calendar'],
    aliases: ['ds3231', 'rtc module', 'real time clock', 'real-time clock', 'zs-042'],
    exampleUsage: ['Data logger with correct timestamps on an SD card', 'Timed feeder or irrigation controller'],
    simulator: {
      part: 'wokwi-ds3231',
      supported: true,
      notes: 'Velxio emulates the I2C register map at 0x68 — time registers plus control/status and the temperature register (default 25 °C, settable on the part). The SQW and 32K outputs are not modelled.',
    },
    metadata: { electrical: true, i2cAddress: '0x68', i2cAddressConflict: 'Same 0x68 as the MPU6050 — move the IMU to 0x69 (AD0 high) if both share the bus.', i2cMaxClockHz: 400000, accuracyPpm: 2, batteryBackup: 'CR2032', temperatureSensor: true },
  }),
];
