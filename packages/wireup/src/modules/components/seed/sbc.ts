/**
 * Single-board computer seed entries — the "software project on a box of
 * hardware" class (Raspberry Pi + camera).
 *
 * These are full Linux machines, not MCUs: firmware is Python (or anything
 * else), the pin "map" is the 40-pin header, and cameras/USB devices attach
 * by connector, not by wiring. The catalog entries only assert real,
 * well-known facts (the default bus pins); the rest is labelled general
 * purpose rather than inventing a mapping.
 */

import type { ComponentDefinition } from '@/types/component';

import { def, pin } from './helpers';

/** A general-purpose 3.3 V GPIO on the 40-pin header. */
const gp = (bcm: number, note: string) =>
  pin(`GPIO${bcm}`, 'digital', 'bidirectional', { signal: `General-purpose 3.3 V GPIO (BCM ${bcm}) — ${note}`, aliases: [] });

export const SBC: ComponentDefinition[] = [
  def({
    id: 'raspberry-pi-5',
    name: 'Raspberry Pi 5 (single-board computer)',
    category: 'microcontroller',
    description:
      'Quad-core Cortex-A76 (2.4 GHz) Linux SBC, 4/8/16 GB LPDDR4X. Runs full user-space software (Python, OpenCV, web servers) — not an Arduino sketch. ' +
      '40-pin GPIO header (3.3 V logic, 16 mA max per pin), one CSI-2 camera port, 2× USB 3, GbE, HDMI. Powered over USB-C (5 V, 5 A — use the 27 W PSU).',
    voltage: 5,
    minVoltage: 5,
    maxVoltage: 5.25,
    currentRequirements: {
      typicalMa: 1200,
      maxMa: 5000,
      note: 'Use the official 27 W USB-C power supply; a CSI camera adds ~250 mA.',
    },
    communicationProtocols: ['i2c', 'spi', 'uart', 'usb', 'csi', 'hdmi', 'gbe'],
    compatibleMicrocontrollers: [],
    pins: [
      pin('USB-C 5V', 'power', 'power', { required: true, signal: '5 V input from the USB-C PSU', aliases: ['5V-USB', 'VIN'] }),
      pin('5V', 'power', 'power', { required: false, signal: '5 V header rail', aliases: ['VCC', 'VCC5V'] }),
      pin('3V3', 'power', 'power', { required: false, signal: '3.3 V header rail', aliases: ['3.3V', 'VCC3V3'] }),
      pin('GND', 'ground', 'ground', { required: true, signal: 'Common ground (multiple header positions)', aliases: ['0V'] }),
      // I2C1 (primary) — the default I2C bus.
      pin('GPIO2', 'i2c', 'bidirectional', { signal: 'I2C1 SDA (default SDA)', aliases: ['SDA1', 'SDA'] }),
      pin('GPIO3', 'i2c', 'bidirectional', { signal: 'I2C1 SCL (default SCL)', aliases: ['SCL1', 'SCL'] }),
      // UART0 (the real serial port).
      pin('GPIO14', 'uart', 'bidirectional', { signal: 'UART0 TX (TxD)', aliases: ['TXD0', 'TX'] }),
      pin('GPIO15', 'uart', 'bidirectional', { signal: 'UART0 RX (RxD)', aliases: ['RXD0', 'RX'] }),
      // SPI0 — the default SPI bus.
      pin('GPIO8', 'spi', 'bidirectional', { signal: 'SPI0 CS0 (chip select)', aliases: ['CE0', 'CS0'] }),
      pin('GPIO9', 'spi', 'bidirectional', { signal: 'SPI0 MISO (data in)', aliases: ['MISO0'] }),
      pin('GPIO10', 'spi', 'bidirectional', { signal: 'SPI0 MOSI (data out)', aliases: ['MOSI0'] }),
      pin('GPIO11', 'spi', 'bidirectional', { signal: 'SPI0 SCLK (clock)', aliases: ['SCLK0', 'SCK'] }),
      // General purpose (no fixed default function asserted).
      gp(4, 'free GPIO'),
      gp(17, 'free GPIO'),
      gp(22, 'free GPIO'),
      gp(23, 'free GPIO'),
      gp(24, 'free GPIO'),
      gp(25, 'free GPIO'),
      gp(27, 'free GPIO'),
      gp(5, 'free GPIO'),
      gp(6, 'free GPIO'),
      // On-board peripherals (connector, not wiring).
      pin('CSI', 'control', 'bidirectional', { required: false, signal: 'CSI-2 camera ribbon connector — a Pi camera attaches here, no wiring', aliases: ['CAMERA', 'CAM'] }),
      pin('USB3-A', 'control', 'bidirectional', { required: false, signal: 'USB 3 Type-A port — USB devices and webcams', aliases: ['USB'] }),
      pin('HDMI', 'control', 'bidirectional', { required: false, signal: 'HDMI video out (headless builds omit it)', aliases: [] }),
    ],
    aliases: ['raspberry pi 5', 'raspi 5', 'pi 5', 'raspberry-pi-5', 'raspi'],
    keywords: ['raspberry pi', 'sbc', 'linux', 'camera', 'python', 'face recognition', 'opencv'],
    metadata: { formFactor: 'sbc', logicVoltage: 3.3, os: 'Raspberry Pi OS (Linux)' },
  }),
  def({
    id: 'raspberry-pi-camera-module',
    name: 'Raspberry Pi Camera Module (CSI)',
    category: 'sensor',
    description:
      'Raspberry Pi official camera (IMX477 12 MP, or the IMX708 12 MP global-shutter variant). Attaches to the Pi by CSI ribbon — no power or signal wiring. ' +
      'Appears to OpenCV as /dev/video0 via the V4L2/libcamera stack. Powered by the Pi.',
    communicationProtocols: ['csi'],
    compatibleMicrocontrollers: ['raspberry-pi-5'],
    pins: [
      pin('CSI', 'control', 'bidirectional', { required: true, signal: 'CSI-2 ribbon connector to the Pi camera port', aliases: ['CAM', 'CAMERA'] }),
    ],
    libraryRequirements: [
      {
        name: 'OpenCV (Python)',
        import: 'cv2',
        manager: 'pip',
        purpose: 'Video capture + detection from the CSI camera (cv2.VideoCapture(0)).',
      },
    ],
    aliases: ['pi camera', 'raspberry pi camera', 'camera module', 'csi camera', 'pi cam'],
    keywords: ['camera', 'csi', 'face', 'vision', 'opencv'],
    metadata: { resolution: '12 MP', connector: 'CSI-2 ribbon', power: 'from the Pi (no separate supply)', noSupplyPins: true },
  }),
  def({
    id: 'usb-webcam-generic',
    name: 'USB webcam (UVC, generic)',
    category: 'sensor',
    description:
      'Any USB Video Class webcam (1080p class). Needs only a USB connection — it appears as /dev/video0 (or the next free index) and OpenCV can open it by index. ' +
      'The practical route for MORE cameras than the Pi CSI ports allow.',
    voltage: 5,
    minVoltage: 4.5,
    maxVoltage: 5.5,
    currentRequirements: { typicalMa: 150, maxMa: 500, note: 'USB 2 provides 500 mA; a hub with its own supply is fine.' },
    communicationProtocols: ['usb'],
    compatibleMicrocontrollers: ['raspberry-pi-5'],
    pins: [
      pin('USB', 'control', 'bidirectional', { required: true, signal: 'USB connection (video + power) to a Pi USB port', aliases: ['USB-A'] }),
    ],
    libraryRequirements: [
      {
        name: 'OpenCV (Python)',
        import: 'cv2',
        manager: 'pip',
        purpose: 'Open the webcam by index: cv2.VideoCapture(index).',
      },
    ],
    aliases: ['webcam', 'usb camera', 'usb webcam'],
    keywords: ['webcam', 'usb', 'camera', 'face', 'vision'],
    metadata: { standard: 'UVC (USB Video Class)', power: 'from USB', noSupplyPins: true },
  }),
];
