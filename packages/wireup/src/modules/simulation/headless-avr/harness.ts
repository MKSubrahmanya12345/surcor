/**
 * Headless AVR simulation harness using avr8js.
 *
 * Generalized from external/velxio/test/test_circuit/src/avr/AVRHarness.js
 * to support dynamic pin assignments and wiring graphs from the project's
 * wiring plan.
 *
 * This module provides real AVR8 instruction-level emulation without a browser,
 * enabling the validation pipeline to execute compiled firmware and verify
 * behavioral assertions against actual peripheral behavior.
 *
 * Input driving model (this is what makes scenario steps real):
 *   • `AVRIOPort.setPin(bit, level)` is the avr8js API for external pin drive —
 *     it feeds the PIN register the firmware's `digitalRead()` actually reads.
 *   • Pins an INPUT_PULLUP configures (DDR=0, PORT bit=1) idle HIGH like real
 *     hardware until a scenario step drives them; the pull-up state is
 *     re-applied whenever the firmware reconfigures the port.
 *   • Serial RX steps are injected through `AVRUSART.writeByte()`, the same
 *     path a real UART byte takes (RXC flag + interrupt).
 *
 * `run()` is async and yields to the event loop every chunk of cycles: a
 * 30-second virtual-time simulation is hundreds of millions of emulated
 * instructions, and this runs inside a Next.js server — it must not freeze
 * every other request while the firmware executes.
 */

import {
  CPU,
  AVRIOPort,
  AVRTimer,
  AVRADC,
  AVRUSART,
  portBConfig,
  portCConfig,
  portDConfig,
  timer0Config,
  timer1Config,
  timer2Config,
  adcConfig,
  usart0Config,
  avrInstruction,
  type AVRPortConfig,
} from 'avr8js';

import { parseIntelHex, bytesToProgramWords } from './intel-hex';
import type { PinAssignment } from '@/types/wiring';
import type { FirmwareTrace, TracePinEvent, TraceServoEvent, TraceSerialLine } from '@/types/behavioral';

type PortName = 'B' | 'C' | 'D';

const PORT_CONFIGS: Record<PortName, AVRPortConfig> = {
  B: portBConfig,
  C: portCConfig,
  D: portDConfig,
};

/**
 * PWM-capable Arduino Uno pins and their OCR registers (data-space addresses).
 *
 * Timer1 pins (9/10) are read as full 16-bit values: the Arduino Servo library
 * drives OCR1A/OCR1B in 4µs ticks (16 MHz, prescaler 64), so a 1000–2000µs
 * pulse is 250–500 counts — reading only the low byte made servo angles jump
 * randomly between 0° and 180°. The 8-bit timer pins carry LED/motor PWM
 * duty, which is NOT a servo angle, so they never emit servo events.
 */
const PWM_PINS: { pin: number; ocrLow: number; ocrHigh: number | null }[] = [
  { pin: 6, ocrLow: 0x47, ocrHigh: null }, // OCR0A
  { pin: 5, ocrLow: 0x48, ocrHigh: null }, // OCR0B
  { pin: 9, ocrLow: 0x88, ocrHigh: 0x89 }, // OCR1A (16-bit)
  { pin: 10, ocrLow: 0x8a, ocrHigh: 0x8b }, // OCR1B (16-bit)
  { pin: 11, ocrLow: 0xb3, ocrHigh: null }, // OCR2A
  { pin: 3, ocrLow: 0xb4, ocrHigh: null }, // OCR2B
];

/** µs per OCR1 tick for the Arduino AVR Servo library at 16 MHz (prescaler 64). */
const SERVO_US_PER_TICK = 4;
/** Servo pulse window we accept as "looks like a servo" (µs). */
const SERVO_PULSE_MIN_US = 500;
const SERVO_PULSE_MAX_US = 2500;

// Arduino Uno pin ↔ (port, bit)
// PORTD bit 0..7 → D0..D7
// PORTB bit 0..5 → D8..D13
// PORTC bit 0..5 → A0..A5 (pins 14..19)
const PIN_MAP: Record<number, { portName: PortName; bit: number }> = {};
for (let i = 0; i < 8; i++) PIN_MAP[i] = { portName: 'D', bit: i };
for (let i = 0; i < 6; i++) PIN_MAP[8 + i] = { portName: 'B', bit: i };
for (let i = 0; i < 6; i++) PIN_MAP[14 + i] = { portName: 'C', bit: i };

/** ATmega328P SRAM: 2 KiB (data space 0x100..0x8FF). */
const SRAM_BYTES = 0x800;
/** ATmega328P flash: 32 KiB = 16K instruction words. */
const FLASH_WORDS = 0x8000 / 2;

