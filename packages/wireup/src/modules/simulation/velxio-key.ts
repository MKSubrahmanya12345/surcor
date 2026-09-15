/**
 * Velxio key allocation — which id a Wireup catalog part occupies in the
 * simulator, and which parts the emulator simply does not have.
 *
 * This module is deliberately dependency-free (types + tables only) because
 * BOTH sides of the projection need it:
 *
 *   • `wokwi.ts` (the `diagram.json` adapter) marks every catalog part it
 *     cannot hand to a real emulator element as a CAD-only part;
 *   • `velxio-project.ts` (the `.vlx` generator) places those parts as
 *     `cad-bench-<catalogId>` instances;
 *   • `scripts/export-cad-catalog-to-velxio.ts` writes `/cad-catalog.json`
 *     under the same keys, and `pnpm verify:cad-sim-link` proves all three
 *     agree. If the rule lived in any one of them, the others could drift.
 */

import type { ComponentDefinition } from '@/types/component';
import type { DiagramComponent } from '@/types/diagram';

/**
 * CAD bench parts.
 *
 * The registry holds ~108 parts; Velxio ships a verified element for about
 * half. The rest used to be dropped from the emitted project entirely, which
 * meant a build whose point was the pump arrived on the canvas as a board with
 * two sensors — the user could not see, place or wire half of their design.
 *
 * A part with no emulator element is not an unknown, though: Wireup's CAD
 * layer already models EVERY catalog part (real dimensions, real mm pin
 * anchors — `scripts/export-cad-catalog-to-velxio.ts` ships them to
 * `/cad-catalog.json`). So the honest move is to place them as what they are:
 * a physical part holding its place on the bench, wired to the board, whose
 * shape is exact and whose electronics are not simulated.
 *
 * Conventions (all machine-checked by `pnpm verify:cad-sim-link`):
 *   • metadataId  = `cad-bench-<catalogId>` — the prefix is how the canvas
 *     element and the 3D scene recognise the tier (the 3D scene strips it to
 *     find the CAD asset key; the registry maps it to
 *     `<velxio-cad-bench-part>`);
 *   • properties.cadKey = `<catalogId>` — the key into /cad-catalog.json;
 *   • the catalog key for such a part IS its catalog id (verified disjoint
 *     from the simulator's own key space).
 */
export const CAD_BENCH_PREFIX = 'cad-bench-';

/** metadataId for a CAD bench part. */
export function cadBenchId(catalogId: string): string {
  return `${CAD_BENCH_PREFIX}${catalogId}`;
}

/** The catalog id behind a CAD bench metadataId, or null. */
export function cadBenchCatalogId(metadataId: string): string | null {
  return metadataId.startsWith(CAD_BENCH_PREFIX) ? metadataId.slice(CAD_BENCH_PREFIX.length) : null;
}

/**
 * Is this diagram component a CAD bench part?
 *
 * Single source of truth, shared by the exporter (which places it) and the
 * canvas reverse sync (which folds canvas edits back). The two MUST agree:
 * if the exporter places a part the sync does not consider canvas-managed,
 * every sync duplicates its wires; the inverse loses them.
 *
 * The rule mirrors `wokwi.ts`'s inclusion test — a part is projectable as a
 * SIMULATED part only when the catalog maps it to a verified simulator part
 * AND does not mark it unsupported. Everything else that is a real electrical
 * part (not the controller, not a wiring medium) is CAD-bench material.
 */
export function isCadBenchComponent(
  component: Pick<DiagramComponent, 'category'> & Partial<Pick<DiagramComponent, 'simulator' | 'metadata'>>,
): boolean {
  if (component.category === 'microcontroller') return false;
  if (component.metadata?.electrical === false) return false;
  // A capability that lives inside another part and consumable wiring medium
  // are not objects on the bench at all (same exclusions as the exporter).
  if (component.metadata?.integrated === true) return false;
  if (component.metadata?.participatesInWiring === false) return false;
  const part = component.simulator?.part;
  if (part && component.simulator?.supported !== false && METADATA_BY_WOKWI_TYPE[part]) return false;
  return true;
}

/** A catalog part's place in Velxio's key space. `null` = it is not an object on the bench. */
export interface VelxioCatalogKey {
  key: string;
  kind: 'board' | 'part';
  /** True when the emulator has no element for it (carried as CAD geometry only). */
  cadOnly: boolean;
  /**
   * False for a part that exists physically but is outside the electrical
   * graph (a propeller): geometry ships for the picker and the 3D scene, but
   * no project is injected with it.
   */
  canvasPlaced: boolean;
}

/**
 * THE key allocation for a catalog part, shared by `export:cad-catalog` (which
 * writes `/cad-catalog.json`), `generateVelxioProject()` (which emits the
 * metadataId) and `pnpm verify:cad-sim-link` (which proves all three agree).
 * Any second implementation of this rule is a drift bug waiting to happen.
 */
