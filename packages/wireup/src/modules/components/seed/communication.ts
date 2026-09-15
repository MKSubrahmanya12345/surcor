/** Communication module seed entries. */

import type { ComponentDefinition } from '@/types/component';

import { def, pin } from './helpers';

export const COMMUNICATION: ComponentDefinition[] = [
  def({
    id: 'hc-05-bluetooth',
    name: 'HC-05 Bluetooth Classic module (master/slave)',
    category: 'communication',
    description:
      'Bluetooth 2.0 + EDR SPP module that can act as master or slave. Configurable via AT commands (default AT baud 38400, data baud 9600). VCC accepts 3.6–6 V, but all I/O pins are 3.3 V — a 5 V MCU must level shift or divide the module RXD line. Cross-connect: module TXD to MCU RX, module RXD to MCU TX.',
    voltage: 3.3,
    minVoltage: 3.6,
    maxVoltage: 6,
    currentRequirements: { typicalMa: 30, maxMa: 40, note: '~30–40 mA paired and streaming, ~10 mA idle.' },
    communicationProtocols: ['uart', 'bluetooth'],
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
      pin('TXD', 'uart', 'output', { required: true, signal: 'Module transmit → MCU RX (3.3 V logic)', aliases: ['TX', 'TXO'] }),
      pin('RXD', 'uart', 'input', { required: true, signal: 'Module receive ← MCU TX (3.3 V max — level shift from 5 V)', aliases: ['RX', 'RXI'] }),
      pin('STATE', 'digital', 'output', { required: false, signal: 'HIGH when a Bluetooth connection is established', aliases: ['LED', 'STATUS'] }),
      pin('KEY', 'digital', 'input', { required: false, signal: 'Hold HIGH at power-up to enter AT command mode', aliases: ['EN', 'KEY_EN'] }),
    ],
    compatibleMicrocontrollers: ['arduino-uno-r3', 'arduino-nano', 'esp32-devkit-v1'],
    keywords: ['hc-05', 'hc05', 'bluetooth', 'spp', 'serial bluetooth', 'phone control'],
    aliases: ['hc-05', 'hc05', 'bluetooth module', 'bluetooth classic module'],
    simulator: { supported: false, notes: 'Bluetooth radio is not simulated; expose as a UART peer.' },
    metadata: {
      electrical: true,
      logicVoltage: 3.3,
      fiveVoltTolerantPins: false,
      levelShiftRequiredWith5vMcu: true,
      defaultBaud: 9600,
      atBaud: 38400,
      bluetoothProfile: 'SPP',
      role: 'master/slave',
    },
  }),

  def({
    id: 'hc-06-bluetooth',
    name: 'HC-06 Bluetooth Classic module (slave only)',
    category: 'communication',
    description:
      'Slave-only Bluetooth 2.0 SPP module — it can only be connected to by a phone or PC, never initiate connections. Simpler and cheaper than the HC-05. Same 3.3 V I/O caveat: level shift RXD when the MCU is 5 V.',
    voltage: 3.3,
    minVoltage: 3.6,
    maxVoltage: 6,
    currentRequirements: { typicalMa: 30, maxMa: 40 },
    communicationProtocols: ['uart', 'bluetooth'],
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 5, aliases: ['+', 'V+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-', 'V-'] }),
      pin('TXD', 'uart', 'output', { required: true, signal: 'Module transmit → MCU RX', aliases: ['TX'] }),
      pin('RXD', 'uart', 'input', { required: true, signal: 'Module receive ← MCU TX (3.3 V max)', aliases: ['RX'] }),
      pin('STATE', 'digital', 'output', { required: false, signal: 'Connection status', aliases: ['LED'] }),
    ],
    compatibleMicrocontrollers: ['arduino-uno-r3', 'arduino-nano', 'esp32-devkit-v1'],
    keywords: ['hc-06', 'hc06', 'bluetooth', 'spp', 'slave', 'phone control'],
    aliases: ['hc-06', 'hc06', 'bluetooth slave module'],
    simulator: { supported: false, notes: 'Bluetooth radio is not simulated; expose as a UART peer.' },
    metadata: {
      electrical: true,
      logicVoltage: 3.3,
      levelShiftRequiredWith5vMcu: true,
      defaultBaud: 9600,
      bluetoothProfile: 'SPP',
      role: 'slave',
    },
  }),

  def({
    id: 'esp32-bluetooth-wifi-capability',
    name: 'ESP32 integrated Bluetooth / Wi-Fi radio',
    category: 'communication',
    description:
      'The radio built into the ESP32: Bluetooth Classic (SPP via BluetoothSerial) and BLE, plus Wi-Fi 802.11 b/g/n (station, AP, or both). This is an integrated capability, not a separate part — it needs no wiring, no extra pins and no extra components.',
    voltage: 3.3,
    currentRequirements: { typicalMa: 80, maxMa: 500, note: 'Shared with the ESP32 board supply; radio bursts dominate the 3.3 V budget.' },
    communicationProtocols: ['bluetooth', 'ble', 'wifi', 'tcp', 'udp', 'http'],
    compatibleMicrocontrollers: ['esp32-devkit-v1'],
    pins: [],
    powerPins: [],
    groundPins: [],
    libraryRequirements: [
      { name: 'BluetoothSerial', import: 'BluetoothSerial.h', manager: 'arduino', purpose: 'Bluetooth Classic SPP link to a phone', builtIn: true },
      { name: 'BLE Device', import: 'BLEDevice.h', manager: 'arduino', purpose: 'Bluetooth Low Energy GATT server', builtIn: true },
      { name: 'WiFi', import: 'WiFi.h', manager: 'arduino', purpose: 'Wi-Fi station / access point', builtIn: true },
    ],
    keywords: ['bluetooth', 'ble', 'wifi', 'wi-fi', 'wireless', 'esp32 bluetooth', 'phone control', 'app control'],
    aliases: ['esp32 bluetooth', 'esp32 wifi', 'built-in bluetooth', 'integrated bluetooth', 'esp32 ble', 'bluetoothserial'],
    exampleUsage: ['BluetoothSerial SPP control of an RC car from a phone terminal app'],
    metadata: {
      integrated: true,
      hostComponentId: 'esp32-devkit-v1',
      electrical: false,
      participatesInWiring: false,
      note: 'Selecting this instead of an external HC-05/HC-06 avoids level shifting and frees the UART pins.',
    },
  }),

  def({
    id: 'esp8266-esp01-wifi',
    name: 'ESP8266 ESP-01 Wi-Fi module',
    category: 'communication',
    description:
      'Minimal Wi-Fi module controlled over AT commands on a 3.3 V UART. Needs a 3.3 V supply capable of ~300 mA bursts and careful level shifting when attached to a 5 V MCU. Only two usable GPIO (GPIO0/GPIO2).',
    voltage: 3.3,
    minVoltage: 3.0,
    maxVoltage: 3.6,
    currentRequirements: { typicalMa: 70, maxMa: 300, note: 'Wi-Fi transmit bursts; a 3.3 V regulator with 10 µF + 100 nF decoupling is required.' },
    communicationProtocols: ['uart', 'wifi', 'tcp'],
    pins: [
      pin('VCC', 'power', 'power', { required: true, voltage: 3.3, aliases: ['+'] }),
      pin('GND', 'ground', 'ground', { required: true, aliases: ['-'] }),
      pin('TX', 'uart', 'output', { required: true, aliases: ['TXD'] }),
      pin('RX', 'uart', 'input', { required: true, aliases: ['RXD'] }),
      pin('CH_PD', 'enable', 'input', { required: true, signal: 'Chip enable — must be HIGH', aliases: ['EN', 'CE'] }),
      pin('RST', 'control', 'input', { required: false, aliases: ['RESET'] }),
      pin('GPIO0', 'digital', 'bidirectional', { required: false, signal: 'Strapping pin — HIGH for normal boot' }),
      pin('GPIO2', 'digital', 'bidirectional', { required: false, signal: 'Strapping pin — HIGH for normal boot' }),
    ],
    keywords: ['esp8266', 'esp-01', 'wifi', 'at commands', 'wireless'],
    aliases: ['esp8266', 'esp-01', 'esp01'],
    simulator: { supported: false, notes: 'Expose as a UART peer.' },
    metadata: { electrical: true, logicVoltage: 3.3, levelShiftRequiredWith5vMcu: true, defaultBaud: 115200 },
  }),
];
