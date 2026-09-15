/**
 * Did the build actually deliver the quantities the brief asked for?
 *
 * `analyzeCoverage` answers a different question — "do the design's words
 * resemble the requirement's words?" — which is why it could be satisfied by
 * prose alone. This module asks the question that actually matters and answers
 * it structurally, by counting parts:
 *
 *   The brief said 3 IR sensors. How many sensors are in the bill of materials?
 *
 * Counting is immune to the failure mode that let a sensor-less line-follower
 * pass: there is no comment, no generated guide and no restated goal that can
 * make zero into three. Either the part is selected or it is not.
 *
 * The buckets map a requirement quantity key (`ir_sensors`, `motors`, …) onto
 * the catalog categories that satisfy it. Each bucket also names the catalog
 * part it would reach for, so the fixer can add the missing hardware instead of
 * only complaining about it.
 */

import type { ComponentCategory, ComponentDefinition, ComponentSelection } from '@/types/component';
import type { ProjectRequirements } from '@/types/project';

export interface QuantityShortfall {
  /** Stable bucket id, e.g. `sensors`. */
  bucket: string;
  /** Human label for the report, e.g. `IR / line sensors`. */
  label: string;
  /** How many the brief asked for. */
  expected: number;
  /** How many the design delivered. */
  delivered: number;
  /** `expected - delivered`. */
  missing: number;
  /** Catalog part that would close the gap, when one can be named confidently. */
  suggestedComponentId?: string;
  /** Name of the suggested part, for the event log. */
  suggestedComponentName?: string;
}

interface Bucket {
  bucket: string;
  label: string;
  /** Requirement quantity keys that all feed this bucket. */
  keys: string[];
  /** True when this selection counts toward the bucket. */
  match: (selection: ComponentSelection, definition: ComponentDefinition | undefined) => boolean;
  /**
   * Catalog ids to prefer when repairing, most specific first, chosen from the
   * detected features. Returning nothing means "no confident part" — the issue
   * is still reported, it just has no deterministic repair.
   */
  prefer?: (features: string[]) => string[];
}

const has = (haystack: string, needle: RegExp): boolean => needle.test(haystack);

/** Category + motor-kind test for the motor family. */
const motorOf =
  (kind: 'dc' | 'stepper' | 'servo') =>
  (_selection: ComponentSelection, definition: ComponentDefinition | undefined): boolean =>
    definition?.category === 'motor' && definition.motorRequirements?.motorType === kind;

/** Category + name/id keyword test, for families the category alone over-counts. */
const named =
  (categories: ComponentCategory[], pattern: RegExp) =>
  (selection: ComponentSelection, definition: ComponentDefinition | undefined): boolean => {
    if (!definition || !categories.includes(definition.category)) return false;
    return has(`${selection.componentId} ${selection.name}`, pattern);
  };