export function velxioCatalogKeyFor(component: ComponentDefinition): VelxioCatalogKey | null {
  const wokwiPart = component.simulator?.part;
  if (component.category === 'microcontroller') {
    // A board is keyed by the CPU core that has to emulate it. An unlisted
    // board is reported, never substituted — hence null.
    const key =
      (wokwiPart ? BOARD_KIND_BY_WOKWI_TYPE[wokwiPart] : undefined) ?? BOARD_KIND_BY_CATALOG_ID[component.id];
    return key ? { key, kind: 'board', cadOnly: false, canvasPlaced: true } : null;
  }
  if (component.metadata?.integrated === true) return null;
  if (component.metadata?.participatesInWiring === false) return null;

  const simulated =
    wokwiPart && component.simulator?.supported !== false ? METADATA_BY_WOKWI_TYPE[wokwiPart] : undefined;
  if (simulated) return { key: simulated, kind: 'part', cadOnly: false, canvasPlaced: true };

  // No emulator element — the part still physically exists. Key it by its own
  // catalog id so the canvas AND the 3D scene find its geometry; it can be
  // placed on the bench only if it can take part in a circuit.
  return {
    key: component.id,
    kind: 'part',
    cadOnly: true,
    canvasPlaced: component.metadata?.electrical !== false,
  };
}

/**
 * Wokwi board part type → Velxio `boardKind` (this picks which CPU core
 * emulates the sketch). Only boards present in Velxio's `BoardKind` union are
 * listed; an unlisted board falls back to `arduino-uno` ONLY if it is an AVR
 * part, otherwise the caller is told the board is unsupported.
 */
export const BOARD_KIND_BY_WOKWI_TYPE: Record<string, string> = {
  'wokwi-esp32-devkit-v1': 'esp32',
  'wokwi-esp32-devkit-c-v4': 'esp32-devkit-c-v4',
  'wokwi-esp32-s3-devkitc-1': 'esp32-s3',
  'wokwi-esp32-c3-devkitm-1': 'esp32-c3',
  'wokwi-arduino-uno': 'arduino-uno',
  'wokwi-arduino-nano': 'arduino-nano',
  'wokwi-arduino-mega': 'arduino-mega',
  'wokwi-pi-pico': 'raspberry-pi-pico',
  'wokwi-pi-pico-w': 'pi-pico-w',
  'wokwi-attiny85': 'attiny85',
};

/**
 * Catalog controller id → Velxio `boardKind`.
 *
 * The table above is keyed by Wokwi *element*, which only exists once the
 * diagram projection has placed the board. When the controller is skipped — no
 * simulator part in the catalog, or `supported: false` — that lookup finds
 * nothing, and the exporter used to open an Arduino Uno regardless of what the
 * user actually designed. The diagram still names the controller (`ref`), so
 * fall back to that before falling back to a guess.
 */
export const BOARD_KIND_BY_CATALOG_ID: Record<string, string> = {
  'esp32-devkit-v1': 'esp32',
  'arduino-uno-r3': 'arduino-uno',
  'arduino-nano': 'arduino-nano',
};

/**
 * Wokwi part type → Velxio component `metadataId`.
 *
 * Velxio's catalog (`external/velxio/frontend/public/components-metadata.json`,
 * 156 parts) is generated from wokwi-elements, so the id is usually the element
 * name without the `wokwi-` prefix — with a few upstream renames (`bme280` →
 * `bmp280`, the L293D module → `motor-driver-l293d`). Anything not listed here
 * has no verified Velxio model and is reported instead of guessed.
 *
 * Every value below is machine-verified by `pnpm verify:simulator` against two
 * ground truths in the vendored repo: the metadata file itself (the id must
 * exist AND its tag must be runtime-definable in the pinned build) and the
 * `PartSimulationRegistry` `register(...)` calls in
 * `frontend/src/simulation/parts/` (which decide whether the part actually
 * *behaves*, not just renders). The catalog `simulator.supported` claims are
 * held to the same standard — a `supported: true` without registered behaviour
 * fails the gate.
 */
