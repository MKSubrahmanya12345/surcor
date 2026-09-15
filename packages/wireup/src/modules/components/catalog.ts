/**
 * The bundled component catalog.
 *
 * This is the seed for the MongoDB `components` collection and the offline
 * fallback when the database is unavailable. Extend the catalog by adding an
 * entry to a seed file (or by inserting into MongoDB directly) — the planner,
 * pin planner, wiring planner and diagram generator all read from the same
 * service, so new parts become available everywhere at once.
 */

import type { ComponentDefinition } from '@/types/component';

import { ACTUATORS } from './seed/actuators';
import { COMMUNICATION } from './seed/communication';
import { DISCRETE } from './seed/discrete';
import { DISPLAYS } from './seed/displays';
import { GENERAL } from './seed/general';
import { MICROCONTROLLERS } from './seed/microcontrollers';
import { MOTION } from './seed/motion';
import { MOTORS } from './seed/motors';
import { POWER } from './seed/power';
import { SBC } from './seed/sbc';
import { SENSORS } from './seed/sensors';

export const SEED_COMPONENTS: ComponentDefinition[] = [
  ...MICROCONTROLLERS,
  ...SBC,
  ...MOTORS,
  ...MOTION,
  ...SENSORS,
  ...COMMUNICATION,
  ...ACTUATORS,
  ...POWER,
  ...GENERAL,
  ...DISPLAYS,
  ...DISCRETE,
];

export function getSeedComponent(id: string): ComponentDefinition | undefined {
  return SEED_COMPONENTS.find((component) => component.id === id);
}

export function listSeedIds(): string[] {
  return SEED_COMPONENTS.map((component) => component.id);
}

export interface CatalogIntegrityReport {
  ok: boolean;
  problems: string[];
  total: number;
}

/** Structural sanity check used by the seed script and at startup. */
export function checkCatalogIntegrity(components: ComponentDefinition[] = SEED_COMPONENTS): CatalogIntegrityReport {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const component of components) {
    if (!component.id) problems.push('component with empty id');
    if (seen.has(component.id)) problems.push(`duplicate component id: ${component.id}`);
    seen.add(component.id);

    if (!component.name) problems.push(`${component.id}: missing name`);
    if (!component.description) problems.push(`${component.id}: missing description`);

    const pinNames = new Set<string>();
    for (const componentPin of component.pins) {
      if (!componentPin.name) problems.push(`${component.id}: pin without a name`);
      if (pinNames.has(componentPin.name)) problems.push(`${component.id}: duplicate pin name ${componentPin.name}`);
      pinNames.add(componentPin.name);
    }

    const hasPower = component.powerPins.length > 0;
    const hasGround = component.groundPins.length > 0;
    const isStructural = component.metadata.electrical === false || component.metadata.integrated === true;
    /*
     * Two-terminal series elements (resistor, diode, DC motor, tactile switch)
     * and passive matrices (a membrane keypad) carry current but have no supply
     * rail of their own — they are wired *into* someone else's circuit. They
     * declare `noSupplyPins: true` so this check does not reject a catalog that
     * is actually correct. Without that escape hatch `pnpm seed` refuses to run
     * on a clean checkout and databases stay stuck on whatever was seeded last.
     */
    const isSupplyless = component.metadata.noSupplyPins === true;

    if (!isStructural && !isSupplyless && component.pins.length > 0) {
      if (!hasPower && !hasGround) {
        problems.push(`${component.id}: electrical component with no power or ground pin declared`);
      }
    }
  }

  return { ok: problems.length === 0, problems, total: components.length };
}
