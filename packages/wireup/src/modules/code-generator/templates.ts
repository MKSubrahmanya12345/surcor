/**
 * Deterministic firmware construction blocks.
 *
 * These functions produce the parts of the sketch that MUST agree with the pin
 * plan (pin constants, includes, drive helpers) and a complete fallback sketch
 * when the model does not return usable code.
 */

import type { ComponentDefinition, ComponentSelection, LibraryRequirement } from '@/types/component';
import type { ProjectRequirements, SoftwarePlan } from '@/types/project';
import type { PinAssignment } from '@/types/wiring';
import type { I2CBus, SerialLink } from '@/modules/pin-planner';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';

/* ------------------------------------------------------------------------- */
/* Machine-managed blocks + shared primitives (see ./managed-blocks)          */
/* ------------------------------------------------------------------------- */

import { buildAccessControlSketch, detectAccessControl } from './behaviours/access-control';
import { buildLineFollowerSketch, detectLineFollower } from './behaviours/line-follower';
import {
  buildIncludesBlock,
  buildPinMapBlock,
  constantName,
  i2cBusInitLines,
  INCLUDES_END,
  INCLUDES_START,
  isAnalogAssignment,
  normaliseI2cAddress,
  pinLiteral,
  PIN_MAP_END,
  PIN_MAP_START,
  safeIdentifier,
} from './managed-blocks';

/* Re-exported so existing importers keep one stable path. */
export {
  buildIncludesBlock,
  buildPinMapBlock,
  constantName,
  includeStatement,
  normaliseI2cAddress,
  pinConstantMap,
  pinLiteral,
  uniqueCodeAssignments,
  INCLUDES_END,
  INCLUDES_START,
  PIN_MAP_END,
  PIN_MAP_START,
} from './managed-blocks';

export interface SketchContext {
  projectName: string;
  projectSummary: string;
  requirements: ProjectRequirements;
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  assignments: PinAssignment[];
  serialLinks: SerialLink[];
  i2cBuses: I2CBus[];
  softwarePlan: SoftwarePlan;
  controllerName: string;
  profile?: McuProfile;
  revision: number;
}

/* ------------------------------------------------------------------------- */
/* Fallback sketch                                                            */
/* ------------------------------------------------------------------------- */

interface DriveChannel {
  name: string;
  in1: string;
  in2: string;
  enable?: string;
}

function findAssignment(assignments: PinAssignment[], instanceId: string, pinName: string): PinAssignment | undefined {
  return assignments.find(
    (assignment) => assignment.targetInstanceId === instanceId && assignment.targetPin.toLowerCase() === pinName.toLowerCase(),
  );
}

function buildDriveChannels(ctx: SketchContext): DriveChannel[] {
  const channels: DriveChannel[] = [];
  const drivers = ctx.selections.filter((selection) => selection.category === 'motor_driver');

  for (const driver of drivers) {
    const definition = ctx.catalog.find((component) => component.id === driver.componentId);
    const rawMap = Array.isArray(definition?.metadata.channelMap) ? (definition?.metadata.channelMap as Record<string, unknown>[]) : [];
    const fallbackMap = [
      { channel: 'A', inputs: ['IN1', 'IN2'], enable: 'ENA' },
      { channel: 'B', inputs: ['IN3', 'IN4'], enable: 'ENB' },
    ];
    const mapEntries: Record<string, unknown>[] = rawMap.length > 0 ? rawMap : fallbackMap;

    for (const instance of driver.instances) {
      for (const entry of mapEntries) {
        const inputs = Array.isArray(entry.inputs) ? entry.inputs.map(String) : [];
        const enableName = typeof entry.enable === 'string' ? entry.enable : undefined;
        const in1 = findAssignment(ctx.assignments, instance.instanceId, inputs[0] ?? 'IN1');
        const in2 = findAssignment(ctx.assignments, instance.instanceId, inputs[1] ?? 'IN2');
        if (!in1 || !in2) continue;
        const enable = enableName ? findAssignment(ctx.assignments, instance.instanceId, enableName) : undefined;

        channels.push({
          name: `MOTOR_${String.fromCharCode(65 + channels.length)}`,
          in1: constantName(in1),
          in2: constantName(in2),
          ...(enable ? { enable: constantName(enable) } : {}),
        });
      }
    }
  }

  return channels;
}

