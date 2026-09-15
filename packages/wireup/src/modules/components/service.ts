/**
 * Component database service.
 *
 * Single entry point for catalog access, matching model output back onto real
 * parts, and retrieving the relevant slice of the database for a prompt.
 */

import type { ComponentDefinition } from '@/types/component';
import type { ProjectRequirements } from '@/types/project';

import { createLogger } from '@/lib/logging/logger';
import { tryListComponents, upsertComponents } from '@/lib/mongodb/components';
import { env } from '@/lib/validation/env';
import { nowIso } from '@/lib/validation/time';

import { SEED_COMPONENTS } from './catalog';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';
import { getMcuProfile } from '@/modules/pin-planner/mcu-profiles';

const logger = createLogger('components:service');

export interface CatalogState {
  components: ComponentDefinition[];
  source: 'mongodb' | 'seed' | 'mongodb+seed';
  loadedAt: string;
  error?: string;
}

interface CatalogCache {
  state: CatalogState | null;
  expiresAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __wireupCatalog: CatalogCache | undefined;
}

const cache: CatalogCache = globalThis.__wireupCatalog ?? { state: null, expiresAt: 0 };
globalThis.__wireupCatalog = cache;

const CATALOG_TTL_MS = 5 * 60_000;

export function invalidateCatalogCache(): void {
  cache.state = null;
  cache.expiresAt = 0;
}

/**
 * Load the catalog. MongoDB is authoritative; when it is unreachable or empty
 * the bundled seed is used so generation never dead-ends.
 */
/**
 * Merge persisted catalog data with the bundled registry without allowing a
 * stale database row to erase a newer catalog capability.
 *
 * MongoDB may contain an older copy of a part (for example, a capacitor row
 * without its simulator mapping, or a database seeded before a new board was
 * added). Returning that partial row as authoritative makes downstream stages
 * behave as if the part did not exist. The bundled definition is the canonical
 * baseline; persisted values may refine it, but empty structural fields and
 * missing simulator metadata are hydrated from the baseline.
 */
function reconcileCatalog(persisted: ComponentDefinition[]): {
  components: ComponentDefinition[];
  changed: ComponentDefinition[];
} {
  const persistedById = new Map(persisted.map((component) => [component.id, component]));
  const components: ComponentDefinition[] = [];
  const changed: ComponentDefinition[] = [];

  const merge = (seed: ComponentDefinition, current: ComponentDefinition): ComponentDefinition => {
    const merged: ComponentDefinition = {
      ...seed,
      ...current,
      name: current.name || seed.name,
      description: current.description || seed.description,
      voltage: current.voltage ?? seed.voltage,
      minVoltage: current.minVoltage ?? seed.minVoltage,
      maxVoltage: current.maxVoltage ?? seed.maxVoltage,
      currentRequirements: current.currentRequirements ?? seed.currentRequirements,
      pins: current.pins.length > 0 ? current.pins : seed.pins,
      pinTypes: current.pinTypes.length > 0 ? current.pinTypes : seed.pinTypes,
      communicationProtocols: current.communicationProtocols.length > 0 ? current.communicationProtocols : seed.communicationProtocols,
      powerPins: current.powerPins.length > 0 ? current.powerPins : seed.powerPins,
      groundPins: current.groundPins.length > 0 ? current.groundPins : seed.groundPins,
      motorRequirements: current.motorRequirements ?? seed.motorRequirements,
      powerSourceRequirements: current.powerSourceRequirements ?? seed.powerSourceRequirements,
      libraryRequirements: current.libraryRequirements?.length ? current.libraryRequirements : seed.libraryRequirements,
      exampleUsage: current.exampleUsage?.length ? current.exampleUsage : seed.exampleUsage,
      aliases: current.aliases && current.aliases.length > 0 ? current.aliases : seed.aliases,
      keywords: current.keywords && current.keywords.length > 0 ? current.keywords : seed.keywords,
      simulator: current.simulator
        ? {
            ...seed.simulator,
            ...current.simulator,
            attrs: { ...(seed.simulator?.attrs ?? {}), ...(current.simulator.attrs ?? {}) },
          }
        : seed.simulator,
      metadata: { ...seed.metadata, ...current.metadata },
    };
    return merged;
  };

  // Preserve catalog order from the persisted store, then append new bundled
  // entries in seed order so UI ordering remains stable between reads.
  for (const current of persisted) {
    const seed = SEED_COMPONENTS.find((component) => component.id === current.id);
    const merged = seed ? merge(seed, current) : current;
    components.push(merged);
    if (seed && JSON.stringify(merged) !== JSON.stringify(current)) changed.push(merged);
  }
  for (const seed of SEED_COMPONENTS) {
    if (persistedById.has(seed.id)) continue;
    components.push(seed);
    changed.push(seed);
  }

  return { components, changed };
}

