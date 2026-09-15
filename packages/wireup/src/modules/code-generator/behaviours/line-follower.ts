/**
 * Line-follower behaviour (differential-drive robot on a marked track).
 *
 * The generic fallback sketch wires a robot's parts and then mostly idles: for
 * a line-follower brief it emitted the drive-channel table and a telemetry
 * skeleton but NO follow logic at all — the robot had motors and sensors and no
 * program that used them together, which is the same "right parts, wrong
 * program" failure the safe build had. This module recognises the pattern from
 * the structured project (≥2 reflectance sensors + an H-bridge with ≥2 drive
 * channels) and emits a complete, non-blocking implementation:
 *
 *   • two reflectance sensors straddling the line; the robot steers toward the
 *     sensor that still sees it,
 *   • pivot steering on the inner channel so junctions are not wide arcs,
 *   • a lost-line grace window (hold the last command), then a controlled stop
 *     and a reported alarm instead of driving blind,
 *   • a start/stop pushbutton with edge debounce, motors stopped at boot and
 *     whenever the run is halted,
 *   • PWM speed on the driver's enable pins when the plan assigns them,
 *   • status LED (plus any further LEDs mirroring it), buzzer chirps,
 *   • telemetry at 1 Hz and `?`/`S`/`G`/`H` console commands.
 *
 * Detection is structural, not keyword-based: the catalog marks which parts are
 * line/reflectance sensors, and the pin plan must actually contain two of them
 * plus a real drive train. Anything the plan assigns that this module cannot
 * drive (a display, a servo, a second button…) makes detection bail and hands
 * the build back to the generic skeleton — invariant 7 (every assigned pin is
 * driven by the firmware) is enforced by construction, not by luck.
 */

import type { ComponentDefinition } from '@/types/component';
import type { PinAssignment } from '@/types/wiring';

import type { SketchContext } from '../templates';
import {
  buildIncludesBlock,
  buildPinMapBlock,
  constantName,
  safeIdentifier,
  uniqueCodeAssignments,
} from '../managed-blocks';

/* ------------------------------------------------------------------------- */
/* Detection                                                                  */
/* ------------------------------------------------------------------------- */

export interface LineFollowerSensor {
  constant: string;
  instanceId: string;
  label: string;
}

export interface LineFollowerChannel {
  name: string;
  in1: string;
  in2: string;
  /** Constant for the enable/PWM pin, or undefined when the jumper is fitted. */
  enable?: string;
}

export interface LineFollowerPlan {
  sensors: LineFollowerSensor[];
  channels: LineFollowerChannel[];
  driverLabel: string;
  startButton?: { constant: string; instanceId: string; label: string };
  statusLed?: string;
  /** Further LEDs mirror the status line so no assigned pin is left undriven. */
  extraLeds: string[];
  buzzer?: { constant: string; passive: boolean };
  baseSpeed: number;
  turnSpeed: number;
  /**
   * True when the sensor module pulls its OUT line HIGH over the black line
   * (the usual active-LOW reflectance module: LOW = reflection = white floor).
   */
  lineReadsHigh: boolean;
  words: { device: string; running: string; stopped: string; lost: string };
  notes: string[];
}

function hasLibrary(ctx: SketchContext, header: string): boolean {
  return ctx.softwarePlan.libraries.some((library) => library.import.toLowerCase() === header.toLowerCase());
}

function definitionFor(ctx: SketchContext, componentId: string): ComponentDefinition | undefined {
  return ctx.catalog.find((component) => component.id === componentId);
}

/** The catalog says which parts can see a line — not the user's wording. */
function isLineSensor(definition: ComponentDefinition | undefined): boolean {
  if (!definition) return false;
  if (definition.category !== 'sensor') return false;
  if (definition.keywords?.some((keyword) => /line\s*follow/i.test(keyword))) return true;
  return /line|reflect|track/i.test(`${definition.id} ${definition.name}`);
}