/** Yield to the Node event loop this often while emulating (in CPU cycles). */
const YIELD_EVERY_CYCLES = 250_000;

/** Peripherals that can be attached to the harness. */
export interface HarnessPeripheral {
  id: string;
  type: 'button' | 'led' | 'servo' | 'dht' | 'ultrasonic' | 'potentiometer' | 'generic';
  /** Arduino pin number (0-19 for Uno). */
  pin: number;
  /** Initial state for inputs. */
  initialState?: unknown;
}

/** Scripted input step for the harness. */
export interface HarnessScenarioStep {
  atMs: number;
  kind: 'pin' | 'serial' | 'adc';
  /** For 'pin': pin number to drive. */
  pin?: number;
  /** For 'pin': level to set (0=LOW, 1=HIGH). */
  level?: 0 | 1;
  /** For 'serial': bytes to send. */
  bytes?: Uint8Array;
  /** For 'adc': ADC channel (0-5). */
  channel?: number;
  /** For 'adc': voltage 0-5V. */
  voltage?: number;
}

export interface HarnessOptions {
  /** Intel HEX content of the compiled firmware. */
  hexContent: string;
  /** Pin assignments from the wiring plan. */
  pinAssignments?: PinAssignment[];
  /** Peripherals to simulate. */
  peripherals?: HarnessPeripheral[];
  /** Scenario steps to drive inputs. */
  scenario?: HarnessScenarioStep[];
  /** How many virtual milliseconds to simulate. */
  simulateMs?: number;
  /** CPU frequency in Hz (default 16MHz). */
  cpuFreqHz?: number;
  /** Stop if PC doesn't change for this many cycles (infinite loop detection). */
  stallThresholdCycles?: number;
}

export interface HarnessResult {
  trace: FirmwareTrace;
  /** Whether the simulation completed normally. */
  completed: boolean;
  /** Reason if simulation did not complete. */
  error?: string;
  /** Total cycles executed. */
  cyclesExecuted: number;
  /** Virtual milliseconds simulated. */
  simulatedMs: number;
}

/**
 * Headless AVR harness for real firmware simulation.
 *
 * This class wraps avr8js to provide:
 * - Loading Intel HEX firmware
 * - Running the CPU with cycle-accurate timing
 * - Recording pin changes, serial output, and servo writes
 * - Driving scripted inputs (pin levels, serial bytes, ADC voltages)
 */
export class HeadlessAVRHarness {
  private cpu: CPU | null = null;
  private ports: Record<PortName, AVRIOPort | null> = { B: null, C: null, D: null };
  private adc: AVRADC | null = null;
  private usart: AVRUSART | null = null;
  private timers: AVRTimer[] = [];
  private ocrValues: number[] = new Array(PWM_PINS.length).fill(-1);
  private pinListeners = new Map<number, Set<(level: 0 | 1) => void>>();
  private portValues: Record<PortName, number> = { B: 0, C: 0, D: 0 };
  /** Bits of each port the scenario has taken ownership of (external drive). */
  private drivenMask: Record<PortName, number> = { B: 0, C: 0, D: 0 };

  // Serial: a partial line being assembled + completed lines with timestamps.
  private serialBuffer = '';
  private serialAll = '';

  // Trace recording
  private pinEvents: TracePinEvent[] = [];
  private servoEvents: TraceServoEvent[] = [];
  private serialLines: TraceSerialLine[] = [];
  private drivenPins = new Set<number>();
  private loopIterations = 0;

  // Scenario state
  private scenarioSteps: HarnessScenarioStep[] = [];
  private nextStepIndex = 0;
  private cpuFreqHz = 16_000_000;

  /**
   * Load Intel HEX firmware into the harness.
   */
  loadHex(hexText: string): void {
    const bytes = parseIntelHex(hexText);
    const program = bytesToProgramWords(bytes, FLASH_WORDS);
    this.bindCpu(program);
  }

  /**
   * Load a pre-assembled Uint16Array of instruction words.
   */
  loadProgram(words: Uint16Array): void {
    const program = new Uint16Array(FLASH_WORDS);
    program.set(words.subarray(0, FLASH_WORDS));
    this.bindCpu(program);
  }