export const METADATA_BY_WOKWI_TYPE: Record<string, string> = {
  'wokwi-led': 'led',
  'wokwi-rgb-led': 'rgb-led',
  'wokwi-buzzer': 'buzzer',
  'wokwi-pushbutton': 'pushbutton',
  'wokwi-potentiometer': 'potentiometer',
  'wokwi-resistor': 'resistor',
  'wokwi-capacitor': 'capacitor',
  'wokwi-servo': 'servo',
  'wokwi-stepper-motor': 'stepper-motor',
  'wokwi-dht22': 'dht22',
  'wokwi-hc-sr04': 'hc-sr04',
  'wokwi-pir-motion-sensor': 'pir-motion-sensor',
  'wokwi-photoresistor-sensor': 'photoresistor-sensor',
  'wokwi-ntc-temperature-sensor': 'ntc-temperature-sensor',
  'wokwi-mpu6050': 'mpu6050',
  'wokwi-ssd1306': 'ssd1306',
  'wokwi-lcd1602': 'lcd1602',
  'wokwi-lcd2004': 'lcd2004',
  'wokwi-neopixel': 'neopixel',
  'wokwi-neopixel-matrix': 'neopixel-matrix',
  'wokwi-bme280': 'bmp280',
  'wokwi-bmp280': 'bmp280',
  'wokwi-gas-sensor': 'gas-sensor',
  'wokwi-relay-module': 'relay',
  'wokwi-ks2e-m-dc5': 'ks2e-m-dc5',
  // Deliberately no `wokwi-dc-motor` entry: the pinned Velxio runtime has no
  // registered DC-motor element. The canonical Wireup graph keeps the motor;
  // the projection reports it as unsupported instead of drawing a lookalike.
  'wokwi-membrane-keypad': 'membrane-keypad',
  'wokwi-ir-receiver': 'ir-receiver',
  'wokwi-analog-joystick': 'analog-joystick',
  'wokwi-slide-switch': 'slide-switch',
  'wokwi-slide-potentiometer': 'slide-potentiometer',
  'wokwi-hx711': 'hx711',
  'wokwi-ds1307': 'ds1307',
  'wokwi-a4988': 'a4988',
  'wokwi-microsd-card': 'microsd-card',
  'wokwi-7segment': '7segment',
  'wokwi-led-bar-graph': 'led-bar-graph',
  'wokwi-led-ring': 'led-ring',
  'wokwi-ili9341': 'ili9341',
  'wokwi-breadboard': 'breadboard',
  'wokwi-breadboard-mini': 'breadboard-mini',
  'wokwi-dip-switch-8': 'dip-switch-8',
  'wokwi-tilt-switch': 'tilt-switch',
  'wokwi-ky-040': 'ky-040',
  'wokwi-gps-neo6m': 'gps-neo6m',
  'wokwi-ds3231': 'ds3231',
  // SPICE tier: active semiconductors + the solved power parts.
  'wokwi-diode-1n4007': 'diode-1n4007',
  'wokwi-diode-1n4148': 'diode-1n4148',
  'wokwi-diode-1n5819': 'diode-1n5819',
  'wokwi-bjt-2n2222': 'bjt-2n2222',
  'wokwi-mosfet-2n7000': 'mosfet-2n7000',
  'wokwi-mosfet-irf540': 'mosfet-irf540',
  'wokwi-opto-pc817': 'opto-pc817',
  'wokwi-battery-9v': 'battery-9v',
  'wokwi-reg-7805': 'reg-7805',
  // NOTE deliberately absent: 'wokwi-ds18b20', 'wokwi-l298n'. The pinned
  // Velxio catalog has no model for them, and putting a lookalike on the canvas
  // (an L293D standing in for an L298N, say) would wire the firmware to pins
  // that do not exist on the real part. They stay unsupported.
};

/**
 * Parts whose Velxio model depends on which catalog entry the instance came
 * from, not just on its Wokwi element.
 *
 * Velxio separates a polarised capacitor (`capacitor-electrolytic`, terminals
 * `+` and `\u2212`, and it verifies the polarity against the rail voltage) from a
 * plain one (`capacitor`, terminals `1`/`2`). Both reach the Wokwi projection as
 * `wokwi-capacitor`, so the instance id decides, and the terminals are renamed
 * to the polarised part's own names — Velxio's minus is U+2212, not a hyphen.
 */
const METADATA_REFINEMENTS: {
  matches: RegExp;
  metadataId: string;
  pins?: Record<string, string>;
}[] = [
  { matches: /^capacitor-[\w-]*electrolytic/i, metadataId: 'capacitor-electrolytic', pins: { '1': '+', '2': '\u2212' } },
  // Battery elements name their negative terminal with U+2212 (a true minus),
  // not the hyphen the catalog uses — same treatment as the electrolytic.
  { matches: /^battery-/i, metadataId: '', pins: { '-': '\u2212' } },
];

export function refinePart(partId: string, metadataId: string): { metadataId: string; pins?: Record<string, string> } {
  for (const refinement of METADATA_REFINEMENTS) {
    // Match the mapped METADATA ID first, the instance id second: a hand-made
    // instance id ("bat-1") must not silently skip a pin rename that the part
    // type itself calls for. Both current refinements match either form.
    if (refinement.matches.test(metadataId) || refinement.matches.test(partId)) {
      return {
        metadataId: refinement.metadataId || metadataId,
        ...(refinement.pins ? { pins: refinement.pins } : {}),
      };
    }
  }
  return { metadataId };
}

/**
 * The inverse table, used by the canvas→diagram sync. Kept adjacent on purpose.
 */
export const WOKWI_TYPE_BY_METADATA: Record<string, string> = Object.fromEntries(
  Object.entries(METADATA_BY_WOKWI_TYPE)
    // bmp280/bme280 both map to `bmp280`; the reverse picks the BME280 element,
    // which is the one the Wireup catalog actually ships.
    .filter(([wokwiType]) => wokwiType !== 'wokwi-bmp280')
    .map(([wokwiType, metadataId]) => [metadataId, wokwiType]),
);
