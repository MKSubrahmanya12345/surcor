/**
 * Compatibility analysis between the selected parts.
 *
 * Checks logic levels, drive current, catalog-declared incompatibilities and
 * whether a mitigating part (driver, regulator, level shifter) is present.
 */

import type { ComponentDefinition, ComponentSelection } from '@/types/component';
import type { CompatibilityCheck } from '@/types/project';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';

import { isElectricallyActive, isPowerSource } from './power';

export interface CompatibilityInput {
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  controller: ComponentSelection | null;
  profile?: McuProfile;
}

export interface CompatibilityResult {
  checks: CompatibilityCheck[];
  risks: string[];
}

function definitionFor(selection: ComponentSelection, catalog: ComponentDefinition[]): ComponentDefinition | undefined {
  return catalog.find((component) => component.id === selection.componentId);
}

/** The logic level a part expects: explicit metadata first, then its supply voltage. */
/** Categories whose nominal `voltage` describes a logic interface rather than a load. */
const LOGIC_CATEGORIES = new Set(['microcontroller', 'sensor', 'display', 'communication', 'motor_driver']);

export function partLogicVoltage(definition: ComponentDefinition): number | undefined {
  const explicit = definition.metadata.logicVoltage;
  if (typeof explicit === 'number') return explicit;
  /*
   * For an LED, buzzer, motor or resistor `voltage` is a forward/operating
   * voltage of a *load*, not a logic threshold — a 2.1 V LED on a 5 V GPIO is
   * exactly what the series resistor is for, not a level-shifting problem.
   */
  if (!LOGIC_CATEGORIES.has(definition.category)) return undefined;
  if (definition.metadata.requiresSeriesResistor === true) return undefined;
  return definition.voltage;
}

/**
 * True when a part's I/O is safe on an MCU of `mcuLogic` volts without a
 * level shifter: it is explicitly 5 V tolerant, its rated supply range reaches
 * the MCU logic voltage (breakout boards with an on-board regulator such as
 * the common SSD1306 OLED modules), or it is a passive switch/input.
 */
export function logicLevelToleratesMcu(definition: ComponentDefinition, mcuLogic: number): boolean {
  const meta = definition.metadata;
  if (meta.fiveVoltTolerant === true || meta.fiveVoltTolerantPins === true) return true;
  if (meta.levelShiftRequiredWith5vMcu === true) return false;
  if (definition.category === 'input_device' && !(definition.communicationProtocols?.length)) return true;
  const maxVoltage = definition.maxVoltage ?? Math.max(...(definition.pins ?? []).map((pin) => pin.maxVoltage ?? 0));
  return typeof maxVoltage === 'number' && Number.isFinite(maxVoltage) && maxVoltage >= mcuLogic - 0.1;
}

/** Switches, buttons and other passive inputs never sink GPIO current. */
export function isPassiveInput(definition: ComponentDefinition): boolean {
  if (definition.category !== 'input_device') return false;
  if (definition.communicationProtocols?.length) return false;
  return (
    definition.metadata.momentary === true ||
    /button|switch|potentiometer|encoder|joystick|keypad/i.test(`${definition.name} ${definition.id}`)
  );
}

function hasMitigation(selections: ComponentSelection[], catalog: ComponentDefinition[], kind: 'driver' | 'level_shifter' | 'regulator'): boolean {
  return selections.some((selection) => {
    const definition = definitionFor(selection, catalog);
    if (!definition) return false;
    if (kind === 'driver') return definition.category === 'motor_driver';
    if (kind === 'level_shifter') return /level\s*shifter|level\s*converter|translator/i.test(definition.name);
    return /regulator|buck|converter/i.test(definition.name) && definition.category === 'power';
  });
}