function stateEnumName(stateId: string): string {
  return `STATE_${stateId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}


function hasLibrary(libraries: LibraryRequirement[], header: string): boolean {
  return libraries.some((library) => library.import.toLowerCase() === header.toLowerCase());
}

/**
 * Does the brief really ask to count something? Shared with the behavioural
 * assertion layer so the two can never drift. "pressed" and "counter-clockwise"
 * are NOT counting words.
 */
export function wantsCountingBrief(brief: string): boolean {
  return /\b(?:count(?:s|er)?(?!\s*[-–]?\s*clock)|tally|tallies|increments?|click(?:s|er)?|presses|press\s*count)\b/i.test(brief);
}

/** Does the brief ask for a reset/clear/zero action? (Shared with the assertion layer.) */
export function wantsResetBrief(brief: string): boolean {
  return /\b(reset|clear|zero)\b/i.test(brief);
}

/** Generate a complete Arduino sketch from the structured project data. */
export function generateSketch(ctx: SketchContext): string {
  /*
   * Behaviour first: when the build is an access-control device (a key input
   * plus something that locks), the generic movement/telemetry skeleton below
   * would compile happily and do none of what was asked — it counted button
   * presses on a project that was supposed to check a PIN and drive a bolt.
   */
  const accessControl = detectAccessControl(ctx);
  if (accessControl) return buildAccessControlSketch(ctx, accessControl);

  /*
   * Next: line followers. The generic skeleton below wires a robot's drive
   * channels and then never reads the track sensors together with them — the
   * robot could not follow anything. Detection is structural (two reflectance
   * sensors + a two-channel H-bridge), and it hands the build back here when
   * the pin plan carries anything it cannot drive, so no assigned pin is ever
   * left undriven by this dispatch.
   */
  const lineFollower = detectLineFollower(ctx);
  if (lineFollower) return buildLineFollowerSketch(ctx, lineFollower);

  const lines: string[] = [];
  const platformIsEsp32 = /esp32/i.test(ctx.controllerName);
  const libraries = ctx.softwarePlan.libraries;
  const channels = buildDriveChannels(ctx);
  const states =
    ctx.softwarePlan.controlStates.length > 0
      ? ctx.softwarePlan.controlStates
      : [{ id: 'idle', name: 'Idle', description: 'Default idle state', transitions: [] }];
  const commandSet = ctx.softwarePlan.communication?.commandSet ?? [];
  const link = ctx.serialLinks[0];

  const integratedRadio = ctx.selections.some((selection) => {
    const definition = ctx.catalog.find((component) => component.id === selection.componentId);
    return definition?.metadata.integrated === true;
  });
  const usesBluetoothSerial = platformIsEsp32 && integratedRadio;

  const servos = ctx.selections.filter((selection) => selection.category === 'motor' && /servo/i.test(selection.componentId));
  const servoActive = servos.length > 0 && hasLibrary(libraries, 'Servo.h');
  const leds = ctx.selections.filter(
    (selection) => selection.category === 'actuator' && /led/i.test(selection.componentId) && !/rgb/i.test(selection.componentId),
  );
  const buzzer = ctx.selections.find((selection) => /buzzer/i.test(selection.componentId));
  const dht = ctx.selections.find((selection) => /dht/i.test(selection.componentId));
  const dhtActive = Boolean(dht) && hasLibrary(libraries, 'DHT.h');
  const ultrasonic = ctx.selections.find((selection) => /sr04/i.test(selection.componentId));
  const pir = ctx.selections.find((selection) => /pir/i.test(selection.componentId));
  const lcd = ctx.selections.find((selection) => /lcd-1602/i.test(selection.componentId));
  const lcdActive = Boolean(lcd) && hasLibrary(libraries, 'LiquidCrystal_I2C.h');
  const oled = ctx.selections.find((selection) => /ssd1306/i.test(selection.componentId));
  const oledActive = Boolean(oled) && hasLibrary(libraries, 'Adafruit_SSD1306.h');
  const oledAddress = normaliseI2cAddress(ctx.catalog.find((component) => component.id === oled?.componentId)?.metadata.i2cAddress, '0x3C');
  const relay = ctx.selections.find((selection) => /relay/i.test(selection.componentId));

  const analogAssignments = ctx.assignments.filter((assignment) => assignment.protocol === 'adc');
  const buttonAssignments = ctx.assignments.filter((assignment) => {
    const selection = ctx.selections.find((candidate) => candidate.instances.some((instance) => instance.instanceId === assignment.targetInstanceId));
    return selection?.category === 'input_device' && /button/i.test(selection.componentId);
  });

  const ledAssignments = leds.flatMap((selection) =>
    selection.instances
      .map((instance) => ctx.assignments.find((entry) => entry.targetInstanceId === instance.instanceId))
      .filter((entry): entry is PinAssignment => entry !== undefined),
  );
  /*
   * A button counter is only the right firmware when the brief really is about
   * counting presses. Treating "no motor driver and no command set" as licence
   * to count is what turned a keypad safe into a tally counter: this build has
   * a display and a servo to drive, so it is not "nothing else to do".
   */
  const brief = `${ctx.projectName} ${ctx.projectSummary} ${ctx.requirements.goal} ${ctx.requirements.behaviors.join(' ')}`;
  /*
   * Counting words must be real counting words. The loose pattern used to
   * match "pressed" (any button brief) and "counter-clockwise" (a stepper
   * direction), which turned a stepper build into a press counter and put a
   * "Press count" card on its dashboard. `counter` must not be followed by
   * `-clockwise`, and `press` only counts as a noun ("presses") or the phrase
   * "press count", never as the verb "pressed".
   */
  const wantsCounting = wantsCountingBrief(brief);
  /*
   * A motor (servo, stepper, DC motor, or a driver board) is something to
   * drive, even when this generic template has no channel for it — a stepper
   * plus buttons is a "step on press" build, not a tally counter. Treating it
   * as "nothing else to drive" used to turn a 28BYJ-48 stepper build into a
   * press counter and put a "Press count" card on its dashboard.
   */
  const hasMotorActuation = ctx.selections.some(
    (selection) => selection.category === 'motor' || selection.category === 'motor_driver',
  );
  const nothingElseToDrive =
    channels.length === 0 &&
    (ctx.softwarePlan.communication?.commandSet?.length ?? 0) === 0 &&
    !hasMotorActuation &&
    !oledActive &&
    !lcdActive &&
    ledAssignments.length === 0;
  const counterMode = buttonAssignments.length > 0 && (wantsCounting || nothingElseToDrive);
  /*
   * "Press the first button to increase a counter, press the second to reset
   * it" is the canonical multi-button counter brief. Without special-casing it
   * every button runs the same `pressCount++`, so the reset button is just
   * another increment — the exact behaviour the prompt asked to avoid. When the
   * brief names a reset/clear/zero action, the LAST button zeroes the count and
   * the remaining buttons increment.
   */
  const wantsReset = /\b(reset|clear|zero)\b/i.test(brief);
  const resetButtonIndex =
    counterMode && wantsReset && buttonAssignments.length >= 2 ? buttonAssignments.length - 1 : -1;

  const trigAssignment = ultrasonic?.instances[0] ? findAssignment(ctx.assignments, ultrasonic.instances[0].instanceId, 'TRIG') : undefined;
  const echoAssignment = ultrasonic?.instances[0] ? findAssignment(ctx.assignments, ultrasonic.instances[0].instanceId, 'ECHO') : undefined;
  const ultrasonicActive = Boolean(trigAssignment && echoAssignment);
  const pirAssignment = pir?.instances[0] ? ctx.assignments.find((assignment) => assignment.targetInstanceId === pir.instances[0]?.instanceId) : undefined;
  const buzzerAssignment = buzzer?.instances[0] ? ctx.assignments.find((assignment) => assignment.targetInstanceId === buzzer.instances[0]?.instanceId) : undefined;

  /* Header ------------------------------------------------------------------ */
  lines.push('/*');
  lines.push(` * ${ctx.projectName}`);
  lines.push(' *');
  if (ctx.projectSummary) lines.push(` * ${ctx.projectSummary}`);
  lines.push(` * Controller : ${ctx.controllerName}`);
  lines.push(` * Revision   : ${ctx.revision}`);
  lines.push(' * Generated  : Wireup hardware agent');
  lines.push(' *');
  if (ctx.requirements.behaviors.length > 0) {
    lines.push(' * Behaviours:');
    for (const behaviour of ctx.requirements.behaviors.slice(0, 8)) lines.push(` *   - ${behaviour}`);
    lines.push(' *');
  }
  lines.push(' * Safety:');
  for (const safety of ctx.softwarePlan.safety.slice(0, 5)) lines.push(` *   - ${safety}`);
  lines.push(' */');
  lines.push('');

  /* Includes ---------------------------------------------------------------- */
  lines.push(buildIncludesBlock(libraries, platformIsEsp32));
  lines.push('');

  /* Pin map ----------------------------------------------------------------- */
  lines.push(buildPinMapBlock(ctx.assignments, ctx.profile));
  lines.push('');

  /* Communication link ------------------------------------------------------- */
  if (usesBluetoothSerial) {
    lines.push('#if defined(ESP32)');
    lines.push('#include <BluetoothSerial.h>');
    lines.push('BluetoothSerial controlLink;');
    lines.push('#else');
    lines.push('#define controlLink Serial');
    lines.push('#endif');
  } else if (link) {
    if (link.kind === 'software') {
      const rxConstant = constantForPin(ctx.assignments, link.mcuRxPin);
      const txConstant = constantForPin(ctx.assignments, link.mcuTxPin);
      lines.push('#include <SoftwareSerial.h>');
      lines.push(`SoftwareSerial controlLink(${rxConstant ?? `"${link.mcuRxPin}"`}, ${txConstant ?? `"${link.mcuTxPin}"`}); // RX, TX`);
    } else {
      lines.push(`#define controlLink ${link.id}`);
    }
  } else {
    lines.push('#define controlLink Serial');
  }
  const defaultBaud = link?.baud ?? (/bluetooth/i.test(ctx.softwarePlan.communication?.protocol ?? '') ? 9600 : 115200);
  lines.push(`const uint32_t LINK_BAUD = ${defaultBaud};`);
  lines.push('');

  /* Peripheral objects ------------------------------------------------------- */
  if (dhtActive && dht) {
    const dataAssignment = ctx.assignments.find((assignment) => assignment.targetInstanceId === dht.instances[0]?.instanceId);
    if (dataAssignment) {
      const sensorType = /dht11/i.test(dht.componentId) ? 'DHT11' : 'DHT22';
      lines.push(`DHT dhtSensor(${constantName(dataAssignment)}, ${sensorType});`);
      lines.push('float temperatureC = 0.0f;');
      lines.push('float humidityPercent = 0.0f;');
    }
  }
  if (lcdActive) {
    const address = normaliseI2cAddress(ctx.catalog.find((component) => component.id === lcd?.componentId)?.metadata.i2cAddress, '0x27');
    lines.push(`LiquidCrystal_I2C lcd(${address}, 16, 2);`);
  }
  if (oledActive) {
    lines.push(`#define OLED_ADDRESS ${oledAddress}`);
    lines.push('Adafruit_SSD1306 oled(128, 64, &Wire, -1);');
    lines.push('bool oledReady = false;');
  }
  if (servoActive) {
    servos.forEach((selection, selectionIndex) => {
      selection.instances.forEach((instance, instanceIndex) => {
        const signalAssignment = ctx.assignments.find((assignment) => assignment.targetInstanceId === instance.instanceId);
        if (!signalAssignment) return;
        const identifier = `servo${selectionIndex + 1}${instanceIndex + 1}`;
        lines.push(`Servo ${identifier};`);
        lines.push(`const int ${identifier.toUpperCase()}_PIN = ${constantName(signalAssignment)};`);
      });
    });
  }
  lines.push('');

  /* Drive stage -------------------------------------------------------------- */
  if (channels.length > 0) {
    lines.push('struct MotorChannel {');
    lines.push('  int in1;');
    lines.push('  int in2;');
    lines.push('  int enable; // -1 when the driver enable is jumpered high');
    lines.push('};');
    lines.push('');
    lines.push('MotorChannel motorChannels[] = {');
    channels.forEach((channel, channelIndex) => {
      const comma = channelIndex < channels.length - 1 ? ',' : '';
      lines.push(`  { ${channel.in1}, ${channel.in2}, ${channel.enable ?? '-1'} }${comma}`);
    });
    lines.push('};');
    lines.push('const uint8_t motorChannelCount = sizeof(motorChannels) / sizeof(motorChannels[0]);');
  } else {
    lines.push('const uint8_t motorChannelCount = 0;');
  }
  lines.push('');

  /* State machine ------------------------------------------------------------ */
  lines.push('enum MovementState {');
  states.forEach((state, stateIndex) => {
    lines.push(`  ${stateEnumName(state.id)}${stateIndex < states.length - 1 ? ',' : ''}`);
  });
  lines.push('};');
  lines.push('');
  lines.push(`MovementState currentState = ${stateEnumName(states[0]?.id ?? 'idle')};`);
  lines.push('uint8_t speedPercent = 70;');
  lines.push('uint32_t lastCommandAt = 0;');
  lines.push('uint32_t lastSensorAt = 0;');
  lines.push('uint32_t lastTelemetryAt = 0;');
  lines.push('const uint32_t FAILSAFE_TIMEOUT_MS = 500;');
  lines.push('const uint32_t SENSOR_INTERVAL_MS = 200;');
  lines.push('const uint32_t TELEMETRY_INTERVAL_MS = 1000;');
  lines.push(`const bool REMOTE_CONTROLLED = ${commandSet.length > 0 ? 'true' : 'false'};`);
  /*
   * Obstacle guard: when the build can drive AND can see ahead (an HC-SR04 on
   * assigned TRIG/ECHO pins), stopping before obstacles is the requested
   * behaviour of essentially every such brief ("a distance sensor that stops
   * the car"). Without this the sensor only fed telemetry and the build drove
   * into walls while reporting the distance at which it did so.
   */
  const obstacleGuard = channels.length > 0 && ultrasonicActive;
  if (obstacleGuard) {
    lines.push('const float OBSTACLE_STOP_CM = 15.0f; // auto-stop distance: the car halts before hitting obstacles');
  }
  if (buttonAssignments.length > 0) {
    lines.push('');
    lines.push('// Button handling (active-low with the internal pull-up, debounced in software).');
    lines.push('const uint32_t DEBOUNCE_MS = 30;');
    for (const assignment of buttonAssignments) {
      const id = buttonIdentifier(assignment);
      lines.push(`bool ${id}Stable = HIGH;      // debounced level of ${assignment.targetInstanceId}`);
      lines.push(`bool ${id}LastRaw = HIGH;     // last raw reading`);
      lines.push(`uint32_t ${id}ChangedAt = 0;  // when the raw reading last changed`);
    }
    if (counterMode) {
      lines.push('long pressCount = 0;');
      lines.push('bool displayDirty = true;');
    }
  }
  lines.push('');

  /* Forward declarations ------------------------------------------------------ */
  lines.push('// Forward declarations');
  lines.push('const char *stateName(MovementState state);');
  lines.push('void stopAllMotors();');
  lines.push('void applyMovement(MovementState state);');
  lines.push('void sendTelemetry(bool force);');
  if (dhtActive) lines.push('void readEnvironment();');
  if (ultrasonicActive) lines.push('float readDistanceCm();');
  if (lcdActive) lines.push('void renderLcd();');
  if (oledActive) lines.push('void renderOled();');
  if (commandSet.length > 0) lines.push('bool handleCommand(char command);');
  for (const assignment of buttonAssignments) lines.push(`bool ${buttonIdentifier(assignment)}Pressed();`);
  lines.push('');

  /* Button helpers ------------------------------------------------------------ */
  for (const assignment of buttonAssignments) {
    const id = buttonIdentifier(assignment);
    lines.push(`// Returns true exactly once per press of ${assignment.targetInstanceId} (falling edge after debounce).`);
    lines.push(`bool ${id}Pressed() {`);
    lines.push(`  bool raw = digitalRead(${constantName(assignment)});`);
    lines.push(`  if (raw != ${id}LastRaw) {`);
    lines.push(`    ${id}LastRaw = raw;`);
    lines.push(`    ${id}ChangedAt = millis();`);
    lines.push('  }');
    lines.push(`  if (millis() - ${id}ChangedAt < DEBOUNCE_MS || raw == ${id}Stable) return false;`);
    lines.push(`  ${id}Stable = raw;`);
    lines.push(`  return ${id}Stable == LOW;`);
    lines.push('}');
    lines.push('');
  }

  /* Motor helpers ------------------------------------------------------------ */
  if (channels.length > 0) {
    lines.push('void setMotor(uint8_t channel, int direction, uint8_t percent) {');
    lines.push('  if (channel >= motorChannelCount) return;');
    lines.push('  MotorChannel motor = motorChannels[channel];');
    lines.push('  int duty = constrain((int)percent, 0, 100) * 255 / 100;');
    lines.push('  if (direction > 0) {');
    lines.push('    digitalWrite(motor.in1, HIGH);');
    lines.push('    digitalWrite(motor.in2, LOW);');
    lines.push('  } else if (direction < 0) {');
    lines.push('    digitalWrite(motor.in1, LOW);');
    lines.push('    digitalWrite(motor.in2, HIGH);');
    lines.push('  } else {');
    lines.push('    digitalWrite(motor.in1, LOW);');
    lines.push('    digitalWrite(motor.in2, LOW);');
    lines.push('  }');
    lines.push('  if (motor.enable >= 0) analogWrite(motor.enable, direction == 0 ? 0 : duty);');
    lines.push('}');
    lines.push('');
    lines.push('void stopAllMotors() {');
    lines.push('  for (uint8_t channel = 0; channel < motorChannelCount; channel++) setMotor(channel, 0, 0);');
    lines.push('}');
    lines.push('');
    lines.push('void applyMovement(MovementState state) {');
    lines.push('  currentState = state;');
    lines.push('  switch (state) {');
    for (const state of states) {
      lines.push(`    case ${stateEnumName(state.id)}:`);
      if (state.id === 'forward') {
        lines.push('      for (uint8_t channel = 0; channel < motorChannelCount; channel++) setMotor(channel, 1, speedPercent);');
      } else if (state.id === 'reverse') {
        lines.push('      for (uint8_t channel = 0; channel < motorChannelCount; channel++) setMotor(channel, -1, speedPercent);');
      } else if (state.id === 'left') {
        lines.push('      setMotor(0, -1, speedPercent);');
        lines.push('      if (motorChannelCount > 1) setMotor(1, 1, speedPercent);');
      } else if (state.id === 'right') {
        lines.push('      setMotor(0, 1, speedPercent);');
        lines.push('      if (motorChannelCount > 1) setMotor(1, -1, speedPercent);');
      } else {
        lines.push('      stopAllMotors();');
      }
      lines.push('      break;');
    }
    lines.push('  }');
    lines.push('}');
  } else {
    lines.push('void stopAllMotors() { /* this build has no motor channels */ }');
    lines.push('void applyMovement(MovementState state) { currentState = state; }');
  }
  lines.push('');

  lines.push('const char *stateName(MovementState state) {');
  lines.push('  switch (state) {');
  for (const state of states) lines.push(`    case ${stateEnumName(state.id)}: return "${state.id}";`);
  lines.push('  }');
  lines.push('  return "unknown";');
  lines.push('}');
  lines.push('');

  /* Sensor helpers ----------------------------------------------------------- */
  if (ultrasonicActive && trigAssignment && echoAssignment) {
    lines.push('float readDistanceCm() {');
    lines.push(`  digitalWrite(${constantName(trigAssignment)}, LOW);`);
    lines.push('  delayMicroseconds(2);');
    lines.push(`  digitalWrite(${constantName(trigAssignment)}, HIGH);`);
    lines.push('  delayMicroseconds(10);');
    lines.push(`  digitalWrite(${constantName(trigAssignment)}, LOW);`);
    lines.push(`  uint32_t duration = pulseIn(${constantName(echoAssignment)}, HIGH, 30000UL);`);
    lines.push('  if (duration == 0) return -1.0f;');
    lines.push('  return (float)duration / 58.0f;');
    lines.push('}');
    lines.push('');
  }

  if (dhtActive) {
    lines.push('void readEnvironment() {');
    lines.push('  float temperature = dhtSensor.readTemperature();');
    lines.push('  float humidity = dhtSensor.readHumidity();');
    lines.push('  if (isnan(temperature) || isnan(humidity)) {');
    lines.push('    Serial.println("warn: DHT read failed");');
    lines.push('    return;');
    lines.push('  }');
    lines.push('  temperatureC = temperature;');
    lines.push('  humidityPercent = humidity;');
    lines.push('}');
    lines.push('');
  }

  if (lcdActive) {
    lines.push('void renderLcd() {');
    lines.push('  lcd.setCursor(0, 0);');
    if (counterMode) {
      lines.push('  lcd.print("Count:          ");');
      lines.push('  lcd.setCursor(7, 0);');
      lines.push('  lcd.print(pressCount);');
    } else {
      lines.push('  lcd.print("State:");');
      lines.push('  lcd.print(stateName(currentState));');
      lines.push('  lcd.print("   ");');
    }
    lines.push('  lcd.setCursor(0, 1);');
    if (dhtActive) {
      lines.push('  lcd.print(temperatureC, 1);');
      lines.push('  lcd.print("C ");');
      lines.push('  lcd.print(humidityPercent, 0);');
      lines.push('  lcd.print("%  ");');
    } else {
      lines.push('  lcd.print("Speed:");');
      lines.push('  lcd.print(speedPercent);');
      lines.push('  lcd.print("%  ");');
    }
    lines.push('}');
    lines.push('');
  }

  if (oledActive) {
    lines.push('void renderOled() {');
    lines.push('  if (!oledReady) return;');
    lines.push('  oled.clearDisplay();');
    lines.push('  oled.setTextSize(1);');
    lines.push('  oled.setTextColor(SSD1306_WHITE);');
    lines.push('  oled.setCursor(0, 0);');
    if (counterMode) {
      lines.push('  oled.println("Button counter");');
      lines.push('  oled.setTextSize(3);');
      lines.push('  oled.setCursor(0, 24);');
      lines.push('  oled.println(pressCount);');
    } else {
      lines.push('  oled.print("State: ");');
      lines.push('  oled.println(stateName(currentState));');
      if (channels.length > 0) {
        lines.push('  oled.print("Speed: ");');
        lines.push('  oled.println(speedPercent);');
      }
    }
    if (dhtActive) {
      lines.push('  oled.setTextSize(1);');
      lines.push('  oled.print("Temp: ");');
      lines.push('  oled.println(temperatureC, 1);');
    }
    lines.push('  oled.display();');
    lines.push('}');
    lines.push('');
  }

  /* Telemetry ---------------------------------------------------------------- */
  lines.push('void sendTelemetry(bool force) {');
  lines.push('  uint32_t now = millis();');
  lines.push('  if (!force && now - lastTelemetryAt < TELEMETRY_INTERVAL_MS) return;');
  lines.push('  lastTelemetryAt = now;');
  lines.push('  controlLink.print("status:{\\"state\\":\\"");');
  lines.push('  controlLink.print(stateName(currentState));');
  lines.push('  controlLink.print("\\",\\"speed\\":");');
  lines.push('  controlLink.print(speedPercent);');
  if (counterMode) {
    lines.push('  controlLink.print(",\\"count\\":");');
    lines.push('  controlLink.print(pressCount);');
  }
  if (dhtActive) {
    lines.push('  controlLink.print(",\\"tempC\\":");');
    lines.push('  controlLink.print(temperatureC, 1);');
    lines.push('  controlLink.print(",\\"rh\\":");');
    lines.push('  controlLink.print(humidityPercent, 1);');
  }
  if (ultrasonicActive) {
    lines.push('  controlLink.print(",\\"distanceCm\\":");');
    lines.push('  controlLink.print(readDistanceCm(), 1);');
  }
  for (const assignment of analogAssignments) {
    lines.push(`  controlLink.print(",\\"${safeIdentifier(assignment.targetInstanceId).toLowerCase()}\\":");`);
    lines.push(`  controlLink.print(analogRead(${constantName(assignment)}));`);
  }
  lines.push('  controlLink.println("}");');
  // In counter mode the display is redrawn on change (see loop), not on a timer.
  if (lcdActive && !counterMode) lines.push('  renderLcd();');
  if (oledActive && !counterMode) lines.push('  renderOled();');
  lines.push('}');
  lines.push('');

  /* Command handling --------------------------------------------------------- */
  if (commandSet.length > 0) {
    lines.push('bool handleCommand(char command) {');
    lines.push('  switch (command) {');
    /*
     * A command set that already uses `+`, `-` or `?` must not collide with
     * the speed/telemetry built-ins below — two `case` labels for the same
     * character is a compile error, not a runtime one.
     */
    const emitted = new Set<string>();
    for (const entry of commandSet) {
      const character = entry.command.length > 0 ? entry.command.charAt(0) : '?';
      if (character === '?') {
        if (emitted.has('?')) continue;
        emitted.add('?');
        lines.push("    case '?':");
        lines.push('      sendTelemetry(true);');
        lines.push('      break;');
        continue;
      }
      if (emitted.has(character)) continue;
      emitted.add(character);
      const matched = states.find((state) => state.id === entry.meaning.toLowerCase() || state.name.toLowerCase() === entry.meaning.toLowerCase());
      const escaped = character === "'" ? "\\'" : character;
      lines.push(`    case '${escaped}':`);
      if (matched) {
        lines.push(`      applyMovement(${stateEnumName(matched.id)});`);
      }
      lines.push('      lastCommandAt = millis();');
      lines.push(`      controlLink.println("ok:${matched?.id ?? safeIdentifier(entry.meaning).toLowerCase()}");`);
      lines.push('      break;');
    }
    if (!emitted.has('+')) {
      lines.push("    case '+':");
      lines.push('      speedPercent = (uint8_t)constrain((int)speedPercent + 10, 0, 100);');
      lines.push('      applyMovement(currentState);');
      lines.push('      lastCommandAt = millis();');
      lines.push('      controlLink.print("ok:speed=");');
      lines.push('      controlLink.println(speedPercent);');
      lines.push('      break;');
    }
    if (!emitted.has('-')) {
      lines.push("    case '-':");
      lines.push('      speedPercent = (uint8_t)constrain((int)speedPercent - 10, 0, 100);');
      lines.push('      applyMovement(currentState);');
      lines.push('      lastCommandAt = millis();');
      lines.push('      controlLink.print("ok:speed=");');
      lines.push('      controlLink.println(speedPercent);');
      lines.push('      break;');
    }
    lines.push('    default:');
    lines.push('      controlLink.println("err:unknown command");');
    lines.push('      return false;');
    lines.push('  }');
    lines.push('  return true;');
    lines.push('}');
    lines.push('');
  }

  /* setup -------------------------------------------------------------------- */
  lines.push('void setup() {');
  lines.push('  Serial.begin(115200);');
  lines.push('  controlLink.begin(LINK_BAUD);');
  lines.push('');
  lines.push('  // Outputs first, and immediately driven to their safe state.');
  const gpioAssignments = ctx.assignments.filter((entry) => !isBusAssignment(entry));
  for (const assignment of gpioAssignments.filter((entry) => entry.direction === 'output')) {
    lines.push(`  pinMode(${constantName(assignment)}, OUTPUT);`);
  }
  for (const assignment of gpioAssignments.filter((entry) => entry.direction === 'input')) {
    const pullup = !isAnalogAssignment(assignment) && !isSensorOutput(ctx, assignment);
    lines.push(`  pinMode(${constantName(assignment)}, ${pullup ? 'INPUT_PULLUP' : 'INPUT'});`);
  }
  if (channels.length > 0) lines.push('  stopAllMotors();');
  if (ctx.i2cBuses.length > 0 || lcdActive || oledActive) {
    for (const line of i2cBusInitLines({ assignments: ctx.assignments, buses: ctx.i2cBuses, ...(ctx.profile ? { profile: ctx.profile } : {}), linkIdentifier: 'controlLink' })) {
      lines.push(`  ${line}`);
    }
  }
  lines.push('');
  if (servoActive) {
    servos.forEach((selection, selectionIndex) => {
      selection.instances.forEach((instance, instanceIndex) => {
        const signalAssignment = ctx.assignments.find((assignment) => assignment.targetInstanceId === instance.instanceId);
        if (!signalAssignment) return;
        const identifier = `servo${selectionIndex + 1}${instanceIndex + 1}`;
        lines.push(`  ${identifier}.attach(${identifier.toUpperCase()}_PIN);`);
        lines.push(`  ${identifier}.write(90);`);
      });
    });
  }
  if (dhtActive) lines.push('  dhtSensor.begin();');
  if (lcdActive) {
    lines.push('  lcd.init();');
    lines.push('  lcd.backlight();');
  }
  if (oledActive) {
    lines.push('  oledReady = oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS);');
    lines.push('  if (!oledReady) Serial.println("warn: SSD1306 not responding at OLED_ADDRESS");');
    lines.push('  renderOled();');
  }
  if (lcdActive) lines.push('  renderLcd();');
  for (const led of leds) {
    for (const instance of led.instances) {
      const assignment = ctx.assignments.find((entry) => entry.targetInstanceId === instance.instanceId);
      if (assignment) lines.push(`  digitalWrite(${constantName(assignment)}, LOW);`);
    }
  }
  if (relay) {
    for (const instance of relay.instances) {
      const assignment = ctx.assignments.find((entry) => entry.targetInstanceId === instance.instanceId);
      if (assignment) lines.push(`  digitalWrite(${constantName(assignment)}, HIGH); // most relay modules are active-low: HIGH = contacts open`);
    }
  }
  if (usesBluetoothSerial) {
    lines.push('#if defined(ESP32)');
    lines.push(`  controlLink.begin("${(ctx.projectName || 'wireup').replace(/"/g, '').replace(/[^\x20-\x7E]/g, '')}");`);
    lines.push('  Serial.println("Bluetooth Classic ready: pair with the phone and send a command character.");');
    lines.push('#endif');
  }
  if (commandSet.length > 0) {
    lines.push(`  controlLink.println("ready: commands = ${commandSet.map((entry) => entry.command).join(' ')}");`);
  }
  lines.push('  lastCommandAt = millis();');
  lines.push('}');
  lines.push('');

  /* loop --------------------------------------------------------------------- */
  lines.push('void loop() {');
  lines.push('  uint32_t now = millis();');
  lines.push('');
  lines.push('  // 1. Non-blocking command intake.');
  lines.push('  while (controlLink.available() > 0) {');
  lines.push('    char command = (char)controlLink.read();');
  lines.push("    if (command == '\\n' || command == '\\r') continue;");
  if (commandSet.length > 0) lines.push('    handleCommand(command);');
  else lines.push('    (void)command;');
  lines.push('  }');
  lines.push('');
  if (channels.length > 0) {
    const failsafeState = states.find((state) => state.id === 'failsafe') ?? states.find((state) => state.id === 'idle');
    lines.push('  // 2. Failsafe: stop when the link goes quiet.');
    lines.push('  if (REMOTE_CONTROLLED && now - lastCommandAt > FAILSAFE_TIMEOUT_MS) {');
    lines.push(`    if (currentState != ${stateEnumName(failsafeState?.id ?? 'idle')}) {`);
    lines.push(`      applyMovement(${stateEnumName(failsafeState?.id ?? 'idle')});`);
    lines.push('      stopAllMotors();');
    lines.push('      controlLink.println("warn:failsafe - link timeout, motors stopped");');
    lines.push('    }');
    lines.push('    lastCommandAt = now;');
    lines.push('  }');
    lines.push('');
  }
  lines.push('  // 3. Periodic sensing.');
  lines.push('  if (now - lastSensorAt >= SENSOR_INTERVAL_MS) {');
  lines.push('    lastSensorAt = now;');
  if (dhtActive) lines.push('    readEnvironment();');
  if (pirAssignment) {
    lines.push(`    bool motionDetected = digitalRead(${constantName(pirAssignment)}) == HIGH;`);
    if (buzzerAssignment) {
      lines.push(`    digitalWrite(${constantName(buzzerAssignment)}, motionDetected ? HIGH : LOW);`);
    } else {
      lines.push('    (void)motionDetected;');
    }
  }
  if (obstacleGuard) {
    /*
     * Stop the car before it hits the obstacle, not after. Reverse is exempt
     * (nothing ahead of the sensor when backing away from it) and so is a
     * motionless state, so the guard can never fight an operator commanded
     * stop or a retreat.
     */
    const reverseState = states.find((state) => state.id === 'reverse');
    const stopState = states.find((state) => state.id === 'idle' || state.id === 'stop' || state.id === 'failsafe');
    const haltState = stopState ?? states[0];
    const exempt = [reverseState, stopState].filter((state) => state !== undefined);
    const exemptCheck =
      exempt.length > 0
        ? ` && ${exempt.map((state) => `currentState != ${stateEnumName(state.id)}`).join(' && ')}`
        : '';
    lines.push('    // Obstacle guard: halt the drive before the car hits what is ahead.');
    lines.push('    float obstacleDistanceCm = readDistanceCm();');
    lines.push('    if (obstacleDistanceCm > 0 && obstacleDistanceCm < OBSTACLE_STOP_CM' + exemptCheck + ') {');
    lines.push(`      applyMovement(${stateEnumName(haltState?.id ?? 'idle')});`);
    lines.push('      stopAllMotors();');
    lines.push('      controlLink.print("warn:obstacle stopped at ");');
    lines.push('      controlLink.print(obstacleDistanceCm, 1);');
    lines.push('      controlLink.println(" cm");');
    lines.push('    }');
  }
  lines.push('  }');
  lines.push('');
  if (buttonAssignments.length > 0) {
    lines.push('  // 4. Buttons: debounced, one event per press.');
    buttonAssignments.forEach((assignment, buttonIndex) => {
      const id = buttonIdentifier(assignment);
      lines.push(`  if (${id}Pressed()) {`);
      if (counterMode) {
        if (buttonIndex === resetButtonIndex) {
          lines.push('    pressCount = 0;');
          lines.push('    displayDirty = true;');
          lines.push('    Serial.println("count=0");');
        } else {
          lines.push('    pressCount++;');
          lines.push('    displayDirty = true;');
          lines.push('    Serial.print("count=");');
          lines.push('    Serial.println(pressCount);');
        }
        const led = ledAssignments[buttonIndex] ?? ledAssignments[0];
        if (led) {
          lines.push(`    digitalWrite(${constantName(led)}, HIGH); // brief visual acknowledgement`);
          lines.push('    delay(50);');
          lines.push(`    digitalWrite(${constantName(led)}, LOW);`);
        }
      } else {
        const led = ledAssignments[buttonIndex] ?? ledAssignments[0];
        if (led) lines.push(`    digitalWrite(${constantName(led)}, !digitalRead(${constantName(led)})); // toggle on each press`);
        else lines.push(`    Serial.println("${assignment.targetInstanceId} pressed");`);
      }
      lines.push('  }');
    });
    if (counterMode && (oledActive || lcdActive)) {
      lines.push('  if (displayDirty) {');
      lines.push('    displayDirty = false;');
      if (oledActive) lines.push('    renderOled();');
      if (lcdActive) lines.push('    renderLcd();');
      lines.push('  }');
    }
    lines.push('');
  }
  lines.push('  // 5. Telemetry.');
  lines.push('  sendTelemetry(false);');
  lines.push('}');

  return `${lines.join('\n')}\n`;
}