const BUCKETS: Bucket[] = [
  {
    bucket: 'sensors',
    label: 'sensors',
    keys: ['sensors', 'ir_sensors', 'ultrasonic_sensors'],
    match: (_selection, definition) => definition?.category === 'sensor',
    prefer: (features) => {
      if (features.includes('line_following') || features.includes('obstacle_avoidance')) return ['ir-obstacle-sensor'];
      if (features.includes('distance')) return ['hc-sr04-ultrasonic'];
      if (features.includes('temperature_humidity')) return ['dht22-temperature-humidity', 'dht11-temperature-humidity'];
      if (features.includes('soil_moisture')) return ['soil-moisture-sensor'];
      if (features.includes('gas_air_quality')) return ['mq-2-gas-sensor'];
      if (features.includes('light_sensing')) return ['ldr-photoresistor'];
      if (features.includes('motion')) return ['pir-sensor-hc-sr501'];
      if (features.includes('imu')) return ['ina219-current-sensor'];
      return [];
    },
  },
  {
    bucket: 'motors',
    label: 'DC motors',
    keys: ['motors'],
    match: motorOf('dc'),
    prefer: () => ['dc-motor-generic-6v'],
  },
  {
    bucket: 'steppers',
    label: 'stepper motors',
    keys: ['steppers'],
    match: motorOf('stepper'),
    prefer: (features) => (/28byj|uln2003/i.test(features.join(' ')) ? ['stepper-28byj48-uln2003'] : ['stepper-motor-nema17']),
  },
  {
    bucket: 'servos',
    label: 'servos',
    keys: ['servos'],
    match: motorOf('servo'),
    prefer: () => ['servo-motor-sg90'],
  },
  {
    bucket: 'leds',
    label: 'LEDs',
    keys: ['leds'],
    match: named(['actuator', 'discrete'], /led|neopixel|ws2812|rgb/i),
    prefer: () => ['led-5mm'],
  },
  {
    bucket: 'buttons',
    label: 'buttons / switches',
    keys: ['buttons'],
    match: (_selection, definition) => definition?.category === 'input_device',
    prefer: (features) => (features.includes('keypad') ? ['keypad-4x4-membrane'] : ['pushbutton-6mm']),
  },
  {
    bucket: 'cameras',
    label: 'cameras',
    keys: ['cameras'],
    match: named(['sensor', 'other'], /camera|webcam/i),
    prefer: () => ['usb-webcam-generic'],
  },
  {
    bucket: 'bluetooth',
    label: 'Bluetooth modules',
    keys: ['bluetooth_modules'],
    match: named(['communication'], /bluetooth|hc-?0[56]/i),
    prefer: () => ['hc-05-bluetooth'],
  },
];

export interface QuantityDeliveryInput {
  requirements: ProjectRequirements | null;
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
}

/**
 * Compare every quantity the brief stated against what the design selected.
 *
 * Only buckets with a stated quantity are checked, so a brief that never
 * counted anything is left to the other rules.
 */
export function evaluateQuantityDelivery(input: QuantityDeliveryInput): QuantityShortfall[] {
  const { requirements, selections, catalog } = input;
  const quantities = requirements?.quantities ?? {};
  const features = requirements?.features ?? [];
  const shortfalls: QuantityShortfall[] = [];

  for (const bucket of BUCKETS) {
    /* A brief can name the same family two ways ("3 IR sensors" sets both
     * `ir_sensors` and the generic `sensors`); the larger stated count wins so
     * the bucket is never judged against a weaker number. */
    let expected = 0;
    for (const key of bucket.keys) {
      const value = quantities[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > expected) expected = Math.floor(value);
    }
    if (expected <= 0) continue;

    const byId = new Map(catalog.map((definition) => [definition.id, definition]));
    const delivered = selections
      .filter((selection) => bucket.match(selection, byId.get(selection.componentId)))
      .reduce((sum, selection) => sum + Math.max(0, selection.quantity), 0);

    if (delivered >= expected) continue;

    /* Name a repair part only when the brief's own features point at one.
     * Guessing a sensor for a build that never said which kind would add a
     * plausible-looking wrong part, which is worse than admitting the gap. */
    const preferred = bucket.prefer?.(features) ?? [];
    const suggestion = preferred
      .map((id) => byId.get(id))
      .find((definition): definition is ComponentDefinition => definition !== undefined);

    shortfalls.push({
      bucket: bucket.bucket,
      label: bucket.label,
      expected,
      delivered,
      missing: expected - delivered,
      ...(suggestion ? { suggestedComponentId: suggestion.id, suggestedComponentName: suggestion.name } : {}),
    });
  }

  return shortfalls;
}

/**
 * Severity for a shortfall.
 *
 * Being short by more than one of something the brief explicitly counted is a
 * blocking error: a parking sensor asked for four ultrasonic sensors and built
 * one does not do the job, and the fixer should be given the chance to add the
 * rest rather than let the run finish "clean".
 *
 * Being short by exactly one is a warning. That covers the incidental
 * phrasing the quantity extractor still picks up — "press a button to start"
 * parses as one button — where failing the run would be noise rather than
 * signal.
 */
export function shortfallSeverity(shortfall: QuantityShortfall): 'error' | 'warning' {
  return shortfall.missing >= 2 ? 'error' : 'warning';
}