function labelOfInstance(ctx: SketchContext, instanceId: string): string {
  const selection = ctx.selections.find((candidate) => candidate.instances.some((instance) => instance.instanceId === instanceId));
  const instance = selection?.instances.find((entry) => entry.instanceId === instanceId);
  return instance?.label ?? instance?.name ?? selection?.name ?? instanceId;
}

/** H-bridge drive channels from the pin plan: IN1/IN2 and IN3/IN4 pairs. */
function driveChannelsFor(assignments: PinAssignment[], instanceId: string): LineFollowerChannel[] {
  const inputs = assignments
    .filter((entry) => entry.targetInstanceId === instanceId && /^IN\d+$/i.test(entry.targetPin))
    .map((entry) => ({ number: Number.parseInt(/^IN(\d+)$/i.exec(entry.targetPin)?.[1] ?? '0', 10), constant: constantName(entry) }))
    .filter((entry) => Number.isFinite(entry.number) && entry.number > 0)
    .sort((a, b) => a.number - b.number);

  const channels: LineFollowerChannel[] = [];
  for (let index = 0; index + 1 < inputs.length; index += 2) {
    const first = inputs[index];
    const second = inputs[index + 1];
    if (!first || !second) break;
    const enable = assignments.find(
      (entry) => entry.targetInstanceId === instanceId && entry.targetPin.toUpperCase() === `EN${String.fromCharCode(65 + channels.length)}`,
    );
    channels.push({
      name: `MOTOR_${String.fromCharCode(65 + channels.length)}`,
      in1: first.constant,
      in2: second.constant,
      ...(enable ? { enable: constantName(enable) } : {}),
    });
  }
  return channels;
}