  private bindCpu(program: Uint16Array): void {
    this.cpu = new CPU(program, SRAM_BYTES);

    this.ports.B = new AVRIOPort(this.cpu, portBConfig);
    this.ports.C = new AVRIOPort(this.cpu, portCConfig);
    this.ports.D = new AVRIOPort(this.cpu, portDConfig);
    this.adc = new AVRADC(this.cpu, adcConfig);

    this.usart = new AVRUSART(this.cpu, usart0Config, this.cpuFreqHz);
    this.usart.onByteTransmit = (v: number) => {
      const char = String.fromCharCode(v);
      this.serialAll += char;
      if (char === '\n') {
        this.flushSerialLine();
      } else if (char !== '\r') {
        this.serialBuffer += char;
      }
    };

    this.timers = [
      new AVRTimer(this.cpu, timer0Config),
      new AVRTimer(this.cpu, timer1Config),
      new AVRTimer(this.cpu, timer2Config),
    ];

    // Attach port listeners for trace recording + pull-up emulation. The
    // listener fires whenever the firmware writes PORTx or DDRx.
    for (const name of ['B', 'C', 'D'] as const) {
      const port = this.ports[name];
      if (!port) continue;

      port.addListener((value: number) => {
        const old = this.portValues[name];
        this.portValues[name] = value;
        const changed = old ^ value;
        const ddr = this.cpu?.data[PORT_CONFIGS[name].DDR] ?? 0;

        for (let bit = 0; bit < 8; bit++) {
          const mask = 1 << bit;
          if (!(changed & mask)) continue;

          const arduinoPin = this.portBitToArduinoPin(name, bit);
          if (arduinoPin == null) continue;

          // Only OUTPUT pins are firmware-driven: their level is the PORT bit.
          // (A PORT write on an input bit is pull-up configuration, not a
          // level change — that is handled by refreshPullUps below.)
          if (ddr & mask) {
            const state = ((value >> bit) & 1) as 0 | 1;
            const atMs = this.cyclesToMs(this.cpu?.cycles ?? 0);
            this.drivenPins.add(arduinoPin);
            this.pinEvents.push({ pin: arduinoPin, level: state, atMs });
            const set = this.pinListeners.get(arduinoPin);
            if (set) set.forEach((cb) => cb(state));
          }
        }

        this.refreshPullUps(name);
      });
    }
  }

  /**
   * Emulate internal pull-ups on input pins the scenario does not drive:
   * DDR=0 and PORT bit=1 (INPUT_PULLUP) idles the pin HIGH, exactly like the
   * real chip. Without this, every `digitalRead()` on a pull-up button reads
   * LOW from t=0 and press counters over-count at boot.
   */
  private refreshPullUps(name: PortName): void {
    const cpu = this.cpu;
    const port = this.ports[name];
    if (!cpu || !port) return;
    const cfg = PORT_CONFIGS[name];
    const ddr = cpu.data[cfg.DDR];
    const portValue = cpu.data[cfg.PORT];
    const driven = this.drivenMask[name];

    for (let bit = 0; bit < 8; bit++) {
      const mask = 1 << bit;
      if (ddr & mask) continue; // output — the firmware owns the level
      if (driven & mask) continue; // scenario owns the level
      port.setPin(bit, (portValue & mask) !== 0);
    }
  }

  private portBitToArduinoPin(portName: PortName, bit: number): number | null {
    if (portName === 'B' && bit < 6) return 8 + bit;
    if (portName === 'C' && bit < 6) return 14 + bit;
    if (portName === 'D' && bit < 8) return bit;
    return null;
  }

  private cyclesToMs(cycles: number): number {
    return Math.floor((cycles / this.cpuFreqHz) * 1000);
  }

  /** Close the partial serial line into the trace (idempotent-ish). */
  private flushSerialLine(): void {
    if (this.serialBuffer.length === 0) return;
    this.serialLines.push({ text: this.serialBuffer, atMs: this.cyclesToMs(this.cpu?.cycles ?? 0) });
    this.serialBuffer = '';
  }

  /**
   * Set up scenario steps to drive during simulation.
   */
  setScenario(steps: HarnessScenarioStep[]): void {
    this.scenarioSteps = [...steps].sort((a, b) => a.atMs - b.atMs);
    this.nextStepIndex = 0;
  }

  /**
   * Set CPU frequency (must be called before loadHex/loadProgram).
   */
  setCpuFreqHz(freq: number): void {
    this.cpuFreqHz = freq;
  }