export async function getCatalog(): Promise<CatalogState> {
  if (cache.state && Date.now() < cache.expiresAt) return cache.state;

  const result = await tryListComponents();
  let components = result.components;
  let source: CatalogState['source'] = 'mongodb';
  let error: string | undefined = result.error;

  if (components.length === 0) {
    if (!error && env().agent.autoseedComponents) {
      try {
        const upsert = await upsertComponents(SEED_COMPONENTS);
        logger.info('auto-seeded catalog', { inserted: upsert.inserted, total: upsert.total });
        components = SEED_COMPONENTS;
        source = 'mongodb+seed';
      } catch (seedError) {
        error = seedError instanceof Error ? seedError.message : String(seedError);
        components = SEED_COMPONENTS;
        source = 'seed';
        logger.warn('auto-seed failed, using bundled seed', { error });
      }
    } else {
      components = SEED_COMPONENTS;
      source = 'seed';
    }
  } else {
    const reconciled = reconcileCatalog(components);
    components = reconciled.components;
    if (reconciled.changed.length > 0) {
      source = 'mongodb+seed';
      if (env().agent.autoseedComponents) {
        try {
          const upsert = await upsertComponents(reconciled.changed);
          logger.info('reconciled catalog with bundled registry', { inserted: upsert.inserted, total: upsert.total, changed: reconciled.changed.length });
        } catch (reconcileError) {
          const message = reconcileError instanceof Error ? reconcileError.message : String(reconcileError);
          error = error ? `${error}; catalog reconciliation failed: ${message}` : `catalog reconciliation failed: ${message}`;
          logger.warn('catalog reconciliation failed, serving the reconciled in-memory view', { error: message });
        }
      }
    }
  }

  const state: CatalogState = { components, source, loadedAt: nowIso(), ...(error ? { error } : {}) };
  cache.state = state;
  cache.expiresAt = Date.now() + CATALOG_TTL_MS;
  return state;
}

export function findComponentById(id: string, catalog: ComponentDefinition[]): ComponentDefinition | undefined {
  const needle = id.trim().toLowerCase();
  return catalog.find((component) => component.id.toLowerCase() === needle);
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+.\s-]/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface MatchResult {
  definition: ComponentDefinition;
  score: number;
  via: 'id' | 'alias' | 'name' | 'keyword' | 'fuzzy';
  matchedTerm?: string;
}

/**
 * Map free text (usually a component name produced by the model) onto the
 * nearest real catalog entry. This is what stops invented hardware from
 * entering the project.
 */
/**
 * Whole-token containment.
 *
 * `"unobtainium widget".includes("uno")` is true and meaningless. Both strings
 * are already normalised to space-separated lowercase tokens, so padding with
 * spaces makes containment align to token boundaries.
 */