export function checkCompatibility(input: CompatibilityInput): CompatibilityResult {
  const { selections, catalog, controller, profile } = input;
  const checks: CompatibilityCheck[] = [];
  const risks: string[] = [];

  const controllerDefinition = controller ? definitionFor(controller, catalog) : undefined;
  const mcuLogic = profile?.logicVoltage ?? controllerDefinition?.voltage;

  for (const selection of selections) {
    const definition = definitionFor(selection, catalog);
    if (!definition) continue;
    if (!isElectricallyActive(definition)) continue;
    if (definition.category === 'microcontroller') continue;
    if (isPowerSource(definition)) continue;
    if (!controller) continue;

    const controllerId = controller.componentId;
    const pair = `${definition.id}<->${controllerId}`;

    // 1. Catalog-declared incompatibilities.
    const declaredIncompatible = definition.incompatibleComponents?.includes(controllerId) === true;
    if (declaredIncompatible) {
      const mitigated = hasMitigation(selections, catalog, 'driver');
      checks.push({
        a: definition.id,
        b: controllerId,
        compatible: mitigated,
        reason: mitigated
          ? `${definition.name} is declared incompatible with ${controller.name} directly, but a motor driver is in the bill of materials, so the MCU never drives the load itself.`
          : `${definition.name} is declared incompatible with ${controller.name}: ${String(definition.metadata.incompatibleReason ?? 'the load exceeds the MCU GPIO rating')}. Add a driver between them.`,
      });
      if (!mitigated) risks.push(`${definition.name} must not be driven from ${controller.name} GPIO — add an appropriate driver.`);
      continue;
    }

    // 2. Drive current.
    const maxCurrent = definition.currentRequirements?.maxMa;
    /*
     * A bus-attached IC (I2C / SPI / UART / one-wire) with its own VCC pin draws
     * that current from the supply rail, not from a GPIO. Comparing an SSD1306's
     * 25 mA panel current against the MCU's 12 mA pin limit is a category error
     * — only parts powered *through* the signal line actually sink GPIO current.
     */
    const busAttached = (definition.communicationProtocols ?? []).some((protocol) =>
      ['i2c', 'spi', 'uart', 'one_wire'].includes(String(protocol).toLowerCase()),
    );
    const railFed = (definition.pins ?? []).some((pin) => pin.type === 'power');
    // Any module with its own VCC pin (sensor, display, radio) is rail-fed; the
    // GPIO only sees its logic input, never the module's supply current.
    const moduleWithSupply = railFed && ['sensor', 'display', 'communication', 'input_device'].includes(definition.category);
    const railPoweredIc = (busAttached && railFed) || moduleWithSupply;
    /*
     * A motor driver or discrete switch (MOSFET, BJT) is the buffer stage itself:
     * its rating is what it delivers to or clamps on the load, not what a GPIO
     * sinks into it. Comparing that against the MCU pin limit would outlaw every
     * power switch and flyback diode in the catalog.
     */
    const isDiscreteSwitchOrPassive =
      definition.category === 'discrete' ||
      definition.metadata?.polarity === 'nmos' ||
      definition.metadata?.polarity === 'pmos' ||
      definition.metadata?.noSupplyPins === true ||
      /mosfet|transistor|bjt|diode|rectifier|optocoupler/i.test(definition.name);

    const isDriverStage =
      definition.category === 'motor_driver' ||
      definition.motorRequirements?.requiresDriver === false ||
      isDiscreteSwitchOrPassive;

    const directlyDriven =
      !definition.motorRequirements?.requiresDriver &&
      definition.category !== 'motor' &&
      definition.category !== 'motor_driver' &&
      !isDriverStage &&
      !railPoweredIc &&
      !isDiscreteSwitchOrPassive &&
      !isPassiveInput(definition);
    if (
      maxCurrent !== undefined &&
      profile &&
      directlyDriven &&
      maxCurrent > profile.maxGpioSinkMa &&
      definition.metadata.active !== true &&
      !/relay|module/i.test(definition.name)
    ) {
      checks.push({
        a: definition.id,
        b: controllerId,
        compatible: false,
        reason: `${definition.name} can draw ${maxCurrent} mA, above the ${profile.maxGpioSinkMa} mA absolute GPIO limit of ${controller.name}. Drive it through a transistor, MOSFET or dedicated driver.`,
      });
      risks.push(`${definition.name} exceeds the ${controller.name} GPIO current limit — a driver stage is required.`);
      continue;
    }

    // 3. Logic level.
    const partLogic = partLogicVoltage(definition);
    if (
      mcuLogic !== undefined &&
      partLogic !== undefined &&
      Math.abs(partLogic - mcuLogic) > 0.4 &&
      !(partLogic < mcuLogic && logicLevelToleratesMcu(definition, mcuLogic))
    ) {
      const shifterPresent = hasMitigation(selections, catalog, 'level_shifter');
      const tolerant = definition.metadata.fiveVoltTolerantPins === true;
      const dividerHint = definition.metadata.levelShiftRequiredWith5vMcu === true || definition.metadata.levelShiftFrom3v3 === true;
      const compatible = shifterPresent || tolerant || partLogic > mcuLogic;

      checks.push({
        a: definition.id,
        b: controllerId,
        compatible,
        reason:
          partLogic > mcuLogic
            ? `${definition.name} runs at ${partLogic} V logic while ${controller.name} uses ${mcuLogic} V. Its outputs into the MCU need a divider or level shifter${shifterPresent ? ' — one is in the bill of materials' : ''}.`
            : `${definition.name} expects ${partLogic} V logic but ${controller.name} drives ${mcuLogic} V${
                shifterPresent ? '; a level shifter is included.' : '. Add a level shifter or series divider on the MCU-driven line.'
              }`,
      });

      if (!compatible) {
        risks.push(`Logic level mismatch between ${definition.name} (${partLogic} V) and ${controller.name} (${mcuLogic} V) — add level shifting.`);
      } else if (dividerHint && !shifterPresent) {
        risks.push(`${definition.name} on ${controller.name}: verify the interface voltage on shared lines even though the supply range overlaps.`);
      }
      continue;
    }

    // 4. Protocol availability.
    const protocols = definition.communicationProtocols ?? [];
    if (protocols.includes('i2c') && profile) {
      checks.push({
        a: definition.id,
        b: controllerId,
        compatible: true,
        reason: `I2C device on ${controller.name}: connect SDA to ${profile.i2c.sda} and SCL to ${profile.i2c.scl}. Share the bus with other I2C devices using distinct addresses.`,
      });
      continue;
    }
    if (protocols.includes('uart') && profile) {
      const freeUart = profile.uarts.find((uart) => uart.recommended);
      checks.push({
        a: definition.id,
        b: controllerId,
        compatible: true,
        reason: freeUart
          ? `UART device on ${controller.name}: use ${freeUart.id} (TX=${freeUart.tx}, RX=${freeUart.rx}) and cross-connect TX to RX.`
          : `UART device on ${controller.name}: the only hardware UART is shared with the USB serial bridge — use a software/emulated UART or remap pins.`,
      });
      continue;
    }

    checks.push({
      a: definition.id,
      b: controllerId,
      compatible: true,
      reason: `${definition.name} interfaces with ${controller.name} over standard ${protocols.length > 0 ? protocols.join('/') : 'GPIO'} lines at compatible levels.`,
    });
    void pair;
  }

  // 5. Part-to-part incompatibilities declared in the catalog.
  for (const left of selections) {
    const leftDefinition = definitionFor(left, catalog);
    if (!leftDefinition?.incompatibleComponents) continue;
    for (const right of selections) {
      if (right.componentId === left.componentId) continue;
      if (!leftDefinition.incompatibleComponents.includes(right.componentId)) continue;
      const mitigated = hasMitigation(selections, catalog, 'driver');
      checks.push({
        a: leftDefinition.id,
        b: right.componentId,
        compatible: mitigated,
        reason: mitigated
          ? `${leftDefinition.name} and ${right.name} are declared incompatible when directly connected; the driver in the bill of materials isolates them.`
          : `${leftDefinition.name} must not be connected directly to ${right.name}: ${String(leftDefinition.metadata.incompatibleReason ?? 'electrical ratings conflict')}.`,
      });
    }
  }

  if (!controller) {
    risks.push('No microcontroller was selected — the project has nothing to execute the firmware.');
  }

  return { checks, risks: [...new Set(risks)] };
}
