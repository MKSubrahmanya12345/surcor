/**
 * Serialises catalog entries into compact prompt context.
 *
 * The model must not guess: it receives real pin names, real voltage/current
 * limits and the exact catalog ids it is allowed to use.
 */

import type { ComponentDefinition } from '@/types/component';
import type { McuProfile } from '@/modules/pin-planner/mcu-profiles';

import { formatMcuProfile } from '@/modules/pin-planner/mcu-profiles';

const MAX_PINS_IN_CONTEXT = 24;

function voltageRange(component: ComponentDefinition): string {
  const parts: string[] = [];
  if (component.voltage !== undefined) parts.push(`${component.voltage} V nominal`);
  if (component.minVoltage !== undefined && component.maxVoltage !== undefined) {
    parts.push(`range ${component.minVoltage}–${component.maxVoltage} V`);
  } else if (component.minVoltage !== undefined) {
    parts.push(`min ${component.minVoltage} V`);
  } else if (component.maxVoltage !== undefined) {
    parts.push(`max ${component.maxVoltage} V`);
  }
  return parts.length > 0 ? parts.join(', ') : 'voltage unknown';
}

function currentInfo(component: ComponentDefinition): string {
  const current = component.currentRequirements;
  if (!current) return 'current unknown';
  const parts: string[] = [];
  if (current.typicalMa !== undefined) parts.push(`${current.typicalMa} mA typical`);
  if (current.maxMa !== undefined) parts.push(`${current.maxMa} mA max`);
  if (parts.length === 0) return 'current unknown';
  return parts.join(', ');
}

function pinSummary(component: ComponentDefinition): string {
  const pins = component.pins.slice(0, MAX_PINS_IN_CONTEXT).map((entry) => {
    const bits = [entry.name, entry.type, entry.direction];
    if (entry.required) bits.push('required');
    if (entry.signal) bits.push(entry.signal);
    return bits.filter(Boolean).join(':');
  });
  const suffix = component.pins.length > MAX_PINS_IN_CONTEXT ? `, +${component.pins.length - MAX_PINS_IN_CONTEXT} more` : '';
  return pins.length > 0 ? `${pins.join(' | ')}${suffix}` : 'no physical pins';
}

/** One catalog entry as prompt text. */
export function formatComponentBrief(component: ComponentDefinition): string {
  const lines: string[] = [];
  lines.push(
    `- id: ${component.id}\n  name: ${component.name}\n  category: ${component.category}\n  ${component.description}`,
  );
  lines.push(`  electrical: ${voltageRange(component)}; ${currentInfo(component)}`);
  lines.push(`  pins: ${pinSummary(component)}`);
  if (component.powerPins.length > 0) lines.push(`  powerPins: ${component.powerPins.join(', ')}   groundPins: ${component.groundPins.join(', ')}`);
  if (component.communicationProtocols.length > 0) lines.push(`  protocols: ${component.communicationProtocols.join(', ')}`);
  if (component.motorRequirements) {
    const motor = component.motorRequirements;
    const bits = Object.entries(motor)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('/') : String(value)}`);
    lines.push(`  motor: ${bits.join(', ')}`);
  }
  if (component.powerSourceRequirements) {
    const power = component.powerSourceRequirements;
    const bits = Object.entries(power)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${String(value)}`);
    lines.push(`  supply: ${bits.join(', ')}`);
  }
  if (component.libraryRequirements && component.libraryRequirements.length > 0) {
    lines.push(`  libraries: ${component.libraryRequirements.map((lib) => `${lib.name} (<${lib.import}>${lib.builtIn ? ', built-in' : ''})`).join('; ')}`);
  }
  if (component.incompatibleComponents && component.incompatibleComponents.length > 0) {
    lines.push(`  incompatible-with: ${component.incompatibleComponents.join(', ')}`);
  }
  const metadataNotes = typeof component.metadata.note === 'string' ? component.metadata.note : undefined;
  const incompatibleReason = typeof component.metadata.incompatibleReason === 'string' ? component.metadata.incompatibleReason : undefined;
  const integrated = component.metadata.integrated === true;
  if (integrated) lines.push('  integrated capability: needs NO wiring, NO extra pins, NO physical instance');
  if (metadataNotes) lines.push(`  note: ${metadataNotes}`);
  if (incompatibleReason) lines.push(`  caution: ${incompatibleReason}`);
  if (component.aliases && component.aliases.length > 0) lines.push(`  aliases: ${component.aliases.join(', ')}`);
  return lines.join('\n');
}

/** Full catalog slice handed to the generation/validation calls. */
export function formatCatalogContext(components: ComponentDefinition[]): string {
  if (components.length === 0) return '(catalog is empty)';
  return components.map(formatComponentBrief).join('\n\n');
}

export function formatMcuContext(profiles: McuProfile[]): string {
  if (profiles.length === 0) return '(no MCU capability data available)';
  return profiles.map(formatMcuProfile).join('\n\n');
}

/** Compact catalog listing used for retrieval debugging and the UI. */
export function formatCatalogIndex(components: ComponentDefinition[]): string {
  return components.map((component) => `${component.id} — ${component.name} [${component.category}]`).join('\n');
}