function containsPhrase(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

export function matchComponent(query: string, catalog: ComponentDefinition[]): MatchResult | undefined {
  const raw = (query ?? '').trim();
  if (!raw) return undefined;
  const needle = normalizeText(raw);

  const byId = catalog.find((component) => normalizeText(component.id) === needle);
  if (byId) return { definition: byId, score: 100, via: 'id' };

  let best: MatchResult | undefined;

  for (const component of catalog) {
    for (const alias of component.aliases ?? []) {
      if (normalizeText(alias) === needle) return { definition: component, score: 95, via: 'alias', matchedTerm: alias };
    }
    if (normalizeText(component.name) === needle) {
      const candidate: MatchResult = { definition: component, score: 92, via: 'name' };
      if (!best || candidate.score > best.score) best = candidate;
      continue;
    }

    let score = 0;
    let matchedTerm: string | undefined;

    /*
     * Substring containment must respect word boundaries.
     *
     * A raw `includes()` matched the alias "uno" inside "unobtainium widget",
     * scoring 80 and confidently returning an Arduino Uno for a part that has
     * nothing to do with one. Any short alias (uno, esc, led, pot) hides inside
     * ordinary words, so containment is only meaningful on whole tokens.
     */
    for (const alias of component.aliases ?? []) {
      const normalisedAlias = normalizeText(alias);
      if (normalisedAlias.length < 2) continue;
      if (containsPhrase(needle, normalisedAlias) || containsPhrase(normalisedAlias, needle)) {
        score = Math.max(score, 80);
        matchedTerm = alias;
      }
    }

    const normalisedName = normalizeText(component.name);
    if (containsPhrase(normalisedName, needle) || containsPhrase(needle, normalisedName)) {
      score = Math.max(score, 75);
      matchedTerm = matchedTerm ?? component.name;
    }

    for (const keyword of component.keywords ?? []) {
      const normalisedKeyword = normalizeText(keyword);
      if (normalisedKeyword.length < 3) continue;
      if (containsPhrase(needle, normalisedKeyword)) {
        score = Math.max(score, 65);
        matchedTerm = matchedTerm ?? keyword;
      }
    }

    /*
     * Token overlap fallback (handles "esp 32 dev board", "l298 driver", …).
     *
     * The haystack must be de-duplicated. A part whose name, id and aliases all
     * repeat the same word ("servo motor sg90", "sg90", "micro servo", "hobby
     * servo", "9g servo") used to count that word once per occurrence, pushing
     * `ratio` far above 1.0 and producing scores above the 100 maximum — 123 for
     * "SG92R micro servo" against the SG90. A vague family word could therefore
     * outrank an exact part match, which is precisely backwards.
     */
    const needleTokens = new Set(needle.split(' ').filter((token) => token.length > 1));
    const haystackTokens = new Set(
      normalizeText(`${component.name} ${component.id} ${(component.aliases ?? []).join(' ')}`)
        .split(' ')
        .filter((token) => token.length > 1),
    );
    const overlap = [...haystackTokens].filter((token) => needleTokens.has(token)).length;
    if (overlap > 0) {
      const ratio = Math.min(1, overlap / Math.max(1, needleTokens.size));
      score = Math.max(score, Math.round(30 + ratio * 35));
      matchedTerm = matchedTerm ?? [...needleTokens].find((token) => haystackTokens.has(token));
    }

    if (score > 0) {
      const candidate: MatchResult = { definition: component, score, via: score >= 60 ? 'keyword' : 'fuzzy', matchedTerm };
      if (!best || candidate.score > best.score) best = candidate;
    }
  }

  return best;
}

/** Accept a match only when it is confident enough to be trusted. */
export function matchComponentStrict(query: string, catalog: ComponentDefinition[], minScore = 55): MatchResult | undefined {
  const match = matchComponent(query, catalog);
  if (!match || match.score < minScore) return undefined;
  return match;
}

/* ------------------------------------------------------------------------- */
/* Retrieval                                                                  */
/* ------------------------------------------------------------------------- */

const CATEGORY_FOR_FEATURE: Record<string, ComponentDefinition['category'][]> = {
  motor: ['motor_driver', 'motor', 'power'],
  motor_control: ['motor_driver', 'motor', 'power'],
  stepper: ['motor_driver', 'motor', 'power'],
  servo: ['motor', 'power'],
  bluetooth: ['communication', 'power'],
  ble: ['communication'],
  wifi: ['communication'],
  wireless: ['communication'],
  sensor: ['sensor', 'passive'],
  sensing: ['sensor', 'passive'],
  temperature: ['sensor'],
  humidity: ['sensor'],
  distance: ['sensor'],
  obstacle: ['sensor'],
  motion: ['sensor'],
  light: ['sensor', 'actuator', 'passive'],
  gas: ['sensor', 'power'],
  display: ['display'],
  led: ['actuator', 'passive'],
  sound: ['actuator'],
  relay: ['actuator', 'power'],
  analog_input: ['input_device', 'passive'],
  user_input: ['input_device', 'passive'],
  power: ['power'],
  battery: ['power'],
};

const ALWAYS_INCLUDED_IDS = [
  'breadboard-830',
  'jumper-wires-kit',
  'resistor-220ohm',
  'resistor-10kohm',
];

const POWER_FALLBACK_IDS = ['battery-2s-lipo', 'battery-holder-4xaa', 'battery-9v', 'regulator-lm7805', 'buck-converter-lm2596'];

export interface RetrievalInput {
  prompt: string;
  requirements?: ProjectRequirements | null;
  features?: string[];
  /** Extra free-text hints (component names mentioned by the model). */
  hints?: string[];
  maxComponents?: number;
}

export interface RetrievalResult {
  components: ComponentDefinition[];
  mcus: ComponentDefinition[];
  profiles: McuProfile[];
  scores: Record<string, number>;
  source: CatalogState['source'];
  notes: string[];
  catalogSize: number;
}

function requirementsBlob(input: RetrievalInput): string {
  const requirements = input.requirements;
  const parts: string[] = [input.prompt];
  if (requirements) {
    parts.push(
      requirements.goal,
      requirements.summary,
      ...requirements.requirements,
      ...requirements.inputs,
      ...requirements.outputs,
      ...requirements.behaviors,
      ...requirements.constraints,
      ...requirements.platformRequirements,
      ...requirements.communicationRequirements,
      ...requirements.powerRequirements,
    );
  }
  if (input.features) parts.push(...input.features);
  if (input.hints) parts.push(...input.hints);
  return normalizeText(parts.filter(Boolean).join(' \n '));
}

function scoreComponent(component: ComponentDefinition, blob: string): number {
  let score = 0;

  for (const alias of component.aliases ?? []) {
    const normalised = normalizeText(alias);
    if (normalised.length >= 2 && blob.includes(normalised)) score += 12;
  }
  for (const keyword of component.keywords ?? []) {
    const normalised = normalizeText(keyword);
    if (normalised.length >= 3 && blob.includes(normalised)) score += 6;
  }
  for (const token of normalizeText(component.name).split(' ')) {
    if (token.length > 2 && blob.includes(token)) score += 3;
  }

  return score;
}

/**
 * Retrieve the slice of the component database that matters for this prompt.
 * Matched parts come first, then engineering essentials (MCUs, power, wiring
 * medium, common passives), then category coverage implied by the features.
 */
export async function retrieveRelevantComponents(input: RetrievalInput): Promise<RetrievalResult> {
  const catalogState = await getCatalog();
  const catalog = catalogState.components;
  const blob = requirementsBlob(input);
  const maxComponents = input.maxComponents ?? 30;
  const notes: string[] = [];

  const scores: Record<string, number> = {};
  for (const component of catalog) {
    scores[component.id] = scoreComponent(component, blob);
  }

  const ordered: ComponentDefinition[] = [];
  const push = (component: ComponentDefinition | undefined) => {
    if (component && !ordered.some((existing) => existing.id === component!.id)) ordered.push(component);
  };

  // 1. Explicit matches, best first.
  const matched = catalog
    .filter((component) => (scores[component.id] ?? 0) > 0)
    .sort((a, b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0));
  for (const component of matched) push(component);

  // 2. Every microcontroller — the planner must be able to compare platforms.
  const mcus = catalog.filter((component) => component.category === 'microcontroller');
  for (const component of mcus) push(component);

  // 3. Feature-implied categories.
  const features = new Set<string>((input.features ?? []).map((feature) => feature.toLowerCase()));
  for (const feature of features) {
    const categories = CATEGORY_FOR_FEATURE[feature];
    if (!categories) continue;
    for (const category of categories) {
      const candidates = catalog.filter((component) => component.category === category);
      for (const component of candidates.slice(0, 6)) push(component);
    }
  }

  // 4. Engineering essentials that are easy to forget but always needed.
  for (const id of ALWAYS_INCLUDED_IDS) push(catalog.find((component) => component.id === id));

  const needsMotorPower =
    features.has('motor') || features.has('motor_control') || matched.some((component) => component.category === 'motor');
  const powerIds = needsMotorPower
    ? ['battery-2s-lipo', 'battery-holder-4xaa', 'battery-9v', 'buck-converter-lm2596', 'regulator-lm7805', 'logic-level-shifter-4ch', 'capacitor-1000uf-electrolytic']
    : POWER_FALLBACK_IDS;
  for (const id of powerIds) push(catalog.find((component) => component.id === id));

  // 5. Trim, but never drop an explicitly matched part.
  let selected = ordered;
  if (ordered.length > maxComponents) {
    const matchedIds = new Set(matched.map((component) => component.id));
    const keepMatched = ordered.filter((component) => matchedIds.has(component.id));
    const keepOthers = ordered.filter((component) => !matchedIds.has(component.id));
    selected = [...keepMatched, ...keepOthers].slice(0, maxComponents);
    notes.push(
      `Catalog holds ${catalog.length} parts; ${selected.length} were sent to the model (${ordered.length - selected.length} low-relevance parts omitted).`,
    );
  }

  const selectedMcus = selected.filter((component) => component.category === 'microcontroller');
  const profiles = selectedMcus
    .map((component) => getMcuProfile(component.id))
    .filter((profile): profile is McuProfile => profile !== undefined);

  if (catalogState.error) notes.push(`Component database warning: ${catalogState.error}`);
  if (catalogState.source !== 'mongodb') {
    notes.push(`Component catalog served from ${catalogState.source} (MongoDB catalog unavailable or empty).`);
  }

  return {
    components: selected,
    mcus: selectedMcus,
    profiles,
    scores,
    source: catalogState.source,
    notes,
    catalogSize: catalog.length,
  };
}

/** Profiles for the MCUs actually selected in a plan. */
export function profilesForSelections(componentIds: string[], catalog: ComponentDefinition[]): McuProfile[] {
  const profiles: McuProfile[] = [];
  for (const id of componentIds) {
    const component = findComponentById(id, catalog);
    if (!component || component.category !== 'microcontroller') continue;
    const profile = getMcuProfile(component.id);
    if (profile && !profiles.some((existing) => existing.componentId === profile.componentId)) profiles.push(profile);
  }
  return profiles;
}
