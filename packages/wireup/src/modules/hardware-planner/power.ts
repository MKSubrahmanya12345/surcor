/**
 * Power planning: rail analysis, supply selection and budget adequacy.
 *
 * Everything here is derived from catalog data — no invented numbers. Where a
 * value is unknown it stays unknown and the notes say so.
 */

import type { ComponentDefinition, ComponentSelection, PowerBudget, PowerRail } from '@/types/component';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';

export interface PowerPlanningInput {
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  controller: ComponentSelection | null;
  profile?: McuProfile;
}

/** Components that are electrically inert (breadboard, jumper wires) or integrated (ESP32 radio). */
export function isElectricallyActive(definition: ComponentDefinition | undefined): boolean {
  if (!definition) return false;
  if (definition.metadata.electrical === false) return false;
  if (definition.metadata.integrated === true) return false;
  if (definition.category === 'prototyping') return false;
  return true;
}

export function isPowerSource(definition: ComponentDefinition | undefined): boolean {
  if (!definition) return false;
  return definition.category === 'power' && definition.powerSourceRequirements?.outputVoltage !== undefined;
}

function definitionFor(selection: ComponentSelection, catalog: ComponentDefinition[]): ComponentDefinition | undefined {
  return catalog.find((component) => component.id === selection.componentId);
}

export function selectSupply(
  selections: ComponentSelection[],
  catalog: ComponentDefinition[],
): ComponentSelection | null {
  const sources = selections.filter((selection) => isPowerSource(definitionFor(selection, catalog)));
  if (sources.length === 0) return null;
  if (sources.length === 1) return sources[0] ?? null;

  // Prefer the source that can deliver the most peak current, then the
  // widest voltage range (motor loads need headroom).
  return (
    sources.sort((a, b) => {
      const defA = definitionFor(a, catalog);
      const defB = definitionFor(b, catalog);
      const currentA = defA?.powerSourceRequirements?.maxCurrentMa ?? defA?.currentRequirements?.maxMa ?? 0;
      const currentB = defB?.powerSourceRequirements?.maxCurrentMa ?? defB?.currentRequirements?.maxMa ?? 0;
      if (currentA !== currentB) return currentB - currentA;
      return (defB?.powerSourceRequirements?.outputVoltage ?? 0) - (defA?.powerSourceRequirements?.outputVoltage ?? 0);
    })[0] ?? null
  );
}

interface LoadTotals {
  typicalMa: number;
  peakMa: number;
  loads: string[];
}

function sumLoads(
  selections: ComponentSelection[],
  catalog: ComponentDefinition[],
  filter: (definition: ComponentDefinition, selection: ComponentSelection) => boolean,
  excludeInstanceId?: string,
): LoadTotals {
  let typicalMa = 0;
  let peakMa = 0;
  const loads: string[] = [];

  for (const selection of selections) {
    const definition = definitionFor(selection, catalog);
    if (!definition || !isElectricallyActive(definition)) continue;
    if (!filter(definition, selection)) continue;

    /*
     * A part with no supply rail of its own (a tactile switch, a membrane
     * keypad, a series resistor) does not *draw* from a rail: its catalog
     * current figure is a contact or absolute maximum rating. Summing sixteen
     * 50 mA switch ratings once produced a "1025 mA peak" logic rail and a
     * power-budget error for a build that idles at microamps.
     */
    if (definition.metadata.noSupplyPins === true) continue;

    for (const instance of selection.instances) {
      if (excludeInstanceId && instance.instanceId === excludeInstanceId) continue;
      const typical = definition.currentRequirements?.typicalMa;
      const max = definition.currentRequirements?.maxMa;
      if (typeof typical === 'number') typicalMa += typical;
      if (typeof max === 'number') peakMa += max;
      else if (typeof typical === 'number') peakMa += typical * 2;
      loads.push(`${instance.label ?? instance.name} (${instance.instanceId})`);
    }
  }

  return { typicalMa: Math.round(typicalMa), peakMa: Math.round(peakMa), loads };
}