function buttonIdentifier(assignment: PinAssignment): string {
  const raw = safeIdentifier(assignment.targetInstanceId);
  return raw.charAt(0).toLowerCase() + raw.slice(1).replace(/_(\w)/g, (_, char: string) => char.toUpperCase());
}

/** Shared-bus pins (I2C/SPI/UART) are configured by their library, not by pinMode(). */
function isBusAssignment(assignment: PinAssignment): boolean {
  return assignment.protocol === 'i2c' || assignment.protocol === 'spi' || assignment.protocol === 'uart';
}

/** A sensor/module output must be read without a pull-up (it is actively driven). */
function isSensorOutput(ctx: SketchContext, assignment: PinAssignment): boolean {
  const selection = ctx.selections.find((candidate) => candidate.instances.some((instance) => instance.instanceId === assignment.targetInstanceId));
  return selection?.category === 'sensor' || selection?.category === 'communication';
}


function constantForPin(assignments: PinAssignment[], pin: string): string | undefined {
  const assignment = assignments.find((entry) => entry.pin === pin);
  return assignment ? constantName(assignment) : undefined;
}

/** Public helper so other modules can produce the same pin block. */
export function buildFirmwareHeader(projectName: string, revision: number, notes: string[]): string {
  return [`// ${projectName}`, `// Wireup revision ${revision}`, ...notes.map((note) => `// ${note}`)].join('\n');
}