export function detectLineFollower(ctx: SketchContext): LineFollowerPlan | null {
  const { assignments } = uniqueCodeAssignments(ctx.assignments);
  const notes: string[] = [];

  /* --- the track sensors -------------------------------------------------- */
  /*
   * One sensor can only say "line / no line" and cannot tell a steer-by-error
   * controller which way the line went, so fewer than two hands the build back
   * to the generic skeleton rather than faking a follower (invariant 8).
   */
  const sensorAssignments = assignments.filter((entry) => {
    const selection = ctx.selections.find((candidate) => candidate.instances.some((instance) => instance.instanceId === entry.targetInstanceId));
    const definition = definitionFor(ctx, selection?.componentId ?? '');
    return isLineSensor(definition) && entry.direction === 'input' && entry.protocol === 'gpio';
  });
  if (sensorAssignments.length < 2) return null;

  /* --- the drive train ---------------------------------------------------- */
  const driverSelection = ctx.selections.find((selection) => {
    const definition = definitionFor(ctx, selection.componentId);
    return definition?.category === 'motor_driver' && selection.instances.some((instance) => driveChannelsFor(assignments, instance.instanceId).length >= 2);
  });
  const driverInstance = driverSelection?.instances.find((instance) => driveChannelsFor(assignments, instance.instanceId).length >= 2);
  if (!driverSelection || !driverInstance) return null;
  const channels = driveChannelsFor(assignments, driverInstance.instanceId);

  /* --- start/stop button -------------------------------------------------- */
  const buttonAssignments = assignments.filter((entry) => {
    const selection = ctx.selections.find((candidate) => candidate.instances.some((instance) => instance.instanceId === entry.targetInstanceId));
    return selection?.category === 'input_device' && /button/i.test(selection.componentId);
  });
  const startButtonAssignment = buttonAssignments[0];
  // A second button would be an undriven pin here; the generic skeleton gets it.
  if (buttonAssignments.length > 1) return null;

  /* --- indicators --------------------------------------------------------- */
  const ledAssignments = assignments.filter((entry) => {
    const selection = ctx.selections.find((candidate) => candidate.instances.some((instance) => instance.instanceId === entry.targetInstanceId));
    return selection?.category === 'actuator' && /led/i.test(selection.componentId) && !/rgb/i.test(selection.componentId);
  });
  const statusLed = ledAssignments[0];
  const extraLeds = ledAssignments.slice(1).map((entry) => constantName(entry));

  /* --- buzzer ------------------------------------------------------------- */
  const buzzerAssignment = assignments.find((entry) => /buzzer|piezo/i.test(entry.targetInstanceId));
  const buzzerPassive = buzzerAssignment
    ? definitionFor(ctx, ctx.selections.find((candidate) => candidate.instances.some((instance) => instance.instanceId === buzzerAssignment.targetInstanceId))?.componentId ?? '')?.metadata.active !== true
    : false;

  /* --- coverage: every assignment must be claimed ------------------------- */
  const claimed = new Set<string>([...sensorAssignments, ...assignments.filter((entry) => entry.targetInstanceId === driverInstance.instanceId)].map((entry) => entry.id));
  for (const entry of [startButtonAssignment, statusLed, buzzerAssignment]) if (entry) claimed.add(entry.id);
  for (const entry of extraLeds.length > 0 ? ledAssignments.slice(1) : []) claimed.add(entry.id);
  const unclaimed = assignments.filter((entry) => !claimed.has(entry.id));
  if (unclaimed.length > 0) return null;

  /* --- sensor polarity ---------------------------------------------------- */
  const sensorDefinitions = sensorAssignments.map((entry) =>
    definitionFor(ctx, ctx.selections.find((candidate) => candidate.instances.some((instance) => instance.instanceId === entry.targetInstanceId))?.componentId ?? ''),
  );
  /*
   * The common reflectance module is active-LOW: OUT pulls LOW when the
   * photodiode sees a reflection (white floor), so the black line reads HIGH.
   * The polarity is one constant in the sketch, and the header says how to
   * flip it for the other convention.
   */
  const mixedPolarity = sensorDefinitions.some((definition) => definition?.metadata.activeLevel === 'high');
  const lineReadsHigh = !mixedPolarity;
  if (mixedPolarity) notes.push('Sensors disagree about polarity (metadata.activeLevel high vs low) — the sketch assumes the black line reads HIGH on every sensor; adjust LINE_READS_HIGH per sensor if needed.');

  const device = /robot|rover|car|vehicle/i.test(ctx.requirements.goal) ? 'ROBOT' : 'LINE FOLLOWER';
  if (ctx.requirements.goal.trim().length === 0) notes.push('The brief had no goal text, so the sketch uses generic run messages.');

  return {
    sensors: sensorAssignments.map((entry) => ({
      constant: constantName(entry),
      instanceId: entry.targetInstanceId,
      label: labelOfInstance(ctx, entry.targetInstanceId),
    })),
    channels,
    driverLabel: labelOfInstance(ctx, driverInstance.instanceId),
    ...(startButtonAssignment
      ? { startButton: { constant: constantName(startButtonAssignment), instanceId: startButtonAssignment.targetInstanceId, label: labelOfInstance(ctx, startButtonAssignment.targetInstanceId) } }
      : {}),
    ...(statusLed ? { statusLed: constantName(statusLed) } : {}),
    extraLeds,
    ...(buzzerAssignment ? { buzzer: { constant: constantName(buzzerAssignment), passive: buzzerPassive } } : {}),
    baseSpeed: 170,
    turnSpeed: 120,
    lineReadsHigh,
    words: {
      device,
      running: 'FOLLOWING',
      stopped: 'STOPPED',
      lost: 'LINE LOST',
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

/** The firmware header comment, so every behaviour reports itself the same way. */
function header(ctx: SketchContext, plan: LineFollowerPlan): string[] {
  const lines: string[] = [];
  lines.push('/*');
  lines.push(` * ${ctx.projectName}`);
  lines.push(' *');
  if (ctx.projectSummary) lines.push(` * ${ctx.projectSummary}`);
  lines.push(` * Controller : ${ctx.controllerName}`);
  lines.push(` * Revision   : ${ctx.revision}`);
  lines.push(' * Generated  : Wireup hardware agent (line-follower behaviour)');
  lines.push(' *');
  lines.push(' * Behaviour:');
  lines.push(` *   - ${plan.sensors.length} line sensors straddle the track: ${plan.sensors.map((sensor) => sensor.label).join(' / ')}`);
  lines.push(' *   - the robot steers toward the sensor that still sees the line (pivot on the inner wheel)');
  lines.push(` *   - ${plan.startButton ? `${plan.startButton.label} starts and stops the run; the motors are stopped at boot` : 'the run starts at power-up; send H to halt'}`);
  lines.push(' *   - if the line disappears, the last command is held briefly, then the robot stops and reports LINE LOST');
  lines.push(` *   - the ${plan.driverLabel} channels are driven with PWM on their enable pins when wired`);
  lines.push(' *   - status:{"state":"…","left":…,"right":…,"command":"…","speed":…} at 1 Hz or on ?');
  lines.push(' *');
  lines.push(' * Nothing in loop() blocks: sensors are sampled on a timer, the button is');
  lines.push(' * edge-debounced, and tones are scheduled by deadline.');
  lines.push(' *');
  lines.push(` * Sensor polarity: LINE_READS_HIGH is ${plan.lineReadsHigh ? 'true' : 'false'} — the black line reads`);
  lines.push(` * ${plan.lineReadsHigh ? 'HIGH (typical active-LOW reflectance module: LOW = white floor)' : 'LOW'}; flip the constant if your modules differ.`);
  if (plan.notes.length > 0) {
    lines.push(' *');
    lines.push(' * Notes:');
    for (const note of plan.notes) lines.push(` *   - ${note}`);
  }
  lines.push(' */');
  return lines;
}

export function buildLineFollowerSketch(ctx: SketchContext, plan: LineFollowerPlan): string {
  const platformIsEsp32 = /esp32/i.test(ctx.controllerName) || /esp32/i.test(ctx.profile?.componentId ?? '');
  const lines: string[] = [];
  const link = ctx.serialLinks[0];
  const linkName = link && link.kind === 'hardware' ? link.id : 'Serial';
  const baud = link?.baud ?? 115200;
  const allLeds = [plan.statusLed, ...plan.extraLeds].filter((constant): constant is string => typeof constant === 'string');
  const leftSensor = plan.sensors[0];
  const rightSensor = plan.sensors[1];

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
  lines.push(`const uint8_t SPEED_BASE = ${plan.baseSpeed};   // 0-255, used when the driver's enable pins are wired`);
  lines.push(`const uint8_t SPEED_TURN = ${plan.turnSpeed};   // pivot speed while steering back to the line`);
  lines.push(`const bool LINE_READS_HIGH = ${plan.lineReadsHigh ? 'true' : 'false'};  // sensor OUT level over the black line`);
  lines.push('const uint32_t SENSOR_SAMPLE_MS = 15UL;   // sensor sample interval (debounce by sampling)');
  lines.push('const uint32_t LINE_LOST_GRACE_MS = 400UL; // keep the last steer command this long before giving up');
  lines.push('const uint32_t DEBOUNCE_MS = 30UL;         // start/stop button edge debounce');
  lines.push('const uint32_t TELEMETRY_INTERVAL_MS = 1000UL;');
  lines.push('const uint32_t CHIRP_MS = 60UL;');
  lines.push('');

  /* Drive channels ----------------------------------------------------------- */
  lines.push('/* Drive channels: enable < 0 means the jumper is fitted (always full speed). */');
  lines.push('struct MotorChannel {');
  lines.push('  const int in1;');
  lines.push('  const int in2;');
  lines.push('  const int enable;');
  lines.push('};');
  lines.push(`const MotorChannel CHANNELS[${plan.channels.length}] = {`);
  plan.channels.forEach((channel, index) => {
    lines.push(`  { ${channel.in1}, ${channel.in2}, ${channel.enable ?? -1} }${index < plan.channels.length - 1 ? ',' : ''}`);
  });
  lines.push('};');
  lines.push(`const uint8_t CHANNEL_COUNT = ${plan.channels.length};`);
  lines.push(`/* Sensor order is fixed: [0] = LEFT (${leftSensor?.label ?? 'left'}), [1] = RIGHT (${rightSensor?.label ?? 'right'}). */`);
  lines.push(`const int SENSOR_PINS[2] = { ${leftSensor?.constant}, ${rightSensor?.constant} };`);
  lines.push('');

  /* State -------------------------------------------------------------------- */
  lines.push('enum RunState {');
  lines.push('  STATE_STOPPED,    // motors off, waiting for the start command');
  lines.push('  STATE_RUNNING,    // following the line');
  lines.push('  STATE_LINE_LOST   // the track disappeared: grace expired, motors off');
  lines.push('};');
  lines.push('');
  lines.push('enum DriveCommand { CMD_STOP, CMD_FORWARD, CMD_LEFT, CMD_RIGHT };');
  lines.push('');
  lines.push('RunState state = STATE_STOPPED;');
  lines.push('DriveCommand command = CMD_STOP;');
  lines.push('bool lineSeen[2] = { false, false };');
  lines.push('uint32_t lastSampleAt = 0;');
  lines.push('uint32_t lastSteerAt = 0;');
  lines.push('uint32_t lastTelemetryAt = 0;');
  lines.push('uint32_t lastLedAt = 0;');
  lines.push('bool ledOn = false;');
  lines.push('uint32_t toneUntil = 0;');
  lines.push('uint8_t toneChirps = 0;');
  lines.push('uint32_t lastChirpAt = 0;');
  lines.push('bool lastButtonLevel = HIGH;');
  lines.push('uint32_t lastEdgeAt = 0;');
  lines.push('');
  if (plan.buzzer) {
    lines.push(`const int BUZZER_PIN = ${plan.buzzer.constant};`);
    lines.push(`const bool BUZZER_PASSIVE = ${plan.buzzer.passive ? 'true' : 'false'};`);
    lines.push('');
  }

  lines.push('const char* stateName(RunState value) {');
  lines.push('  switch (value) {');
  lines.push(`    case STATE_RUNNING: return ${cString(plan.words.running)};`);
  lines.push(`    case STATE_LINE_LOST: return ${cString(plan.words.lost)};`);
  lines.push('    default: return ' + cString(plan.words.stopped) + ';');
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push('const char* commandName(DriveCommand value) {');
  lines.push('  switch (value) {');
  lines.push('    case CMD_FORWARD: return "forward";');
  lines.push('    case CMD_LEFT: return "left";');
  lines.push('    case CMD_RIGHT: return "right";');
  lines.push('    default: return "stop";');
  lines.push('  }');
  lines.push('}');
  lines.push('');

  /* Drive helpers ------------------------------------------------------------ */
  lines.push('/* Drive both channels from one command; safe states never leave a channel floating. */');
  lines.push('void allMotorsStop() {');
  lines.push('  for (uint8_t channel = 0; channel < CHANNEL_COUNT; channel++) {');
  lines.push('    digitalWrite(CHANNELS[channel].in1, LOW);');
  lines.push('    digitalWrite(CHANNELS[channel].in2, LOW);');
  lines.push('    if (CHANNELS[channel].enable >= 0) analogWrite(CHANNELS[channel].enable, 0);');
  lines.push('  }');
  lines.push('  command = CMD_STOP;');
  lines.push('}');
  lines.push('');
  lines.push('void driveChannel(uint8_t channel, int direction, uint8_t speed) {');
  lines.push('  // direction 1 = forward, -1 = backward, 0 = coast/brake');
  lines.push('  digitalWrite(CHANNELS[channel].in1, direction > 0 ? HIGH : LOW);');
  lines.push('  digitalWrite(CHANNELS[channel].in2, direction < 0 ? HIGH : LOW);');
  lines.push('  if (CHANNELS[channel].enable >= 0) analogWrite(CHANNELS[channel].enable, direction == 0 ? 0 : speed);');
  lines.push('}');
  lines.push('');
  lines.push('void applyCommand(DriveCommand next) {');
  lines.push('  command = next;');
  lines.push('  switch (command) {');
  lines.push('    case CMD_FORWARD:');
  lines.push('      driveChannel(0, 1, SPEED_BASE);');
  lines.push('      driveChannel(1, 1, SPEED_BASE);');
  lines.push('      break;');
  lines.push('    case CMD_LEFT:  // pivot: inner channel brakes, outer channel turns');
  lines.push('      driveChannel(0, 0, 0);');
  lines.push('      driveChannel(1, 1, SPEED_TURN);');
  lines.push('      break;');
  lines.push('    case CMD_RIGHT:');
  lines.push('      driveChannel(0, 1, SPEED_TURN);');
  lines.push('      driveChannel(1, 0, 0);');
  lines.push('      break;');
  lines.push('    default:');
  lines.push('      allMotorsStop();');
  lines.push('      break;');
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push('/* Steer toward the sensor that still sees the line (sensors straddle the track). */');
  lines.push('DriveCommand decideCommand(bool leftOnLine, bool rightOnLine) {');
  lines.push('  if (leftOnLine && !rightOnLine) return CMD_LEFT;');
  lines.push('  if (!leftOnLine && rightOnLine) return CMD_RIGHT;');
  lines.push('  if (leftOnLine && rightOnLine) return CMD_FORWARD;  // junction or wide marking');
  lines.push('  return CMD_FORWARD;  // both off: caller decides via the lost-line grace window');
  lines.push('}');
  lines.push('');

  /* Buzzer ------------------------------------------------------------------- */
  if (plan.buzzer) {
    lines.push('void setTone(unsigned int frequency) {');
    lines.push('  if (BUZZER_PASSIVE) tone(BUZZER_PIN, frequency);');
    lines.push('  else digitalWrite(BUZZER_PIN, HIGH);');
    lines.push('}');
    lines.push('');
    lines.push('void quietBuzzer() {');
    lines.push('  if (BUZZER_PASSIVE) noTone(BUZZER_PIN);');
    lines.push('  else digitalWrite(BUZZER_PIN, LOW);');
    lines.push('}');
    lines.push('');
    lines.push('void scheduleChirps(uint8_t count) {');
    lines.push('  toneChirps = count;');
    lines.push('  lastChirpAt = 0;  // first chirp fires on the next loop pass');
    lines.push('}');
    lines.push('');
    lines.push('void stepChirps(uint32_t now) {');
    lines.push('  if (toneUntil != 0 && now >= toneUntil) {');
    lines.push('    quietBuzzer();');
    lines.push('    toneUntil = 0;');
    lines.push('  }');
    lines.push('  if (toneChirps > 0 && toneUntil == 0 && now - lastChirpAt >= CHIRP_MS * 2) {');
    lines.push('    setTone(1400);');
    lines.push('    toneUntil = now + CHIRP_MS;');
    lines.push('    lastChirpAt = now;');
    lines.push('    toneChirps -= 1;');
    lines.push('  }');
    lines.push('}');
    lines.push('');
  }

  /* Indicators --------------------------------------------------------------- */
  lines.push('void driveLeds(bool on) {');
  for (const led of allLeds) lines.push(`  digitalWrite(${led}, on ? HIGH : LOW);`);
  if (allLeds.length === 0) lines.push('  // no indicator LED in this build');
  lines.push('  ledOn = on;');
  lines.push('}');
  lines.push('');
  lines.push('void stepLeds(uint32_t now) {');
  lines.push('  if (state == STATE_LINE_LOST) {');
  lines.push('    if (now - lastLedAt >= 120UL) {');
  lines.push('      driveLeds(!ledOn);');
  lines.push('      lastLedAt = now;');
  lines.push('    }');
  lines.push('    return;');
  lines.push('  }');
  lines.push('  if (ledOn != (state == STATE_RUNNING)) driveLeds(state == STATE_RUNNING);');
  lines.push('}');
  lines.push('');

  /* Following ---------------------------------------------------------------- */
  lines.push('void stepFollow(uint32_t now) {');
  lines.push('  if (now - lastSampleAt < SENSOR_SAMPLE_MS) return;');
  lines.push('  lastSampleAt = now;');
  lines.push('  for (uint8_t sensor = 0; sensor < 2; sensor++) {');
  lines.push(`    lineSeen[sensor] = digitalRead(SENSOR_PINS[sensor]) == (LINE_READS_HIGH ? HIGH : LOW);`);
  lines.push('  }');
  lines.push('  const bool anyLine = lineSeen[0] || lineSeen[1];');
  lines.push('  if (state == STATE_LINE_LOST) {');
  lines.push('    if (anyLine) {');
  lines.push('      state = STATE_RUNNING;');
  lines.push('      controlLink.println("ok:line reacquired");');
  lines.push('    } else {');
  lines.push('      return;');
  lines.push('    }');
  lines.push('  }');
  lines.push('  if (lineSeen[0] || lineSeen[1]) {');
  lines.push('    const DriveCommand next = decideCommand(lineSeen[0], lineSeen[1]);');
  lines.push('    if (next != command) applyCommand(next);');
  lines.push('    lastSteerAt = now;');
  lines.push('  } else if (now - lastSteerAt >= LINE_LOST_GRACE_MS) {');
  lines.push('    allMotorsStop();');
  lines.push('    state = STATE_LINE_LOST;');
  if (plan.buzzer) lines.push('    scheduleChirps(3);');
  lines.push('    controlLink.println("warn:line lost - stopped");');
  lines.push('  }');
  lines.push('  // both sensors off inside the grace window: hold the last steer command');
  lines.push('}');
  lines.push('');

  /* Start/stop --------------------------------------------------------------- */
  lines.push('void startRun() {');
  lines.push('  state = STATE_RUNNING;');
  lines.push('  lastSteerAt = millis();');
  lines.push('  applyCommand(CMD_FORWARD);  // start assuming the line is centred');
  if (plan.buzzer) lines.push('  scheduleChirps(1);');
  lines.push('  controlLink.println("ok:run started");');
  lines.push('}');
  lines.push('');
  lines.push('void stopRun() {');
  lines.push('  state = STATE_STOPPED;');
  lines.push('  allMotorsStop();');
  if (plan.buzzer) lines.push('  scheduleChirps(2);');
  lines.push('  controlLink.println("ok:run stopped");');
  lines.push('}');
  lines.push('');

  /* Telemetry ---------------------------------------------------------------- */
  lines.push(`/* Telemetry keys: state, left, right, command, speed${plan.buzzer ? ', tone' : ''}. */`);
  lines.push('void sendTelemetry(bool force) {');
  lines.push('  uint32_t now = millis();');
  lines.push('  if (!force && now - lastTelemetryAt < TELEMETRY_INTERVAL_MS) return;');
  lines.push('  lastTelemetryAt = now;');
  lines.push('  controlLink.print("status:{\\"state\\":\\"");');
  lines.push('  controlLink.print(stateName(state));');
  lines.push('  controlLink.print("\\",\\"left\\":");');
  lines.push('  controlLink.print(lineSeen[0] ? "true" : "false");');
  lines.push('  controlLink.print(",\\"right\\":");');
  lines.push('  controlLink.print(lineSeen[1] ? "true" : "false");');
  lines.push('  controlLink.print(",\\"command\\":\\"");');
  lines.push('  controlLink.print(commandName(command));');
  lines.push('  controlLink.print("\\",\\"speed\\":");');
  lines.push('  controlLink.print(state == STATE_RUNNING ? static_cast<int>(SPEED_BASE) : 0);');
  lines.push('  controlLink.println("}");');
  lines.push('}');
  lines.push('');

  /* setup -------------------------------------------------------------------- */
  lines.push('void setup() {');
  lines.push(`  Serial.begin(${baud});`);
  if (linkName !== 'Serial') lines.push('  controlLink.begin(LINK_BAUD);');
  lines.push('  // Motors are stopped before anything else, so a reset can never lurch the');
  lines.push('  // robot forward with stale pin levels.');
  lines.push('  for (uint8_t channel = 0; channel < CHANNEL_COUNT; channel++) {');
  lines.push(`    pinMode(CHANNELS[channel].in1, OUTPUT);`);
  lines.push(`    pinMode(CHANNELS[channel].in2, OUTPUT);`);
  lines.push('    if (CHANNELS[channel].enable >= 0) pinMode(CHANNELS[channel].enable, OUTPUT);');
  lines.push('  }');
  lines.push('  allMotorsStop();');
  lines.push(`  pinMode(SENSOR_PINS[0], INPUT);`);
  lines.push(`  pinMode(SENSOR_PINS[1], INPUT);`);
  if (plan.startButton) lines.push(`  pinMode(${plan.startButton.constant}, INPUT_PULLUP);`);
  for (const led of allLeds) lines.push(`  pinMode(${led}, OUTPUT);`);
  if (plan.buzzer) lines.push(`  pinMode(BUZZER_PIN, OUTPUT);`);
  lines.push('  driveLeds(false);');
  if (plan.buzzer) lines.push('  quietBuzzer();');
  lines.push('  lastButtonLevel = ' + (plan.startButton ? `digitalRead(${plan.startButton.constant})` : 'HIGH') + ';');
  lines.push('  lineSeen[0] = false;');
  lines.push('  lineSeen[1] = false;');
  lines.push(`  controlLink.println("ok:${(plan.words.device || 'LINE FOLLOWER').toLowerCase()} ready - press the button or send G to start");`);
  lines.push('}');
  lines.push('');

  /* loop --------------------------------------------------------------------- */
  lines.push('void loop() {');
  lines.push('  uint32_t now = millis();');
  lines.push('');
  if (plan.startButton) {
    lines.push('  /* Start/stop: act on the pressed EDGE only, debounced by deadline. */');
    lines.push(`  const bool level = digitalRead(${plan.startButton.constant});`);
    lines.push('  if (level != lastButtonLevel && now - lastEdgeAt >= DEBOUNCE_MS) {');
    lines.push('    lastEdgeAt = now;');
    lines.push('    lastButtonLevel = level;');
    lines.push('    if (level == LOW) {');
    lines.push('      if (state == STATE_STOPPED) startRun();');
    lines.push('      else stopRun();');
    lines.push('    }');
    lines.push('  }');
    lines.push('');
  }
  lines.push('  if (state != STATE_STOPPED) stepFollow(now);');
  lines.push('  stepLeds(now);');
  if (plan.buzzer) lines.push('  stepChirps(now);');
  lines.push('');
  lines.push('  while (controlLink.available() > 0) {');
  lines.push('    const char incoming = static_cast<char>(controlLink.read());');
  lines.push("    if (incoming == '\\n' || incoming == '\\r') continue;");
  lines.push("    if (incoming == '?') { sendTelemetry(true); continue; }");
  lines.push("    if (incoming == 'S' || incoming == 's') { sendTelemetry(true); continue; }");
  lines.push("    if (incoming == 'G' || incoming == 'g') { if (state == STATE_STOPPED) startRun(); continue; }");
  lines.push("    if (incoming == 'H' || incoming == 'h') { if (state != STATE_STOPPED) stopRun(); continue; }");
  lines.push('    controlLink.println("err:unknown command");');
  lines.push('  }');
  lines.push('');
  lines.push('  sendTelemetry(false);');
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

/** Kept for symmetry with the other behaviour modules: a stable C identifier. */
export function instanceIdentifier(instanceId: string): string {
  return safeIdentifier(instanceId).toLowerCase();
}