export function computePowerBudget(input: PowerPlanningInput): PowerBudget {
  const { selections, catalog, controller, profile } = input;
  const notes: string[] = [];

  const supplySelection = selectSupply(selections, catalog);
  const supplyDefinition = supplySelection ? definitionFor(supplySelection, catalog) : undefined;

  /*
   * A dev board (ESP32 DevKit, Arduino Uno, …) carries an on-board regulator
   * fed from USB. When the bill of materials holds no battery or bench supply,
   * that board *is* the supply for the logic rail — reporting "no power source"
   * there is wrong, and it used to raise two blocking validation errors on
   * every USB-powered design.
   */
  const controllerDefinition = controller ? definitionFor(controller, catalog) : undefined;
  const boardIsSupply =
    !supplySelection && controllerDefinition?.category === 'microcontroller' && controllerDefinition.metadata.usbPowered === true;
  const boardNumber = (key: string, fallback: number): number => {
    const raw = controllerDefinition?.metadata[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  };

  const supplyVoltage =
    supplyDefinition?.powerSourceRequirements?.outputVoltage ??
    supplyDefinition?.voltage ??
    (boardIsSupply ? boardNumber('usbVoltage', 5) : undefined);
  const supplyMaxCurrent =
    supplyDefinition?.powerSourceRequirements?.maxCurrentMa ??
    supplyDefinition?.currentRequirements?.maxMa ??
    (boardIsSupply ? boardNumber('usbMaxCurrentMa', 500) : undefined);
  const supplyComponentId = supplySelection?.componentId ?? (boardIsSupply ? controllerDefinition?.id : undefined);
  const supplyInstanceId =
    supplySelection?.instances[0]?.instanceId ?? (boardIsSupply ? controller?.instances[0]?.instanceId : undefined);

  const mcuLogic = profile?.logicVoltage;
  const logicVoltage = mcuLogic;

  const rails: PowerRail[] = [];

  /*
   * Which rail does a load actually sit on? Category alone gets it wrong: an
   * SG90 is a "motor" but it is a 4.8–6 V part, so with a 9 V pack in the bill
   * of materials it belongs on the regulated 5 V rail — which is exactly where
   * the wiring planner puts it. Judging it against the raw supply instead
   * produced a blocking "SG90 accepts at most 6 V but the supply provides 9 V"
   * error on a design that was already correct.
   */
  const windowOf = (definition: ComponentDefinition): { min?: number; max?: number } => ({
    min: definition.motorRequirements?.supplyVoltageMin ?? definition.minVoltage,
    max: definition.motorRequirements?.supplyVoltageMax ?? definition.maxVoltage,
  });
  const belongsOnLogicRail = (definition: ComponentDefinition): boolean => {
    if (mcuLogic === undefined) return false;
    const { min, max } = windowOf(definition);
    if (max === undefined) return false;
    // Comfortable on the raw supply? Then it is a supply-rail load.
    if (supplyVoltage !== undefined && max >= supplyVoltage - 0.5 && (min === undefined || min <= supplyVoltage)) return false;
    /*
     * Does the logic voltage sit inside the part's window (small tolerance for
     * rounded catalog values)? The previous test compared the part's MAX against
     * logic + 0.6, which no 4.8–6 V part can pass at 5 V logic: the SG90 was
     * booked onto the 9 V rail the wiring planner had correctly avoided, and the
     * budget then failed the correct design with "SG90 accepts at most 6 V but
     * the supply provides 9 V".
     */
    return mcuLogic >= (min ?? mcuLogic) - 0.6 && mcuLogic <= max + 0.6;
  };
  const isLoad = (definition: ComponentDefinition): boolean =>
    ['motor', 'motor_driver', 'actuator'].includes(definition.category);

  // Motor / high-current loads that can take the raw supply rail.
  const motorRail = sumLoads(
    selections,
    catalog,
    (definition) => isLoad(definition) && !belongsOnLogicRail(definition),
    supplySelection?.instances[0]?.instanceId,
  );
  // Loads the wiring planner will hang off the regulated logic rail.
  const logicSideLoads = sumLoads(
    selections,
    catalog,
    (definition) => isLoad(definition) && belongsOnLogicRail(definition),
    supplySelection?.instances[0]?.instanceId,
  );
  if (motorRail.loads.length > 0 && supplyVoltage !== undefined) {
    rails.push({
      rail: supplyVoltage >= 6 ? 'VBAT' : 'VSUPPLY',
      voltage: supplyVoltage,
      typicalMa: motorRail.typicalMa,
      peakMa: motorRail.peakMa,
      loads: motorRail.loads,
      ...(supplySelection?.instances[0]?.instanceId ? { sourceInstanceId: supplySelection.instances[0].instanceId } : {}),
    });
  }

  // Logic rail: MCU + sensors + communication + anything that only tolerates logic voltage.
  const logicOnly = sumLoads(
    selections,
    catalog,
    (definition) =>
      ['microcontroller', 'sensor', 'communication', 'display', 'input_device'].includes(definition.category) ||
      belongsOnLogicRail(definition),
    supplySelection?.instances[0]?.instanceId,
  );
  const logicRail: LoadTotals = {
    typicalMa: logicOnly.typicalMa,
    peakMa: logicOnly.peakMa,
    loads: [...new Set([...logicOnly.loads, ...logicSideLoads.loads])],
  };
  if (logicRail.loads.length > 0) {
    rails.push({
      rail: mcuLogic === 3.3 ? '3V3' : '5V',
      voltage: mcuLogic ?? 5,
      typicalMa: logicRail.typicalMa,
      peakMa: logicRail.peakMa,
      loads: logicRail.loads,
      ...(controller?.instances[0]?.instanceId ? { sourceInstanceId: controller.instances[0].instanceId } : {}),
    });
  }

  const totalTypicalMa = rails.reduce((sum, rail) => sum + (rail.typicalMa ?? 0), 0);
  const totalPeakMa = rails.reduce((sum, rail) => sum + (rail.peakMa ?? 0), 0);

  // Regulator / conversion path.
  let regulator: PowerBudget['regulator'];
  const regulatorSelection = selections.find((selection) => {
    const definition = definitionFor(selection, catalog);
    return definition?.category === 'power' && !isPowerSource(definition) && /regulator|buck|converter/i.test(definition.name);
  });
  const driverWithRegulator = selections.find((selection) => {
    const definition = definitionFor(selection, catalog);
    // The controller's own USB regulator is handled by `boardIsSupply` above.
    return definition?.category !== 'microcontroller' && typeof definition?.metadata.onboardRegulator === 'string';
  });

  if (regulatorSelection) {
    const definition = definitionFor(regulatorSelection, catalog);
    regulator = {
      componentId: regulatorSelection.componentId,
      instanceId: regulatorSelection.instances[0]?.instanceId,
      inputVoltage: supplyVoltage,
      outputVoltage: definition?.powerSourceRequirements?.outputVoltage ?? mcuLogic,
    };
    notes.push(
      `${definition?.name ?? regulatorSelection.name} converts ${supplyVoltage ?? '?'} V to the ${regulator.outputVoltage ?? '?'} V logic rail.`,
    );
  } else if (driverWithRegulator) {
    const definition = definitionFor(driverWithRegulator, catalog);
    const threshold = typeof definition?.metadata.regulatorInputThresholdV === 'number' ? definition.metadata.regulatorInputThresholdV : undefined;
    regulator = {
      componentId: driverWithRegulator.componentId,
      instanceId: driverWithRegulator.instances[0]?.instanceId,
      inputVoltage: supplyVoltage,
      outputVoltage: 5,
    };
    notes.push(
      `${definition?.name ?? driverWithRegulator.name} has an on-board ${String(definition?.metadata.onboardRegulator)} regulator that provides 5 V${
        threshold && supplyVoltage !== undefined
          ? supplyVoltage >= threshold
            ? ` (supply ${supplyVoltage} V is above the ${threshold} V threshold, so the regulator is active — remove the 5 V jumper feed)`
            : ` only when the supply exceeds ${threshold} V; at ${supplyVoltage} V you must feed 5 V into the driver logic pin instead`
          : ''
      }.`,
    );
  } else if (!boardIsSupply && supplyVoltage !== undefined && mcuLogic !== undefined && supplyVoltage !== mcuLogic) {
    notes.push(
      `No explicit regulator in the bill of materials: the ${supplyVoltage} V supply must reach the MCU through its VIN/USB input (on-board regulator) or a regulator must be added.`,
    );
  }

  /*
   * Sustained vs transient load. A stalled motor keeps drawing its peak
   * current, so it must be served continuously; an ESP32's ~500 mA is a
   * ~2 ms Wi-Fi TX burst that bulk capacitance absorbs. Judging adequacy on
   * the raw peak made every radio-equipped board "inadequate" on USB.
   */
  const sustainedSupplyMa = sumLoads(
    selections,
    catalog,
    (definition) => isLoad(definition) && !belongsOnLogicRail(definition) && definition.metadata.stallIsTransient !== true,
    supplySelection?.instances[0]?.instanceId,
  ).peakMa;
  const sustainedLogicMa = sumLoads(
    selections,
    catalog,
    (definition) =>
      (['microcontroller', 'sensor', 'communication', 'display', 'input_device'].includes(definition.category) ||
        belongsOnLogicRail(definition)) &&
      definition.metadata.stallIsTransient !== true,
    supplySelection?.instances[0]?.instanceId,
  ).typicalMa;
  const transientStallMa = sumLoads(
    selections,
    catalog,
    (definition) => isLoad(definition) && definition.metadata.stallIsTransient === true,
    supplySelection?.instances[0]?.instanceId,
  ).peakMa;
  const sustainedPeakMa = sustainedSupplyMa + sustainedLogicMa + Math.round(transientStallMa * 0.2);

  // Adequacy analysis.
  let adequate = true;
  const shortfalls: string[] = [];
  if (!supplySelection && !boardIsSupply) {
    adequate = false;
    const reason = 'No power source is present in the bill of materials — the project cannot be powered as designed.';
    shortfalls.push(reason);
    notes.push(reason);
  } else if (boardIsSupply) {
    notes.push(
      `${controllerDefinition?.name ?? 'The controller'} is powered from USB and regulates its own logic rail ` +
        `(${String(controllerDefinition?.metadata.onboardRegulator ?? 'on-board regulator')}, ~${supplyMaxCurrent ?? '?'} mA available) — ` +
        'no external supply is needed for this load.',
    );
  }

  if (supplyMaxCurrent !== undefined && sustainedPeakMa > 0) {
    if (sustainedPeakMa > supplyMaxCurrent) {
      adequate = false;
      const reason = `Sustained load ${sustainedPeakMa} mA exceeds what ${
        supplyDefinition?.name ?? controllerDefinition?.name ?? 'the selected supply'
      } can deliver (${supplyMaxCurrent} mA). Use a higher-current supply or reduce simultaneous loads.`;
      shortfalls.push(reason);
      notes.push(reason);
    } else {
      const margin = Math.round(((supplyMaxCurrent - sustainedPeakMa) / supplyMaxCurrent) * 100);
      notes.push(`Sustained load ${sustainedPeakMa} mA against a ${supplyMaxCurrent} mA supply — ${margin}% headroom.`);
      if (margin < 20) notes.push('Headroom is under 20%: stalls or radio bursts could brown out the logic rail. Add bulk capacitance.');
    }
    if (totalPeakMa > supplyMaxCurrent) {
      notes.push(
        `Transient peak ${totalPeakMa} mA briefly exceeds the ${supplyMaxCurrent} mA supply (radio bursts / motor inrush). ` +
          'That is survivable with bulk capacitance across the supply rail, but keep cables short and do not run every load at once.',
      );
    }
  } else {
    notes.push('Supply current capability is unknown in the catalog — verify it against the measured load before building.');
  }

  // Voltage window checks.
  if (supplyVoltage !== undefined) {
    for (const selection of selections) {
      const definition = definitionFor(selection, catalog);
      if (!definition || !isElectricallyActive(definition)) continue;
      if (isPowerSource(definition)) continue;

      const motor = definition.motorRequirements;
      const min = motor?.supplyVoltageMin ?? definition.minVoltage;
      const max = motor?.supplyVoltageMax ?? definition.maxVoltage;
      const consumesSupplyRail = definition.category === 'motor' || definition.category === 'motor_driver';
      if (!consumesSupplyRail) continue;

      // A part that cannot tolerate the raw supply is fed from the regulated
      // logic rail; check it against THAT rail and say so, instead of failing
      // the whole budget for a wiring choice the planner already made.
      if (belongsOnLogicRail(definition) && mcuLogic !== undefined) {
        if (max !== undefined && mcuLogic > max + 0.001) {
          adequate = false;
          notes.push(`${definition.name} accepts at most ${max} V but the logic rail provides ${mcuLogic} V.`);
        } else {
          notes.push(
            `${definition.name} is a ${min ?? '?'}–${max ?? '?'} V part: feed it from the ${mcuLogic} V logic rail, never from the raw ${supplyVoltage} V supply.`,
          );
        }
        continue;
      }

      if (min !== undefined && supplyVoltage < min) {
        adequate = false;
        notes.push(`${definition.name} needs at least ${min} V but the supply provides ${supplyVoltage} V.`);
      }
      if (max !== undefined && supplyVoltage > max) {
        adequate = false;
        notes.push(`${definition.name} accepts at most ${max} V but the supply provides ${supplyVoltage} V.`);
      }
    }
  }

  const motorSelections = selections.filter((selection) => definitionFor(selection, catalog)?.category === 'motor');
  if (motorSelections.length > 0) {
    const stall = motorSelections.reduce((sum, selection) => {
      const definition = definitionFor(selection, catalog);
      const stallCurrent = definition?.motorRequirements?.stallCurrentMa ?? definition?.currentRequirements?.maxMa ?? 0;
      return sum + stallCurrent * selection.quantity;
    }, 0);
    if (stall > 0) notes.push(`Worst-case simultaneous motor stall current is roughly ${stall} mA; the driver and supply must tolerate it.`);

    /*
     * Name the rail the stall-prone loads are actually fed from. The wiring
     * planner feeds a 4.8–6 V servo from the regulated logic rail even in a
     * battery build, so the stock "across the motor supply" wording pointed the
     * builder at the wrong rail — the exact complaint in the safe-build report.
     */
    const onLogicRail = motorSelections.filter((selection) => {
      const definition = definitionFor(selection, catalog);
      return definition ? belongsOnLogicRail(definition) : false;
    });
    const onSupplyRail = motorSelections.filter((selection) => !onLogicRail.includes(selection));
    const names = (list: typeof motorSelections): string => list.map((selection) => selection.name).join(', ');
    if (onSupplyRail.length === 0 && mcuLogic !== undefined) {
      notes.push(
        `Add a bulk electrolytic capacitor across the ${mcuLogic} V logic rail that feeds ${names(onLogicRail)} — that is where their stall transients flow.`,
      );
    } else if (onLogicRail.length === 0 || supplyVoltage === undefined || mcuLogic === undefined) {
      notes.push('Add a bulk electrolytic capacitor across the supply that feeds the motors to absorb stall transients and reduce brown-outs.');
    } else {
      notes.push(
        `Add bulk electrolytic capacitance on both motor rails: across the ${supplyVoltage} V supply for ${names(onSupplyRail)}, and across the ${mcuLogic} V logic rail for ${names(onLogicRail)}.`,
      );
    }
  }

  /*
   * Linear-regulator dissipation. When the raw supply far exceeds the logic
   * voltage and the logic rail carries real current, the on-board linear
   * regulator burns the difference as heat. The throughput current is used as
   * milliamps on BOTH sides — a linear regulator passes current through, so
   * I_in ≈ I_out; only a switching regulator would need a power-based
   * conversion, and that case is excluded below.
   */
  if (!boardIsSupply && supplyVoltage !== undefined && mcuLogic !== undefined) {
    const dropVoltage = supplyVoltage - mcuLogic;
    const logicRailStallMa = sumLoads(
      selections,
      catalog,
      (definition) => isLoad(definition) && belongsOnLogicRail(definition),
      supplySelection?.instances[0]?.instanceId,
    ).peakMa;
    const regulatorThroughputMa = sustainedLogicMa + Math.round(logicRailStallMa * 0.2);
    const isSwitching =
      Boolean(
        (regulatorSelection && /buck|lm2596|switching/i.test(`${regulatorSelection.componentId} ${definitionFor(regulatorSelection, catalog)?.name ?? ''}`)) ||
          (driverWithRegulator && /buck|lm2596|switching/i.test(`${driverWithRegulator.componentId} ${definitionFor(driverWithRegulator, catalog)?.name ?? ''}`)),
      );
    if (dropVoltage > 3 && regulatorThroughputMa > 0 && (dropVoltage * regulatorThroughputMa) / 1000 >= 0.5 && !isSwitching) {
      const watts = Math.round((dropVoltage * regulatorThroughputMa) / 100) / 10;
      const regulatorName =
        regulatorSelection ? definitionFor(regulatorSelection, catalog)?.name ?? regulatorSelection.name : `${controllerDefinition?.name ?? 'the controller'}'s on-board regulator`;
      notes.push(
        `${regulatorName} drops ${supplyVoltage} V to ${mcuLogic} V linearly: at ~${regulatorThroughputMa} mA on the logic rail that dissipates roughly ${watts} W of continuous heat. ` +
          `Add a buck converter (${supplyVoltage} V → ${mcuLogic} V) or feed the ${mcuLogic} V rail from a separate ${mcuLogic} V source instead of pushing the raw supply through VIN.`,
      );
    }
  }

  if (mcuLogic === 3.3) {
    const fiveVoltLogicParts = selections.filter((selection) => {
      const definition = definitionFor(selection, catalog);
      if (!definition || !isElectricallyActive(definition)) return false;
      if (definition.category === 'microcontroller') return false;
      const partLogic = typeof definition.metadata.logicVoltage === 'number' ? definition.metadata.logicVoltage : definition.voltage;
      const outputsFiveVolts = definition.metadata.echoOutputVoltage === 5 || definition.metadata.outputLogicVoltage === 5;
      return partLogic === 5 || outputsFiveVolts === true;
    });
    if (fiveVoltLogicParts.length > 0) {
      notes.push(
        `3.3 V logic MCU with 5 V interface parts (${fiveVoltLogicParts.map((selection) => selection.name).join(', ')}): level shift or divide any 5 V signal going into the MCU.`,
      );
    }
  }

  if (logicVoltage === undefined) {
    notes.push('No microcontroller profile was available, so logic-rail analysis is limited.');
  }

  return {
    ...(supplyVoltage !== undefined ? { supplyVoltage } : {}),
    ...(supplyInstanceId ? { supplyInstanceId } : {}),
    ...(supplyComponentId ? { supplyComponentId } : {}),
    totalTypicalMa: totalTypicalMa || undefined,
    totalPeakMa: totalPeakMa || undefined,
    sustainedPeakMa: sustainedPeakMa || undefined,
    rails,
    ...(regulator ? { regulator } : {}),
    adequate,
    ...(shortfalls.length > 0 ? { shortfalls } : {}),
    notes,
  };
}