  /**
   * Run the simulation. Async: yields to the event loop every
   * `YIELD_EVERY_CYCLES` cycles so a long virtual-time run cannot freeze the
   * server process it executes in.
   */
  async run(options: {
    simulateMs?: number;
    stallThresholdCycles?: number;
  } = {}): Promise<HarnessResult> {
    if (!this.cpu) {
      return { trace: this.buildTrace(), completed: false, error: 'No firmware loaded', cyclesExecuted: 0, simulatedMs: 0 };
    }

    const simulateMs = options.simulateMs ?? 6000;
    const stallThreshold = options.stallThresholdCycles ?? 10_000_000;
    const targetCycles = Math.floor((simulateMs / 1000) * this.cpuFreqHz);

    let lastPc = -1;
    let stallCounter = 0;
    let lastLoopCheck = 0;
    let nextYieldAt = this.cpu.cycles + YIELD_EVERY_CYCLES;

    try {
      while (this.cpu.cycles < targetCycles) {
        // Check for infinite loop / stall
        if (this.cpu.pc === lastPc) {
          stallCounter++;
          if (stallCounter > stallThreshold) {
            return {
              trace: this.buildTrace(),
              completed: false,
              error: `CPU stalled at PC=0x${this.cpu.pc.toString(16)} (possible infinite loop)`,
              cyclesExecuted: this.cpu.cycles,
              simulatedMs: this.cyclesToMs(this.cpu.cycles),
            };
          }
        } else {
          stallCounter = 0;
          lastPc = this.cpu.pc;
        }

        // Execute one instruction
        avrInstruction(this.cpu);
        this.cpu.tick();

        // Approximate loop() iteration counter: one per virtual millisecond in
        // which the CPU stayed inside the flash region. Not exact (the host
        // shim evaluator counts real iterations); it only has to be non-zero
        // for "the firmware is alive" telemetry.
        if (this.cpu.cycles - lastLoopCheck > this.cpuFreqHz / 1000) {
          lastLoopCheck = this.cpu.cycles;
          if (this.cpu.pc > 0x100 && this.cpu.pc < 0x7000) {
            this.loopIterations++;
          }
        }

        // Process scenario steps
        const currentMs = this.cyclesToMs(this.cpu.cycles);
        while (this.nextStepIndex < this.scenarioSteps.length) {
          const step = this.scenarioSteps[this.nextStepIndex];
          if (step.atMs > currentMs) break;

          this.applyStep(step);
          this.nextStepIndex++;
        }

        // Record PWM values periodically
        if (this.cpu.cycles % 10000 === 0) {
          this.recordPWMValues(currentMs);
        }

        // Cooperative scheduling: let the rest of the server breathe.
        if (this.cpu.cycles >= nextYieldAt) {
          nextYieldAt += YIELD_EVERY_CYCLES;
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }

      return {
        trace: this.buildTrace(),
        completed: true,
        cyclesExecuted: this.cpu.cycles,
        simulatedMs: this.cyclesToMs(this.cpu.cycles),
      };
    } catch (error) {
      return {
        trace: this.buildTrace(),
        completed: false,
        error: error instanceof Error ? error.message : String(error),
        cyclesExecuted: this.cpu?.cycles ?? 0,
        simulatedMs: this.cyclesToMs(this.cpu?.cycles ?? 0),
      };
    }
  }

  private applyStep(step: HarnessScenarioStep): void {
    switch (step.kind) {
      case 'pin':
        if (step.pin !== undefined && step.level !== undefined) {
          this.setPinInput(step.pin, step.level);
        }
        break;
      case 'serial':
        if (step.bytes && this.usart) {
          for (const byte of step.bytes) {
            // writeByte() is the real RX path: it sets the RXC flag (and fires
            // the RX interrupt when enabled). Timed delivery first; if the RX
            // shift register is busy, deliver immediately rather than drop.
            if (this.usart.writeByte(byte) === false) {
              this.usart.writeByte(byte, true);
            }
          }
        }
        break;
      case 'adc':
        if (step.channel !== undefined && step.voltage !== undefined) {
          this.setAnalogVoltage(step.channel, step.voltage);
        }
        break;
    }
  }

  /**
   * Drive an input pin from the outside world (a button press, a sensor line).
   * Uses the avr8js `setPin` API, which feeds the PIN register the firmware's
   * `digitalRead()` reads — the previous implementation called `pinState()`
   * (a getter) and discarded the result, so scenario pin steps were no-ops.
   */
  private setPinInput(pin: number, level: 0 | 1): void {
    const m = PIN_MAP[pin];
    if (!m || !this.cpu) return;
    const port = this.ports[m.portName];
    if (!port) return;

    this.drivenMask[m.portName] |= 1 << m.bit;
    port.setPin(m.bit, level === 1);

    const atMs = this.cyclesToMs(this.cpu.cycles);
    this.pinEvents.push({ pin, level, atMs });
    const set = this.pinListeners.get(pin);
    if (set) set.forEach((cb) => cb(level));
  }

  private recordPWMValues(atMs: number): void {
    if (!this.cpu) return;

    for (let i = 0; i < PWM_PINS.length; i++) {
      const entry = PWM_PINS[i];
      const raw = entry.ocrHigh !== null
        ? this.cpu.data[entry.ocrLow] | (this.cpu.data[entry.ocrHigh] << 8)
        : this.cpu.data[entry.ocrLow];
      if (raw === this.ocrValues[i]) continue;
      this.ocrValues[i] = raw;

      // Only timer1 pins can carry Arduino Servo library pulses; interpret
      // them as 4µs ticks and emit an angle when the pulse looks servo-shaped.
      if (entry.ocrHigh === null) continue;
      const pulseUs = raw * SERVO_US_PER_TICK;
      if (pulseUs < SERVO_PULSE_MIN_US || pulseUs > SERVO_PULSE_MAX_US) continue;
      const angle = Math.max(0, Math.min(180, Math.round(((pulseUs - 1000) / 1000) * 180)));
      this.servoEvents.push({ pin: entry.pin, angle, atMs });
    }
  }

  /**
   * Get the current level of a digital pin (0 or 1) — what an observer on the
   * wire would measure. Reads the PIN register avr8js keeps in sync for both
   * driven outputs and external inputs. (`AVRIOPort.pinState()` returns the
   * pin's CONFIGURATION — Input/InputPullUp/High/Low — not its level, which
   * made the old implementation report every pull-up input as HIGH forever.)
   */
  getPin(pin: number): 0 | 1 {
    const m = PIN_MAP[pin];
    if (!m || !this.cpu) return 0;
    const cfg = PORT_CONFIGS[m.portName];
    return ((this.cpu.data[cfg.PIN] >> m.bit) & 1) as 0 | 1;
  }

  /**
   * Set analog voltage on ADC channel (0-5 for A0-A5).
   */
  setAnalogVoltage(channel: number, volts: number): void {
    if (!this.adc) return;
    this.adc.channelValues[channel] = Math.max(0, Math.min(5, volts));
  }

  /**
   * Estimate PWM duty cycle on a supported pin (0..1).
   */
  getPWMDuty(pin: number): number | null {
    const entry = PWM_PINS.find((p) => p.pin === pin);
    if (!entry || !this.cpu) return null;
    const raw = entry.ocrHigh !== null
      ? this.cpu.data[entry.ocrLow] | (this.cpu.data[entry.ocrHigh] << 8)
      : this.cpu.data[entry.ocrLow];
    // Arduino's analogWrite() is 8-bit on every AVR timer, so /255 holds; a
    // Servo-library pin reports its tick count instead (duty is meaningless
    // there — read servoEvents).
    return Math.min(1, raw / 255);
  }

  /**
   * Get all serial output observed so far (completed lines + partial buffer).
   */
  getSerialOutput(): string {
    return this.serialAll;
  }

  /**
   * Register a callback for pin level changes.
   */
  onPinChange(pin: number, cb: (level: 0 | 1) => void): () => void {
    if (!this.pinListeners.has(pin)) {
      this.pinListeners.set(pin, new Set());
    }
    this.pinListeners.get(pin)!.add(cb);
    return () => {
      this.pinListeners.get(pin)?.delete(cb);
    };
  }

  private buildTrace(): FirmwareTrace {
    // Preserve a trailing partial line on EVERY exit path — the old code only
    // flushed on normal completion, so a stalled sketch lost its whole serial
    // trace and every telemetry assertion reported "no frame observed".
    this.flushSerialLine();
    return {
      drivenPins: Array.from(this.drivenPins).sort((a, b) => a - b),
      pinEvents: this.pinEvents,
      servoEvents: this.servoEvents,
      serialLines: this.serialLines,
      simulatedMs: this.cyclesToMs(this.cpu?.cycles ?? 0),
      loopIterations: this.loopIterations,
    };
  }
}

/**
 * Convenience function to run a complete simulation.
 */
export async function runSimulation(options: HarnessOptions): Promise<HarnessResult> {
  const harness = new HeadlessAVRHarness();

  if (options.cpuFreqHz) {
    harness.setCpuFreqHz(options.cpuFreqHz);
  }

  harness.loadHex(options.hexContent);

  if (options.scenario) {
    harness.setScenario(options.scenario);
  }

  return harness.run({
    simulateMs: options.simulateMs,
    stallThresholdCycles: options.stallThresholdCycles,
  });
}
