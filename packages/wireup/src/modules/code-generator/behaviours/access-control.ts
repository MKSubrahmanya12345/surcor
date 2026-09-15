/**
 * Access-control behaviour (PIN keypad + electric lock).
 *
 * The generic fallback sketch in `../templates.ts` is a movement/telemetry
 * skeleton: it counts button presses and reports a speed. For a build whose
 * whole point is *authorising* something — a safe, a door strike, a lock box —
 * that skeleton compiles and does nothing the user asked for. This module
 * recognises the pattern from the structured project (a key input + a lock
 * actuator) and emits a complete, non-blocking implementation instead:
 *
 *   • matrix keypad scan (or a discrete-button pad when the build has no
 *     matrix part), with `#` = submit and `*` = clear,
 *   • a PIN held in EEPROM/flash-emulated EEPROM so it survives a reset,
 *   • a smoothly swept servo (or a relay) between locked and unlocked,
 *   • green/red status LEDs, confirmation and error tones,
 *   • a failed-attempt counter that raises a timed alarm and locks the pad,
 *   • a door switch that re-locks automatically when the door closes,
 *   • hold-`*` password-change mode, current PIN required first,
 *   • an OLED/LCD UI, or the serial link when the build has no display.
 *
 * Everything is derived from the pin plan: the sketch references the same
 * `PIN_*` constants the wiring table and `diagram.json` use, so a pin fix
 * re-syncs the firmware instead of breaking it.
 */

import type { ComponentDefinition, ComponentSelection } from '@/types/component';
import type { PinAssignment } from '@/types/wiring';

import type { SketchContext } from '../templates';
import {
  buildIncludesBlock,
  buildPinMapBlock,
  constantName,
  i2cBusInitLines,
  normaliseI2cAddress,
  safeIdentifier,
  uniqueCodeAssignments,
} from '../managed-blocks';

/* ------------------------------------------------------------------------- */
/* Detection                                                                  */
/* ------------------------------------------------------------------------- */

export interface KeypadMatrix {
  rowConstants: string[];
  columnConstants: string[];
  keyMap: string[][];
  instanceId: string;
}

export interface DiscreteKey {
  constant: string;
  label: string;
  instanceId: string;
}

export interface AccessControlPlan {
  /** Matrix part, when the build has one. */
  matrix?: KeypadMatrix;
  /** Individual buttons used as keys (a pad built from discrete switches). */
  keys: DiscreteKey[];
  /** The lock actuator. */
  lock: { kind: 'servo' | 'relay'; identifier: string; constant: string; activeLow: boolean };
  lockedAngle: number;
  unlockedAngle: number;
  /** Door/limit switch that reports the door state, when present. */
  door?: DiscreteKey;
  redLed?: string;
  greenLed?: string;
  statusLed?: string;
  /**
   * Any further indicator LEDs in the bill of materials. They mirror the
   * red/alarm line rather than being left alone: a pin the planner assigned and
   * the wiring graph connects must do something in the firmware.
   */
  extraLeds: string[];
  buzzer?: { constant: string; passive: boolean };
  display?: { kind: 'oled' | 'lcd'; address: string };
  eeprom: boolean;
  minPinLength: number;
  maxPinLength: number;
  defaultPin: string;
  alarmMs: number;
  maxAttempts: number;
  words: {
    device: string;
    locked: string;
    enterPin: string;
    granted: string;
    denied: string;
    alarm: string;
    open: string;
    doorOpen: string;
    doorClosed: string;
    changePin: string;
  };
  notes: string[];
}

const DEFAULT_KEY_SEQUENCE = ['1', '2', '3', 'A', '4', '5', '6', 'B', '7', '8', '9', 'C', '*', '0', '#', 'D'];

function hasLibrary(ctx: SketchContext, header: string): boolean {
  return ctx.softwarePlan.libraries.some((library) => library.import.toLowerCase() === header.toLowerCase());
}

function definitionFor(ctx: SketchContext, componentId: string): ComponentDefinition | undefined {
  return ctx.catalog.find((component) => component.id === componentId);
}

function selectionOfInstance(ctx: SketchContext, instanceId: string): ComponentSelection | undefined {
  return ctx.selections.find((selection) => selection.instances.some((instance) => instance.instanceId === instanceId));
}

function labelOf(ctx: SketchContext, assignment: PinAssignment): string {
  const selection = selectionOfInstance(ctx, assignment.targetInstanceId);
  const instance = selection?.instances.find((entry) => entry.instanceId === assignment.targetInstanceId);
  return instance?.label ?? instance?.name ?? selection?.name ?? assignment.targetInstanceId;
}

/** `Keypad R2C3` → the key that sits at row 2, column 3 of a 4×4 pad. */
function keyFromLabel(label: string, fallback: string | undefined): string | undefined {
  const matrix = /r\s*([0-4])\s*c\s*([0-4])/i.exec(label);
  if (matrix) {
    const row = Number.parseInt(matrix[1] as string, 10);
    const col = Number.parseInt(matrix[2] as string, 10);
    if (row >= 1 && row <= 4 && col >= 1 && col <= 4) {
      return DEFAULT_KEY_SEQUENCE[(row - 1) * 4 + (col - 1)] as string;
    }
  }
  const named = /(?:key|button|switch)?\s*([0-9]|[*#]|star|hash|enter|clear)\b/i.exec(label);
  if (named) {
    const token = (named[1] ?? '').toLowerCase();
    if (token === 'star') return '*';
    if (token === 'hash') return '#';
    if (token === 'enter') return '#';
    if (token === 'clear') return '*';
    if (token.length > 0) return token.toUpperCase();
  }
  return fallback;
}

function isButtonLike(ctx: SketchContext, assignment: PinAssignment): boolean {
  const selection = selectionOfInstance(ctx, assignment.targetInstanceId);
  if (!selection) return false;
  if (selection.category !== 'input_device') return false;
  const definition = definitionFor(ctx, selection.componentId);
  if (definition?.metadata.keypadMatrix !== undefined) return false;
  return /button|switch|key/i.test(`${selection.componentId} ${selection.name}`);
}

/**
 * PIN length the brief asks for ("4-6 digit PIN" → 4..6); defaults to 4..6.
 * Exported so the behavioural assertion layer derives the exact same numbers.
 */
export function pinLengthFromText(rawText: string): { min: number; max: number } {
  const text = rawText.toLowerCase();

  const range = /(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*digits?/.exec(text);
  if (range) {
    const min = Number.parseInt(range[1] as string, 10);
    const max = Number.parseInt(range[2] as string, 10);
    if (min > 0 && max >= min) return { min: Math.min(min, 12), max: Math.min(max, 12) };
  }
  const fixed = /(\d{1,2})\s*digits?\s*(?:pin|code|password|passcode)/.exec(text);
  if (fixed) {
    const value = Number.parseInt(fixed[1] as string, 10);
    if (value > 0) return { min: Math.min(value, 12), max: Math.min(value, 12) };
  }
  return { min: 4, max: 6 };
}

function pinLengthFrom(ctx: SketchContext): { min: number; max: number } {
  return pinLengthFromText(
    [
      ctx.projectName,
      ctx.projectSummary,
      ctx.requirements.goal,
      ...ctx.requirements.behaviors,
      ...ctx.requirements.requirements,
      ...ctx.requirements.constraints,
      ...ctx.requirements.assumptions,
    ].join(' '),
  );
}

function servoAngle(ctx: SketchContext, which: 'locked' | 'unlocked', fallback: number): number {
  const text = [ctx.requirements.goal, ...ctx.requirements.behaviors, ...ctx.requirements.assumptions, ...ctx.requirements.constraints]
    .join(' ')
    .toLowerCase();
  const pattern = which === 'locked' ? /lock(?:ed)?\s*(?:position|angle)?\s*(?:=|:|at)?\s*(\d{1,3})\s*(?:°|deg)/ : /unlock(?:ed)?\s*(?:position|angle)?\s*(?:=|:|at)?\s*(\d{1,3})\s*(?:°|deg)/;
  const match = pattern.exec(text);
  if (!match) return fallback;
  const value = Number.parseInt(match[1] as string, 10);
  return Number.isFinite(value) && value >= 0 && value <= 180 ? value : fallback;
}

function deviceWord(ctx: SketchContext): string {
  const text = `${ctx.projectName} ${ctx.requirements.goal}`.toLowerCase();
  if (/safe|vault|strong\s*box|locker/.test(text)) return 'SAFE';
  if (/door|strike|entry/.test(text)) return 'DOOR';
  if (/lock/.test(text)) return 'LOCK';
  return 'LOCK';
}

/**
 * Does this build authorise access? It needs (a) a way to enter keys and (b)
 * something to lock. Everything else (display, LEDs, buzzer, door switch) is
 * optional and only enriches the behaviour.
 */
export function detectAccessControl(ctx: SketchContext): AccessControlPlan | null {
  const { assignments } = uniqueCodeAssignments(ctx.assignments);
  const notes: string[] = [];

  /* --- lock actuator ------------------------------------------------------ */
  const servoSelection = ctx.selections.find((selection) => selection.category === 'motor' && /servo/i.test(selection.componentId));
  const servoInstance = servoSelection?.instances[0];
  const servoAssignment = servoInstance ? assignments.find((entry) => entry.targetInstanceId === servoInstance.instanceId) : undefined;
  const servoUsable = Boolean(servoAssignment) && (hasLibrary(ctx, 'Servo.h') || Boolean(servoSelection));

  const relaySelection = ctx.selections.find((selection) => /relay/i.test(selection.componentId));
  const relayInstance = relaySelection?.instances[0];
  const relayAssignment = relayInstance ? assignments.find((entry) => entry.targetInstanceId === relayInstance.instanceId) : undefined;

  if (!servoUsable && !relayAssignment) return null;

  /* --- key input ---------------------------------------------------------- */
  const keypadSelection = ctx.selections.find((selection) => {
    const definition = definitionFor(ctx, selection.componentId);
    return definition?.metadata.keypadMatrix !== undefined;
  });

  let matrix: KeypadMatrix | undefined;
  const discrete: DiscreteKey[] = [];

  if (keypadSelection) {
    const definition = definitionFor(ctx, keypadSelection.componentId);
    const raw = definition?.metadata.keypadMatrix as { rows?: unknown; columns?: unknown; keyMap?: unknown } | undefined;
    const rows = Array.isArray(raw?.rows) ? (raw?.rows as unknown[]).map(String) : ['R1', 'R2', 'R3', 'R4'];
    const columns = Array.isArray(raw?.columns) ? (raw?.columns as unknown[]).map(String) : ['C1', 'C2', 'C3', 'C4'];
    const keyMap = Array.isArray(raw?.keyMap)
      ? (raw?.keyMap as unknown[][]).map((row) => (Array.isArray(row) ? row.map(String) : []))
      : [];

    const instance = keypadSelection.instances[0];
    if (instance) {
      const rowConstants: string[] = [];
      const columnConstants: string[] = [];
      for (const row of rows) {
        const assignment = assignments.find((entry) => entry.targetInstanceId === instance.instanceId && entry.targetPin.toUpperCase() === row.toUpperCase());
        if (assignment) rowConstants.push(constantName(assignment));
      }
      for (const column of columns) {
        const assignment = assignments.find((entry) => entry.targetInstanceId === instance.instanceId && entry.targetPin.toUpperCase() === column.toUpperCase());
        if (assignment) columnConstants.push(constantName(assignment));
      }
      if (rowConstants.length > 0 && columnConstants.length > 0) {
        const map: string[][] = [];
        for (let row = 0; row < rowConstants.length; row += 1) {
          const line: string[] = [];
          for (let column = 0; column < columnConstants.length; column += 1) {
            line.push(keyMap[row]?.[column] ?? DEFAULT_KEY_SEQUENCE[row * columnConstants.length + column] ?? String(row * 4 + column));
          }
          map.push(line);
        }
        matrix = { rowConstants, columnConstants, keyMap: map, instanceId: instance.instanceId };
      } else {
        notes.push(
          `The keypad ${instance.instanceId} is in the bill of materials but its row/column pins were not all assigned, so the firmware falls back to the discrete buttons that are wired.`,
        );
      }
    }
  }

  for (const assignment of assignments) {
    if (!isButtonLike(ctx, assignment)) continue;
    const label = labelOf(ctx, assignment);
    discrete.push({ constant: constantName(assignment), label, instanceId: assignment.targetInstanceId });
  }

  if (!matrix && discrete.length === 0) return null;

  /* --- door switch -------------------------------------------------------- */
  let door: DiscreteKey | undefined;
  if (matrix) {
    // With a real keypad every discrete button is a door/limit switch; prefer
    // one whose label says so.
    door =
      discrete.find((entry) => /door|open|close|limit|latch/i.test(entry.label)) ??
      discrete.find((entry) => !/key|pad|r\d c\d/i.test(entry.label)) ??
      discrete[0];
  }
  const doorConstant = door?.constant;

  /* --- keys --------------------------------------------------------------- */
  let keys = discrete.filter((entry) => entry.constant !== doorConstant);
  if (!matrix) {
    // No matrix part: the discrete buttons ARE the pad. Label them from their
    // instance labels when those say something useful, else from the standard
    // 4×4 layout so `*` and `#` still exist.
    keys = keys.map((entry, index) => ({
      ...entry,
      label: keyFromLabel(entry.label, DEFAULT_KEY_SEQUENCE[index] ?? String(index)) as string,
    }));
    // A pad with no clear/submit key cannot be used: map the last two.
    const labels = new Set(keys.map((entry) => entry.label));
    if (!labels.has('*') && keys.length > 0) keys[keys.length - 1] = { ...(keys[keys.length - 1] as DiscreteKey), label: '*' };
    if (!labels.has('#') && keys.length > 1) keys[keys.length - 2] = { ...(keys[keys.length - 2] as DiscreteKey), label: '#' };
  }
  /*
   * Without a matrix part the buttons ARE the keypad, and a keypad needs
   * enough keys to enter a code. A servo plus one button is a sweep, not a
   * lock, so hand the build back to the generic skeleton instead of forcing a
   * PIN state machine onto it.
   */
  if (!matrix && keys.length < 3) return null;

  /* --- indicators --------------------------------------------------------- */
  const ledAssignments = assignments.filter((entry) => {
    const selection = selectionOfInstance(ctx, entry.targetInstanceId);
    return selection?.category === 'actuator' && /led/i.test(selection.componentId) && !/rgb/i.test(selection.componentId);
  });
  const findLed = (pattern: RegExp) => ledAssignments.find((entry) => pattern.test(labelOf(ctx, entry)));
  const redLed = findLed(/red|error|alarm|deny|fail/i);
  const greenLed = findLed(/green|ok|success|grant|access|go/i);
  const remaining = ledAssignments.filter((entry) => entry !== redLed && entry !== greenLed);

  const buzzerAssignment = assignments.find((entry) => /buzzer|piezo/i.test(entry.targetInstanceId));
  const buzzerPassive = buzzerAssignment
    ? definitionFor(ctx, selectionOfInstance(ctx, buzzerAssignment.targetInstanceId)?.componentId ?? '')?.metadata.active !== true
    : false;

  /* --- display ------------------------------------------------------------ */
  const oledActive = hasLibrary(ctx, 'Adafruit_SSD1306.h') && ctx.selections.some((selection) => /ssd1306/i.test(selection.componentId));
  const lcdActive = hasLibrary(ctx, 'LiquidCrystal_I2C.h') && ctx.selections.some((selection) => /lcd-?1602|lcd-?2004/i.test(selection.componentId));
  const displayDefinition = ctx.selections.find((selection) => /ssd1306|lcd/i.test(selection.componentId));
  const address = normaliseI2cAddress(definitionFor(ctx, displayDefinition?.componentId ?? '')?.metadata.i2cAddress, oledActive ? '0x3C' : '0x27');

  const eeprom = hasLibrary(ctx, 'EEPROM.h');
  if (!eeprom) notes.push('EEPROM.h is not in the library manifest, so the PIN is compiled in and a reset restores the default.');

  const lengths = pinLengthFrom(ctx);
  const device = deviceWord(ctx);
  /*
   * The factory default PIN must be at least PIN_MIN_LENGTH digits long,
   * otherwise a brief that asks for a 5+ digit PIN ships a device whose
   * default PIN can never be accepted: "1234" is rejected as too short, and
   * a longer entry never matches the stored 4 digits. Derive it from the
   * requested length instead of a fixed 4-digit literal.
   */
  const minDefault = Math.max(lengths.min, 4);
  const defaultPin = '1234567890'.repeat(Math.ceil(minDefault / 10)).slice(0, minDefault);

  return {
    ...(matrix ? { matrix } : {}),
    keys,
    lock: servoUsable && servoAssignment
      ? { kind: 'servo', identifier: 'lockServo', constant: constantName(servoAssignment), activeLow: false }
      : {
          kind: 'relay',
          identifier: 'lockRelay',
          constant: constantName(relayAssignment as PinAssignment),
          // Most relay modules are active-low: HIGH keeps the contacts open.
          activeLow: true,
        },
    lockedAngle: servoAngle(ctx, 'locked', 0),
    unlockedAngle: servoAngle(ctx, 'unlocked', 90),
    ...(door ? { door } : {}),
    ...(redLed ? { redLed: constantName(redLed) } : {}),
    ...(greenLed ? { greenLed: constantName(greenLed) } : {}),
    ...(redLed || greenLed ? {} : remaining[0] ? { statusLed: constantName(remaining[0]) } : {}),
    extraLeds: remaining.slice(redLed || greenLed ? 0 : 1).map((entry) => constantName(entry)),
    ...(buzzerAssignment ? { buzzer: { constant: constantName(buzzerAssignment), passive: buzzerPassive } } : {}),
    ...(oledActive
      ? { display: { kind: 'oled' as const, address } }
      : lcdActive
        ? { display: { kind: 'lcd' as const, address } }
        : {}),
    eeprom,
    minPinLength: lengths.min,
    maxPinLength: Math.max(lengths.max, lengths.min),
    defaultPin,
    alarmMs: 10_000,
    maxAttempts: 3,
    words: {
      device,
      locked: `${device} LOCKED`,
      enterPin: 'ENTER PIN:',
      granted: 'ACCESS GRANTED',
      denied: 'ACCESS DENIED',
      alarm: 'ALARM',
      open: 'OPEN',
      doorOpen: 'DOOR OPEN',
      doorClosed: 'DOOR CLOSED',
      changePin: 'NEW PIN:',
    },
    notes,
  };
}

/* ------------------------------------------------------------------------- */
/* Sketch                                                                     */
/* ------------------------------------------------------------------------- */

function cString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function identifier(instanceId: string): string {
  return safeIdentifier(instanceId).toLowerCase();
}

/** The firmware header comment, so both builders report themselves the same way. */
function header(ctx: SketchContext, plan: AccessControlPlan): string[] {
  const lines: string[] = [];
  lines.push('/*');
  lines.push(` * ${ctx.projectName}`);
  lines.push(' *');
  if (ctx.projectSummary) lines.push(` * ${ctx.projectSummary}`);
  lines.push(` * Controller : ${ctx.controllerName}`);
  lines.push(` * Revision   : ${ctx.revision}`);
  lines.push(' * Generated  : Wireup hardware agent (access-control behaviour)');
  lines.push(' *');
  lines.push(' * Behaviour:');
  lines.push(` *   - ${plan.words.locked} / ${plan.words.enterPin} on start-up, PIN kept in ${plan.eeprom ? 'EEPROM' : 'firmware'}`);
  lines.push(' *   - keys are read from ' + (plan.matrix ? 'a row/column matrix scan' : `${plan.keys.length} discrete switch input(s)`));
  lines.push(' *   - "#" submits the PIN, "*" clears it, holding "*" starts password change');
  lines.push(` *   - a correct PIN drives the ${plan.lock.kind} to the unlocked position and shows ${plan.words.granted}`);
  lines.push(` *   - ${plan.maxAttempts} wrong attempts raise a ${Math.round(plan.alarmMs / 1000)} s alarm and ignore the keypad until it ends`);
  if (plan.door) lines.push(` *   - ${plan.door.label} toggles the door; closing it re-locks automatically`);
  lines.push(' *');
  lines.push(' * Nothing in loop() blocks: the servo is swept in small steps, tones are');
  lines.push(' * scheduled, and the display is redrawn only when something changed.');
  if (plan.notes.length > 0) {
    lines.push(' *');
    lines.push(' * Notes:');
    for (const note of plan.notes) lines.push(` *   - ${note}`);
  }
  lines.push(' */');
  return lines;
}

export function buildAccessControlSketch(ctx: SketchContext, plan: AccessControlPlan): string {
  const platformIsEsp32 = /esp32/i.test(ctx.controllerName) || /esp32/i.test(ctx.profile?.componentId ?? '');
  const lines: string[] = [];
  const link = ctx.serialLinks[0];
  const linkName = link && link.kind === 'hardware' ? link.id : 'Serial';
  const baud = link?.baud ?? 115200;
  /** Every indicator the firmware drives, so none is left declared but unused. */
  const allLeds = [plan.redLed, plan.greenLed, plan.statusLed, ...plan.extraLeds].filter(
    (constant): constant is string => typeof constant === 'string',
  );

  lines.push(...header(ctx, plan));
  lines.push('');
  lines.push(buildIncludesBlock(ctx.softwarePlan.libraries, platformIsEsp32));
  lines.push('');
  lines.push(buildPinMapBlock(ctx.assignments, ctx.profile));
  lines.push('');

  /* Control link ------------------------------------------------------------- */
  lines.push(`#define controlLink ${linkName}`);
  lines.push(`const uint32_t LINK_BAUD = ${baud}UL;`);
  lines.push('');

  /* Tunables ----------------------------------------------------------------- */
  lines.push('/* --- tunables: edit these, everything below follows --- */');
  lines.push(`const uint8_t PIN_MIN_LENGTH = ${plan.minPinLength};`);
  lines.push(`const uint8_t PIN_MAX_LENGTH = ${plan.maxPinLength};`);
  lines.push(`const uint8_t MAX_FAILED_ATTEMPTS = ${plan.maxAttempts};`);
  lines.push(`const uint32_t ALARM_LOCKOUT_MS = ${plan.alarmMs}UL;`);
  lines.push('const uint32_t HOLD_TO_CHANGE_MS = 2000UL;  // hold "*" this long to enter password change');
  lines.push('const uint32_t GRANTED_DISPLAY_MS = 1500UL;');
  lines.push('const uint32_t DENIED_DISPLAY_MS = 1500UL;');
  lines.push(`const int LOCKED_ANGLE = ${plan.lockedAngle};`);
  lines.push(`const int UNLOCKED_ANGLE = ${plan.unlockedAngle};`);
  if (plan.lock.kind === 'servo') {
    lines.push('const int SERVO_STEP_DEGREES = 2;      // smaller = smoother sweep');
    lines.push('const uint32_t SERVO_STEP_INTERVAL_MS = 12UL;');
  } else {
    lines.push('// A relay has no travel: the two angles are logical markers for the same API.');
    lines.push(`const bool LOCK_ACTIVE_LOW = ${plan.lock.activeLow ? 'true' : 'false'};  // relay module: HIGH usually means contacts open`);
  }
  lines.push('');

  /* State -------------------------------------------------------------------- */
  lines.push('enum LockState {');
  lines.push('  STATE_IDLE,        // waiting for a PIN');
  lines.push('  STATE_GRANTED,     // correct PIN, showing ACCESS GRANTED');
  lines.push('  STATE_OPEN,        // unlocked, door may be open');
  lines.push('  STATE_DENIED,      // wrong PIN, showing ACCESS DENIED');
  lines.push('  STATE_ALARM,       // too many failures, keypad ignored');
  lines.push('  STATE_CHANGE_OLD,  // password change: asking for the current PIN');
  lines.push('  STATE_CHANGE_NEW,  // password change: asking for the new PIN');
  lines.push('  STATE_CHANGE_SAVE  // password change: asking to repeat the new PIN');
  lines.push('};');
  lines.push('');
  lines.push('LockState state = STATE_IDLE;');
  lines.push('char entered[PIN_MAX_LENGTH + 1];');
  lines.push('uint8_t enteredLength = 0;');
  lines.push('char storedPin[PIN_MAX_LENGTH + 1];');
  lines.push('uint8_t storedPinLength = 0;');
  lines.push('char newPin[PIN_MAX_LENGTH + 1];');
  lines.push('uint8_t newPinLength = 0;');
  lines.push('uint8_t failedAttempts = 0;');
  lines.push('bool doorOpen = false;');
  lines.push('bool displayDirty = true;');
  lines.push('uint32_t stateEnteredAt = 0;');
  lines.push('uint32_t alarmUntil = 0;');
  lines.push('uint32_t lastTelemetryAt = 0;');
  lines.push('uint32_t lastLedAt = 0;');
  lines.push('bool ledOn = false;');
  lines.push('uint32_t toneUntil = 0;');
  lines.push('uint32_t starHeldSince = 0;');
  lines.push('uint32_t lastCountdownSecond = 0;');
  lines.push('bool starHeld = false;');
  lines.push('const uint32_t TELEMETRY_INTERVAL_MS = 1000UL;');
  lines.push('');

  if (plan.lock.kind === 'servo') {
    lines.push(`Servo ${plan.lock.identifier};`);
    lines.push('int servoAngle = LOCKED_ANGLE;');
    lines.push('int servoTarget = LOCKED_ANGLE;');
    lines.push('uint32_t lastServoStepAt = 0;');
  }
  if (plan.display?.kind === 'oled') {
    lines.push(`#define DISPLAY_ADDRESS ${plan.display.address}`);
    lines.push('Adafruit_SSD1306 oled(128, 64, &Wire, -1);');
    lines.push('bool displayReady = false;');
  } else if (plan.display?.kind === 'lcd') {
    lines.push(`#define DISPLAY_ADDRESS ${plan.display.address}`);
    lines.push('LiquidCrystal_I2C lcd(DISPLAY_ADDRESS, 16, 2);');
    lines.push('bool displayReady = true;');
  }
  lines.push('');
  /*
   * Prototypes first: the key scanner keeps the lock moving while it waits for
   * a release, so it calls stepLock() long before that function is defined. The
   * Arduino IDE inserts prototypes for you; PlatformIO, ESP-IDF and a plain
   * compiler do not, and neither should the reader have to guess.
   */
  lines.push('/* Forward declarations (used before they are defined below). */');
  lines.push('void stepLock();');
  lines.push('void setLockTarget(int angle);');
  lines.push('bool lockIsUnlocked();');
  lines.push('');

  /* Key input ---------------------------------------------------------------- */
  if (plan.matrix) {
    const rows = plan.matrix.rowConstants;
    const columns = plan.matrix.columnConstants;
    lines.push('/* Matrix keypad: drive one row low at a time and read the columns. */');
    lines.push(`const uint8_t KEYPAD_ROWS[${rows.length}] = { ${rows.join(', ')} };`);
    lines.push(`const uint8_t KEYPAD_COLUMNS[${columns.length}] = { ${columns.join(', ')} };`);
    lines.push(`const uint8_t KEYPAD_ROW_COUNT = ${rows.length};`);
    lines.push(`const uint8_t KEYPAD_COLUMN_COUNT = ${columns.length};`);
    lines.push('const char KEYPAD_KEYS[KEYPAD_ROW_COUNT][KEYPAD_COLUMN_COUNT] = {');
    plan.matrix.keyMap.forEach((row, index) => {
      const cells = row.map((key) => (key.length === 1 ? `'${key === "'" ? "\\'" : key}'` : `'?'`)).join(', ');
      lines.push(`  { ${cells} }${index < plan.matrix!.keyMap.length - 1 ? ',' : ''}`);
    });
    lines.push('};');
    lines.push('');
    lines.push('/* Returns the pressed key, or 0 when nothing is pressed. */');
    lines.push('char readKey() {');
    lines.push('  for (uint8_t row = 0; row < KEYPAD_ROW_COUNT; row++) {');
    lines.push('    digitalWrite(KEYPAD_ROWS[row], LOW);');
    lines.push('    for (uint8_t column = 0; column < KEYPAD_COLUMN_COUNT; column++) {');
    lines.push('      if (digitalRead(KEYPAD_COLUMNS[column]) != LOW) continue;');
    lines.push('      char key = KEYPAD_KEYS[row][column];');
    lines.push('      // Wait for release so one press yields exactly one key, and keep the');
    lines.push('      // lock moving while the key is held.');
    lines.push('      uint32_t heldSince = millis();');
    lines.push('      while (digitalRead(KEYPAD_COLUMNS[column]) == LOW) {');
    lines.push('        stepLock();');
    lines.push('        delay(5);');
    lines.push('        if (millis() - heldSince > 3000UL) break;');
    lines.push('      }');
    lines.push('      delay(10);');
    lines.push('      digitalWrite(KEYPAD_ROWS[row], HIGH);');
    lines.push('      return key;');
    lines.push('    }');
    lines.push('    digitalWrite(KEYPAD_ROWS[row], HIGH);');
    lines.push('  }');
    lines.push('  return 0;');
    lines.push('}');
    lines.push('');
    lines.push('/* True while "*" is being held (password change), without blocking. */');
    lines.push('bool starIsHeld() {');
    lines.push('  for (uint8_t row = 0; row < KEYPAD_ROW_COUNT; row++) {');
    lines.push('    digitalWrite(KEYPAD_ROWS[row], LOW);');
    lines.push('    for (uint8_t column = 0; column < KEYPAD_COLUMN_COUNT; column++) {');
    lines.push("      if (KEYPAD_KEYS[row][column] == '*' && digitalRead(KEYPAD_COLUMNS[column]) == LOW) {");
    lines.push('        digitalWrite(KEYPAD_ROWS[row], HIGH);');
    lines.push('        return true;');
    lines.push('      }');
    lines.push('    }');
    lines.push('    digitalWrite(KEYPAD_ROWS[row], HIGH);');
    lines.push('  }');
    lines.push('  return false;');
    lines.push('}');
  } else {
    lines.push('/* Discrete switches used as a keypad: one GPIO per key, internal pull-ups. */');
    lines.push(`const uint8_t KEY_PINS[${plan.keys.length}] = { ${plan.keys.map((key) => key.constant).join(', ')} };`);
    lines.push(`const char KEY_LABELS[${plan.keys.length}] = { ${plan.keys.map((key) => `'${key.label === "'" ? "\\'" : key.label}'`).join(', ')} };`);
    lines.push(`const uint8_t KEY_COUNT = ${plan.keys.length};`);
    lines.push('');
    lines.push('char readKey() {');
    lines.push('  for (uint8_t index = 0; index < KEY_COUNT; index++) {');
    lines.push('    if (digitalRead(KEY_PINS[index]) != LOW) continue;');
    lines.push('    char key = KEY_LABELS[index];');
    lines.push('    uint32_t heldSince = millis();');
    lines.push('    while (digitalRead(KEY_PINS[index]) == LOW) {');
    lines.push('      stepLock();');
    lines.push('      delay(5);');
    lines.push('      if (millis() - heldSince > 3000UL) break;');
    lines.push('    }');
    lines.push('    delay(10);');
    lines.push('    return key;');
    lines.push('  }');
    lines.push('  return 0;');
    lines.push('}');
    lines.push('');
    lines.push('bool starIsHeld() {');
    lines.push('  for (uint8_t index = 0; index < KEY_COUNT; index++) {');
    lines.push("    if (KEY_LABELS[index] == '*' && digitalRead(KEY_PINS[index]) == LOW) return true;");
    lines.push('  }');
    lines.push('  return false;');
    lines.push('}');
  }
  lines.push('');

  /* Door switch -------------------------------------------------------------- */
  if (plan.door) {
    lines.push(`/* ${plan.door.label} (${plan.door.instanceId}) — debounced; each press toggles the door. */`);
    lines.push('bool doorSwitchClosed = false;   // last debounced level: true = switch closed');
    lines.push('uint32_t doorSwitchChangedAt = 0;');
    lines.push('');
    lines.push('/* Returns true once per press. Wired to GND with the internal pull-up, so a');
    lines.push('   closed switch reads LOW. */');
    lines.push('bool doorSwitchPressed() {');
    lines.push(`  bool raw = digitalRead(${plan.door.constant}) == LOW;`);
    lines.push('  if (raw == doorSwitchClosed) return false;');
    lines.push('  uint32_t now = millis();');
    lines.push('  if (now - doorSwitchChangedAt < 30UL) return false;');
    lines.push('  doorSwitchChangedAt = now;');
    lines.push('  doorSwitchClosed = raw;');
    lines.push('  return raw;');
    lines.push('}');
    lines.push('');
  }

  /* Lock actuator ------------------------------------------------------------ */
  if (plan.lock.kind === 'servo') {
    lines.push('void setLockTarget(int angle) { servoTarget = constrain(angle, 0, 180); }');
    lines.push('');
    lines.push('/* Sweep the servo a few degrees at a time instead of jumping: a lock bolt');
    lines.push('   slammed from 0 to 90 degrees draws a stall current and jars the mechanism. */');
    lines.push('void stepLock() {');
    lines.push('  if (servoAngle == servoTarget) return;');
    lines.push('  uint32_t now = millis();');
    lines.push('  if (now - lastServoStepAt < SERVO_STEP_INTERVAL_MS) return;');
    lines.push('  lastServoStepAt = now;');
    lines.push('  if (servoAngle < servoTarget) servoAngle = min(servoAngle + SERVO_STEP_DEGREES, servoTarget);');
    lines.push('  else servoAngle = max(servoAngle - SERVO_STEP_DEGREES, servoTarget);');
    lines.push(`  ${plan.lock.identifier}.write(servoAngle);`);
    lines.push('}');
    lines.push('');
    lines.push('bool lockIsUnlocked() { return servoTarget == UNLOCKED_ANGLE; }');
  } else {
    lines.push('void stepLock() { /* a relay has no travel to sweep */ }');
    lines.push('');
    lines.push('void setLockTarget(int angle) {');
    lines.push('  bool unlock = angle == UNLOCKED_ANGLE;');
    lines.push(`  digitalWrite(${plan.lock.constant}, LOCK_ACTIVE_LOW ? (unlock ? LOW : HIGH) : (unlock ? HIGH : LOW));`);
    lines.push('}');
    lines.push('');
    lines.push('bool lockIsUnlocked() {');
    lines.push(`  bool level = digitalRead(${plan.lock.constant}) == HIGH;`);
    lines.push('  return LOCK_ACTIVE_LOW ? !level : level;');
    lines.push('}');
  }
  lines.push('');

  /* Indicators --------------------------------------------------------------- */
  lines.push('void setTone(uint16_t frequency, uint16_t durationMs) {');
  if (plan.buzzer) {
    if (plan.buzzer.passive) {
      lines.push(`  tone(${plan.buzzer.constant}, frequency);`);
    } else {
      lines.push(`  digitalWrite(${plan.buzzer.constant}, HIGH);`);
      lines.push('  (void)frequency; // an active buzzer oscillates on its own');
    }
    lines.push('  toneUntil = millis() + durationMs;');
  } else {
    lines.push('  (void)frequency;');
    lines.push('  (void)durationMs; // this build has no sound output');
  }
  lines.push('}');
  lines.push('');
  lines.push('void silenceTone() {');
  if (plan.buzzer) {
    if (plan.buzzer.passive) lines.push(`  noTone(${plan.buzzer.constant});`);
    else lines.push(`  digitalWrite(${plan.buzzer.constant}, LOW);`);
  }
  lines.push('  toneUntil = 0;');
  lines.push('}');
  lines.push('');
  lines.push('void updateTone() {');
  lines.push('  if (toneUntil != 0 && millis() >= toneUntil) silenceTone();');
  lines.push('}');
  lines.push('');
  lines.push('void allLedsOff() {');
  for (const led of [...plan.extraLeds, plan.greenLed, plan.redLed, plan.statusLed]) {
    if (led) lines.push(`  digitalWrite(${led}, LOW);`);
  }
  if (allLeds.length === 0) lines.push('  /* this build has no indicator LED */');
  lines.push('}');
  lines.push('');
  lines.push('/* Steady, flashing or off — one helper so no state forgets to clear an LED. */');
  lines.push('enum LedMode { LED_OFF, LED_ON, LED_SLOW_FLASH, LED_FAST_FLASH };');
  lines.push('');
  lines.push('void driveLeds(LedMode red, LedMode green) {');
  lines.push('  uint32_t now = millis();');
  lines.push('  uint32_t period = 500UL;');
  lines.push('  if (red == LED_FAST_FLASH || green == LED_FAST_FLASH) period = 120UL;');
  lines.push('  if (now - lastLedAt >= period) {');
  lines.push('    lastLedAt = now;');
  lines.push('    ledOn = !ledOn;');
  lines.push('  }');
  lines.push('  bool redLevel = red == LED_ON || ((red == LED_SLOW_FLASH || red == LED_FAST_FLASH) && ledOn);');
  lines.push('  bool greenLevel = green == LED_ON || ((green == LED_SLOW_FLASH || green == LED_FAST_FLASH) && ledOn);');
  if (plan.redLed) lines.push(`  digitalWrite(${plan.redLed}, redLevel ? HIGH : LOW);`);
  else lines.push('  (void)redLevel;');
  if (plan.greenLed) lines.push(`  digitalWrite(${plan.greenLed}, greenLevel ? HIGH : LOW);`);
  else lines.push('  (void)greenLevel;');
  if (plan.statusLed) lines.push(`  digitalWrite(${plan.statusLed}, (redLevel || greenLevel) ? HIGH : LOW);`);
  for (const led of plan.extraLeds) {
    lines.push(`  digitalWrite(${led}, redLevel ? HIGH : LOW);  // extra indicator follows the alarm line`);
  }
  if (allLeds.length === 0) lines.push('  /* no LED in this build */');
  lines.push('}');
  lines.push('');

  /* Display ------------------------------------------------------------------ */
  lines.push('const char *stateName(LockState value) {');
  lines.push('  switch (value) {');
  lines.push(`    case STATE_IDLE: return "${plan.words.locked.toLowerCase()}";`);
  lines.push('    case STATE_GRANTED: return "granted";');
  lines.push('    case STATE_OPEN: return "open";');
  lines.push('    case STATE_DENIED: return "denied";');
  lines.push('    case STATE_ALARM: return "alarm";');
  lines.push('    case STATE_CHANGE_OLD: return "change-pin";');
  lines.push('    case STATE_CHANGE_NEW: return "new-pin";');
  lines.push('    case STATE_CHANGE_SAVE: return "confirm-pin";');
  lines.push('  }');
  lines.push('  return "unknown";');
  lines.push('}');
  lines.push('');

  if (plan.display) {
    const out = plan.display.kind === 'oled' ? 'oled' : 'lcd';
    const rows = plan.display.kind === 'oled' ? 4 : 2;
    lines.push(`const uint8_t DISPLAY_ROWS = ${rows};`);
    lines.push('');
    lines.push('/* Rows past the panel height are dropped: a 1602 LCD has two, an OLED four. */');
    lines.push('void showLine(uint8_t row, const char *text) {');
    lines.push('  if (!displayReady || row >= DISPLAY_ROWS) return;');
    if (plan.display.kind === 'oled') {
      lines.push(`  ${out}.setCursor(0, row * 16);`);
      lines.push(`  ${out}.println(text);`);
    } else {
      lines.push(`  ${out}.setCursor(0, row);`);
      lines.push(`  ${out}.print(text);`);
    }
    lines.push('}');
    lines.push('');
    lines.push('void renderDisplay() {');
    lines.push('  if (!displayReady) return;');
    if (plan.display.kind === 'oled') {
      lines.push('  oled.clearDisplay();');
      lines.push('  oled.setTextSize(1);');
      lines.push('  oled.setTextColor(SSD1306_WHITE);');
    } else {
      lines.push('  lcd.clear();');
    }
    lines.push('  char line[32];');
    lines.push('  switch (state) {');
    lines.push('    case STATE_ALARM: {');
    lines.push('      uint16_t secondsLeft = (uint16_t)((alarmUntil - millis()) / 1000UL) + 1;');
    lines.push(`      showLine(0, ${cString(plan.words.alarm)});`);
    lines.push('      snprintf(line, sizeof(line), "locked %us  tries %u", secondsLeft, failedAttempts);');
    lines.push('      showLine(1, line);');
    lines.push('      break;');
    lines.push('    }');
    lines.push('    case STATE_GRANTED:');
    lines.push(`      showLine(0, ${cString(plan.words.granted)});`);
    lines.push(`      showLine(1, ${cString(plan.words.open)});`);
    lines.push('      break;');
    lines.push('    case STATE_OPEN:');
    lines.push(`      showLine(0, ${cString(plan.words.open)});`);
    lines.push(`      showLine(1, doorOpen ? ${cString(plan.words.doorOpen)} : ${cString(plan.words.doorClosed)});`);
    lines.push('      break;');
    lines.push('    case STATE_DENIED:');
    lines.push(`      showLine(0, ${cString(plan.words.denied)});`);
    lines.push('      snprintf(line, sizeof(line), "tries %u/%u", failedAttempts, MAX_FAILED_ATTEMPTS);');
    lines.push('      showLine(1, line);');
    lines.push('      break;');
    lines.push('    case STATE_CHANGE_OLD:');
    lines.push(`      showLine(0, ${cString(plan.words.changePin)});`);
    lines.push('      showLine(1, "current PIN");');
    lines.push('      break;');
    lines.push('    case STATE_CHANGE_NEW:');
    lines.push('    case STATE_CHANGE_SAVE:');
    lines.push(`      showLine(0, ${cString(plan.words.changePin)});`);
    lines.push('      showLine(1, state == STATE_CHANGE_NEW ? "enter new" : "repeat new");');
    lines.push('      break;');
    lines.push('    default: {');
    lines.push('      // Digits are never shown, only one "*" per key pressed so far.');
    lines.push('      char masked[PIN_MAX_LENGTH + 1];');
    lines.push('      uint8_t count = enteredLength > PIN_MAX_LENGTH ? PIN_MAX_LENGTH : enteredLength;');
    lines.push("      for (uint8_t index = 0; index < count; index++) masked[index] = '*';");
    lines.push('      masked[count] = 0;');
    if (plan.display.kind === 'oled') {
      lines.push(`      showLine(0, ${cString(plan.words.locked)});`);
      lines.push(`      showLine(1, ${cString(plan.words.enterPin)});`);
      lines.push('      showLine(2, masked);');
    } else {
      lines.push(`      showLine(0, ${cString(plan.words.locked.slice(0, 16))});`);
      lines.push(`      snprintf(line, sizeof(line), "%s%s", ${cString(plan.words.enterPin.slice(0, 10))}, masked);`);
      lines.push('      showLine(1, line);');
    }
    lines.push('      break;');
    lines.push('    }');
    lines.push('  }');
    if (plan.door && plan.display.kind === 'oled') {
      lines.push('  snprintf(line, sizeof(line), "door:%s lock:%s", doorOpen ? "open" : "closed", lockIsUnlocked() ? "open" : "locked");');
      lines.push('  showLine(3, line);');
    }
    if (plan.display.kind === 'oled') lines.push('  oled.display();');
    lines.push('}');
  } else {
    lines.push('void renderDisplay() {');
    lines.push('  /* No display in this build: the same information goes to the serial link. */');
    lines.push('  controlLink.print("ui:");');
    lines.push('  controlLink.println(stateName(state));');
    lines.push('}');
  }
  lines.push('');

  /* PIN storage -------------------------------------------------------------- */
  lines.push('bool pinMatches(const char *candidate, uint8_t length) {');
  lines.push('  if (length != storedPinLength) return false;');
  lines.push('  for (uint8_t index = 0; index < length; index++) if (candidate[index] != storedPin[index]) return false;');
  lines.push('  return true;');
  lines.push('}');
  lines.push('');
  if (plan.eeprom) {
    lines.push('/* The PIN lives in EEPROM so a power cycle does not reset it. */');
    lines.push('const uint16_t PIN_STORE_ADDRESS = 0;');
    lines.push('const uint8_t PIN_STORE_MAGIC = 0xA7;');
    lines.push('');
    lines.push('void defaultPin() {');
    lines.push(`  const char *fallback = ${cString(plan.defaultPin)};`);
    lines.push('  storedPinLength = 0;');
    lines.push('  while (fallback[storedPinLength] != 0 && storedPinLength < PIN_MAX_LENGTH) {');
    lines.push('    storedPin[storedPinLength] = fallback[storedPinLength];');
    lines.push('    storedPinLength++;');
    lines.push('  }');
    lines.push('  storedPin[storedPinLength] = 0;');
    lines.push('}');
    lines.push('');
    lines.push('void loadPin() {');
    if (platformIsEsp32) lines.push('  EEPROM.begin(64);');
    else lines.push('#if defined(ESP32)\n  EEPROM.begin(64);\n#endif');
    lines.push('  uint8_t magic = EEPROM.read(PIN_STORE_ADDRESS);');
    lines.push('  uint8_t length = EEPROM.read(PIN_STORE_ADDRESS + 1);');
    lines.push('  if (magic != PIN_STORE_MAGIC || length < PIN_MIN_LENGTH || length > PIN_MAX_LENGTH) {');
    lines.push('    defaultPin();');
    lines.push('    controlLink.println("warn: no stored PIN found - the factory default is in use");');
    lines.push('    return;');
    lines.push('  }');
    lines.push('  for (uint8_t index = 0; index < length; index++) {');
    lines.push('    char digit = (char)EEPROM.read(PIN_STORE_ADDRESS + 2 + index);');
    lines.push("    if (digit < '0' || digit > '9') { defaultPin(); return; }");
    lines.push('    storedPin[index] = digit;');
    lines.push('  }');
    lines.push('  storedPinLength = length;');
    lines.push('  storedPin[storedPinLength] = 0;');
    lines.push('}');
    lines.push('');
    lines.push('void savePin() {');
    lines.push('  EEPROM.write(PIN_STORE_ADDRESS, PIN_STORE_MAGIC);');
    lines.push('  EEPROM.write(PIN_STORE_ADDRESS + 1, storedPinLength);');
    lines.push('  for (uint8_t index = 0; index < storedPinLength; index++) {');
    lines.push('    EEPROM.write(PIN_STORE_ADDRESS + 2 + index, (uint8_t)storedPin[index]);');
    lines.push('  }');
    lines.push('#if defined(ESP32)');
    lines.push('  EEPROM.commit();');
    lines.push('#endif');
    lines.push('}');
  } else {
    lines.push('/* EEPROM.h is not in this build, so the PIN is compiled in. */');
    lines.push('void defaultPin() {');
    lines.push(`  const char *fallback = ${cString(plan.defaultPin)};`);
    lines.push('  storedPinLength = 0;');
    lines.push('  while (fallback[storedPinLength] != 0 && storedPinLength < PIN_MAX_LENGTH) {');
    lines.push('    storedPin[storedPinLength] = fallback[storedPinLength];');
    lines.push('    storedPinLength++;');
    lines.push('  }');
    lines.push('  storedPin[storedPinLength] = 0;');
    lines.push('}');
    lines.push('');
    lines.push('void loadPin() { defaultPin(); }');
    lines.push('void savePin() { controlLink.println("warn: no EEPROM in this build - the new PIN is lost on reset"); }');
  }
  lines.push('');

  /* Transitions -------------------------------------------------------------- */
  lines.push('void enterState(LockState next) {');
  lines.push('  state = next;');
  lines.push('  stateEnteredAt = millis();');
  lines.push('  displayDirty = true;');
  lines.push('}');
  lines.push('');
  lines.push('void unlock() {');
  lines.push('  setLockTarget(UNLOCKED_ANGLE);');
  if (plan.greenLed) lines.push(`  digitalWrite(${plan.greenLed}, HIGH);`);
  lines.push('  setTone(1960, 120);');
  lines.push('  enterState(STATE_GRANTED);');
  lines.push('  controlLink.println("ok:access-granted");');
  lines.push('}');
  lines.push('');
  lines.push('void lock() {');
  lines.push('  setLockTarget(LOCKED_ANGLE);');
  lines.push('  allLedsOff();');
  lines.push('  enterState(STATE_IDLE);');
  lines.push('  controlLink.println("ok:locked");');
  lines.push('}');
  lines.push('');
  lines.push('void deny() {');
  lines.push('  failedAttempts++;');
  lines.push('  enteredLength = 0;');
  lines.push('  entered[0] = 0;');
  lines.push('  setTone(220, 400);');
  lines.push('  controlLink.print("warn:access-denied attempts=");');
  lines.push('  controlLink.println(failedAttempts);');
  lines.push('  if (failedAttempts >= MAX_FAILED_ATTEMPTS) {');
  lines.push('    alarmUntil = millis() + ALARM_LOCKOUT_MS;');
  lines.push('    enterState(STATE_ALARM);');
  lines.push('    setTone(880, 800);');
  lines.push('    controlLink.println("warn:alarm-raised keypad locked");');
  lines.push('    return;');
  lines.push('  }');
  lines.push('  enterState(STATE_DENIED);');
  lines.push('}');
  lines.push('');
  lines.push('void appendDigit(char digit) {');
  lines.push('  if (enteredLength >= PIN_MAX_LENGTH) {');
  lines.push('    setTone(300, 60);');
  lines.push('    return;');
  lines.push('  }');
  lines.push('  entered[enteredLength++] = digit;');
  lines.push('  entered[enteredLength] = 0;');
  lines.push('  setTone(1200, 40);');
  lines.push('  displayDirty = true;');
  lines.push('}');
  lines.push('');
  lines.push('void submitPin() {');
  lines.push('  if (state == STATE_CHANGE_OLD) {');
  lines.push('    if (pinMatches(entered, enteredLength)) {');
  lines.push('      enteredLength = 0;');
  lines.push('      entered[0] = 0;');
  lines.push('      newPinLength = 0;');
  lines.push('      newPin[0] = 0;');
  lines.push('      enterState(STATE_CHANGE_NEW);');
  lines.push('      controlLink.println("ok:change-pin-current-accepted");');
  lines.push('    } else {');
  lines.push('      enteredLength = 0;');
  lines.push('      entered[0] = 0;');
  lines.push('      setTone(220, 300);');
  lines.push('      controlLink.println("err:change-pin-current-rejected");');
  lines.push('      enterState(STATE_IDLE);');
  lines.push('    }');
  lines.push('    return;');
  lines.push('  }');
  lines.push('  if (state == STATE_CHANGE_NEW) {');
  lines.push('    if (enteredLength < PIN_MIN_LENGTH) {');
  lines.push('      setTone(220, 300);');
  lines.push('      controlLink.println("err:new-pin-too-short");');
  lines.push('      return;');
  lines.push('    }');
  lines.push('    for (uint8_t index = 0; index < enteredLength; index++) newPin[index] = entered[index];');
  lines.push('    newPinLength = enteredLength;');
  lines.push('    newPin[newPinLength] = 0;');
  lines.push('    enteredLength = 0;');
  lines.push('    entered[0] = 0;');
  lines.push('    enterState(STATE_CHANGE_SAVE);');
  lines.push('    return;');
  lines.push('  }');
  lines.push('  if (state == STATE_CHANGE_SAVE) {');
  lines.push('    bool same = enteredLength == newPinLength;');
  lines.push('    for (uint8_t index = 0; same && index < enteredLength; index++) if (entered[index] != newPin[index]) same = false;');
  lines.push('    enteredLength = 0;');
  lines.push('    entered[0] = 0;');
  lines.push('    if (!same) {');
  lines.push('      setTone(220, 400);');
  lines.push('      controlLink.println("err:new-pin-mismatch");');
  lines.push('      enterState(STATE_IDLE);');
  lines.push('      return;');
  lines.push('    }');
  lines.push('    for (uint8_t index = 0; index < newPinLength; index++) storedPin[index] = newPin[index];');
  lines.push('    storedPinLength = newPinLength;');
  lines.push('    storedPin[storedPinLength] = 0;');
  lines.push('    savePin();');
  lines.push('    setTone(2400, 120);');
  lines.push('    controlLink.println("ok:pin-changed");');
  lines.push('    enterState(STATE_IDLE);');
  lines.push('    return;');
  lines.push('  }');
  lines.push('  if (enteredLength < PIN_MIN_LENGTH) {');
  lines.push('    setTone(220, 300);');
  lines.push('    controlLink.println("err:pin-too-short");');
  lines.push('    enteredLength = 0;');
  lines.push('    entered[0] = 0;');
  lines.push('    displayDirty = true;');
  lines.push('    return;');
  lines.push('  }');
  lines.push('  if (pinMatches(entered, enteredLength)) {');
  lines.push('    failedAttempts = 0;');
  lines.push('    enteredLength = 0;');
  lines.push('    entered[0] = 0;');
  lines.push('    unlock();');
  lines.push('  } else {');
  lines.push('    deny();');
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push('void handleKey(char key) {');
  lines.push("  if (key == '*') {");
  lines.push('    enteredLength = 0;');
  lines.push('    entered[0] = 0;');
  lines.push('    displayDirty = true;');
  lines.push('    setTone(600, 40);');
  lines.push('    return;');
  lines.push('  }');
  lines.push("  if (key == '#') { submitPin(); return; }");
  lines.push("  if (key >= '0' && key <= '9') { appendDigit(key); return; }");
  lines.push('  // A-D keys are not part of the PIN; report them so the host can react.');
  lines.push('  controlLink.print("info:key=");');
  lines.push('  controlLink.println(key);');
  lines.push('}');
  lines.push('');

  /* Telemetry ---------------------------------------------------------------- */
  lines.push('void sendTelemetry(bool force) {');
  lines.push('  uint32_t now = millis();');
  lines.push('  if (!force && now - lastTelemetryAt < TELEMETRY_INTERVAL_MS) return;');
  lines.push('  lastTelemetryAt = now;');
  lines.push('  controlLink.print("status:{\\"state\\":\\"");');
  lines.push('  controlLink.print(stateName(state));');
  lines.push('  controlLink.print("\\",\\"locked\\":");');
  lines.push('  controlLink.print(lockIsUnlocked() ? "false" : "true");');
  lines.push('  controlLink.print(",\\"door\\":\\"");');
  lines.push('  controlLink.print(doorOpen ? "open" : "closed");');
  lines.push('  controlLink.print("\\",\\"attempts\\":");');
  lines.push('  controlLink.print(failedAttempts);');
  if (plan.lock.kind === 'servo') {
    lines.push('  controlLink.print(",\\"angle\\":");');
    lines.push('  controlLink.print(servoAngle);');
  }
  lines.push('  controlLink.println("}");');
  lines.push('}');
  lines.push('');

  /* setup -------------------------------------------------------------------- */
  lines.push('void setup() {');
  lines.push(`  Serial.begin(${baud});`);
  if (linkName !== 'Serial') lines.push('  controlLink.begin(LINK_BAUD);');
  lines.push('  // The lock is driven to its safe (locked) position before anything else, so');
  lines.push('  // a reset can never leave the mechanism unlocked or lurch it mid-travel.');
  if (plan.lock.kind === 'servo') {
    lines.push(`  ${plan.lock.identifier}.attach(${plan.lock.constant});`);
    lines.push(`  ${plan.lock.identifier}.write(LOCKED_ANGLE);`);
    lines.push('  servoAngle = LOCKED_ANGLE;');
    lines.push('  servoTarget = LOCKED_ANGLE;');
  } else {
    lines.push(`  pinMode(${plan.lock.constant}, OUTPUT);`);
    lines.push('  digitalWrite(' + plan.lock.constant + `, LOCK_ACTIVE_LOW ? HIGH : LOW);`);
  }
  for (const led of [...allLeds]) {
    lines.push(`  pinMode(${led}, OUTPUT);`);
  }
  if (plan.buzzer) lines.push(`  pinMode(${plan.buzzer.constant}, OUTPUT);`);
  lines.push('  allLedsOff();');
  lines.push('');
  if (plan.matrix) {
    lines.push('  for (uint8_t row = 0; row < KEYPAD_ROW_COUNT; row++) {');
    lines.push('    pinMode(KEYPAD_ROWS[row], OUTPUT);');
    lines.push('    digitalWrite(KEYPAD_ROWS[row], HIGH);  // idle high; a scan pulls one row low');
    lines.push('  }');
    lines.push('  for (uint8_t column = 0; column < KEYPAD_COLUMN_COUNT; column++) {');
    lines.push('    pinMode(KEYPAD_COLUMNS[column], INPUT_PULLUP);');
    lines.push('  }');
  } else {
    lines.push('  for (uint8_t index = 0; index < KEY_COUNT; index++) pinMode(KEY_PINS[index], INPUT_PULLUP);');
  }
  if (plan.door) lines.push(`  pinMode(${plan.door.constant}, INPUT_PULLUP);`);
  lines.push('');
  if (ctx.i2cBuses.length > 0 || plan.display) {
    for (const line of i2cBusInitLines({
      assignments: ctx.assignments,
      buses: ctx.i2cBuses,
      ...(ctx.profile ? { profile: ctx.profile } : {}),
      linkIdentifier: 'controlLink',
    })) {
      lines.push(`  ${line}`);
    }
  }
  if (plan.display?.kind === 'oled') {
    lines.push('  displayReady = oled.begin(SSD1306_SWITCHCAPVCC, DISPLAY_ADDRESS);');
    lines.push('  if (!displayReady) {');
    lines.push('    controlLink.println("warn: SSD1306 not answering at DISPLAY_ADDRESS - the UI goes to serial");');
    lines.push('  } else {');
    lines.push('    oled.setTextWrap(false);');
    lines.push('  }');
  } else if (plan.display?.kind === 'lcd') {
    lines.push('  lcd.init();');
    lines.push('  lcd.backlight();');
  }
  lines.push('');
  lines.push('  loadPin();');
  lines.push('  entered[0] = 0;');
  lines.push('  newPin[0] = 0;');
  lines.push('  enterState(STATE_IDLE);');
  lines.push('  renderDisplay();');
  lines.push(`  controlLink.print("ready:${plan.words.locked.toLowerCase().replace(/\s+/g, '-')} pin-length=");`);
  lines.push('  controlLink.print(PIN_MIN_LENGTH);');
  lines.push('  controlLink.print("-");');
  lines.push('  controlLink.println(PIN_MAX_LENGTH);');
  lines.push('}');
  lines.push('');

  /* loop --------------------------------------------------------------------- */
  lines.push('void loop() {');
  lines.push('  uint32_t now = millis();');
  lines.push('  stepLock();');
  lines.push('  updateTone();');
  lines.push('');
  lines.push('  switch (state) {');
  lines.push('    case STATE_ALARM:');
  lines.push('      driveLeds(LED_FAST_FLASH, LED_OFF);');
  lines.push('      if (toneUntil == 0 && (now / 400UL) % 2UL == 0UL) setTone(1200, 180);');
  lines.push('      if (now >= alarmUntil) {');
  lines.push('        failedAttempts = 0;');
  lines.push('        silenceTone();');
  lines.push('        lock();');
  lines.push('        controlLink.println("ok:alarm-cleared");');
  lines.push('      } else if (now / 1000UL != lastCountdownSecond) {');
  lines.push('        lastCountdownSecond = now / 1000UL;');
  lines.push('        displayDirty = true;  // the countdown ticked over');
  lines.push('      }');
  lines.push('      break;');
  lines.push('');
  lines.push('    case STATE_GRANTED:');
  lines.push('      driveLeds(LED_OFF, LED_ON);');
  lines.push('      if (now - stateEnteredAt >= GRANTED_DISPLAY_MS) {');
  lines.push('        doorOpen = false;');
  lines.push('        enterState(STATE_OPEN);');
  lines.push('      }');
  lines.push('      break;');
  lines.push('');
  lines.push('    case STATE_OPEN:');
  lines.push('      driveLeds(LED_OFF, LED_ON);');
  if (plan.door) {
    lines.push('      if (doorSwitchPressed()) {');
    lines.push('        doorOpen = !doorOpen;');
    lines.push('        displayDirty = true;');
    lines.push('        controlLink.print("ok:door-");');
    lines.push('        controlLink.println(doorOpen ? "open" : "closed");');
    lines.push('        if (!doorOpen) {');
    lines.push('          // The door is shut again: re-lock without waiting for a PIN.');
    lines.push('          lock();');
    lines.push('        }');
    lines.push('      }');
  } else {
    lines.push('      // No door switch in this build: re-lock automatically after the grace');
    lines.push('      // period so an unlocked state can never be left behind.');
    lines.push('      if (now - stateEnteredAt >= 8000UL) lock();');
  }
  lines.push('      break;');
  lines.push('');
  lines.push('    case STATE_DENIED:');
  lines.push('      driveLeds(LED_SLOW_FLASH, LED_OFF);');
  lines.push('      if (now - stateEnteredAt >= DENIED_DISPLAY_MS) {');
  lines.push('        allLedsOff();');
  lines.push('        enterState(STATE_IDLE);');
  lines.push('      }');
  lines.push('      break;');
  lines.push('');
  lines.push('    default: {');
  lines.push('      driveLeds(LED_OFF, lockIsUnlocked() ? LED_ON : LED_OFF);');
  lines.push('');
  lines.push('      // Hold "*" to enter password-change mode; a short press still clears.');
  lines.push('      if (state == STATE_IDLE) {');
  lines.push('        if (starIsHeld()) {');
  lines.push('          if (!starHeld) {');
  lines.push('            starHeld = true;');
  lines.push('            starHeldSince = now;');
  lines.push('          } else if (now - starHeldSince >= HOLD_TO_CHANGE_MS) {');
  lines.push('            starHeld = false;');
  lines.push('            enteredLength = 0;');
  lines.push('            entered[0] = 0;');
  lines.push('            setTone(1500, 150);');
  lines.push('            enterState(STATE_CHANGE_OLD);');
  lines.push('            controlLink.println("ok:change-pin-started");');
  lines.push('          }');
  lines.push('        } else {');
  lines.push('          starHeld = false;');
  lines.push('        }');
  lines.push('      }');
  lines.push('');
  lines.push('      char key = readKey();');
  lines.push("      if (key != 0 && !(key == '*' && starHeld)) handleKey(key);");
  lines.push('      break;');
  lines.push('    }');
  lines.push('  }');
  lines.push('');
  lines.push('  if (displayDirty) {');
  lines.push('    displayDirty = false;');
  lines.push('    renderDisplay();');
  lines.push('  }');
  lines.push('');
  lines.push('  while (controlLink.available() > 0) {');
  lines.push('    char command = (char)controlLink.read();');
  lines.push("    if (command == '\\n' || command == '\\r') continue;");
  lines.push("    if (command == '?') { sendTelemetry(true); continue; }");
  lines.push("    if (command == 'L' || command == 'l') { lock(); continue; }");
  lines.push("    if (command == 'S' || command == 's') { sendTelemetry(true); continue; }");
  lines.push('    controlLink.println("err:unknown command");');
  lines.push('  }');
  lines.push('');
  lines.push('  sendTelemetry(false);');
  lines.push('}');

  return `${lines.join('\n')}\n`;
}
