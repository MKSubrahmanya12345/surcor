/**
 * Library generator — produces `libraries.json`.
 *
 * Library resolution is deterministic: it comes from the catalog entries of the
 * selected components plus whatever the software plan needs (bus drivers,
 * emulated serial, radio stacks). The model can add to the list, never replace it.
 */

import type { ComponentDefinition, ComponentSelection, LibraryRequirement } from '@/types/component';
import type { LibrariesArtifact, SoftwarePlan } from '@/types/project';
import type { AgentEventLog } from '@/lib/logging/events';
import { nowIso } from '@/lib/validation/time';

export interface LibrariesGeneratorInput {
  softwarePlan: SoftwarePlan;
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  controllerComponentId?: string;
  events?: AgentEventLog;
}

function coreFor(controllerComponentId: string | undefined): { core: string; command: string; note: string } | null {
  if (!controllerComponentId) return null;
  if (/esp32/i.test(controllerComponentId)) {
    return {
      core: 'esp32:esp32',
      command: 'arduino-cli core install esp32:esp32',
      note: 'Install the ESP32 board package, then select "ESP32 Dev Module" under Tools → Board.',
    };
  }
  if (/arduino-(uno|nano)/i.test(controllerComponentId)) {
    return {
      core: 'arduino:avr',
      command: 'arduino-cli core install arduino:avr',
      note: 'The AVR core ships with the Arduino IDE; select "Arduino Uno" or "Arduino Nano" under Tools → Board.',
    };
  }
  return null;
}

export function generateLibraries(input: LibrariesGeneratorInput): LibrariesArtifact {
  const handle = input.events?.start('libraries_generation_started', 'Resolving firmware libraries...', { stage: 'libraries' });

  const libraries: LibraryRequirement[] = [];
  const seen = new Set<string>();

  const add = (library: LibraryRequirement) => {
    const key = `${library.name.toLowerCase()}|${library.import.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    libraries.push(library);
  };

  // Catalog requirements first: they are ground truth for the selected parts.
  for (const selection of input.selections) {
    const definition = input.catalog.find((component) => component.id === selection.componentId);
    for (const library of definition?.libraryRequirements ?? []) add(library);
  }

  // Then whatever the software plan resolved (includes model additions).
  for (const library of input.softwarePlan.libraries) add(library);

  const installCommands: string[] = [];
  const notes: string[] = [];

  const core = coreFor(input.controllerComponentId);
  if (core) {
    installCommands.push(core.command);
    notes.push(core.note);
  }

  const external = libraries.filter((library) => library.builtIn !== true);
  for (const library of external) {
    if (library.manager === 'arduino' || library.manager === undefined) {
      installCommands.push(`arduino-cli lib install "${library.name}"`);
    } else if (library.manager === 'platformio') {
      installCommands.push(`pio pkg install --library "${library.name}"`);
    } else if (library.manager === 'pip') {
      installCommands.push(`pip install ${library.name}`);
    } else {
      notes.push(`${library.name} must be installed manually${library.repository ? ` from ${library.repository}` : ''}.`);
    }
  }

  const builtIn = libraries.filter((library) => library.builtIn === true);
  if (builtIn.length > 0) {
    notes.push(`Provided by the platform core, no install needed: ${builtIn.map((library) => library.import).join(', ')}.`);
  }

  // Only the Adafruit *sensor* drivers depend on the Unified Sensor layer; the
  // SSD1306/GFX display stack does not, and including it there is dead weight.
  const adafruitDeps = libraries.some((library) => /Adafruit_(MPU6050|BME280|BMP280|DHT)/i.test(library.import) || /^DHT\.h$/i.test(library.import));
  if (adafruitDeps && !libraries.some((library) => /Adafruit_Sensor\.h/i.test(library.import))) {
    const dependency: LibraryRequirement = {
      name: 'Adafruit Unified Sensor',
      import: 'Adafruit_Sensor.h',
      manager: 'arduino',
      repository: 'https://github.com/adafruit/Adafruit_Sensor',
      purpose: 'Common dependency required by Adafruit sensor drivers',
    };
    add(dependency);
    installCommands.push(`arduino-cli lib install "${dependency.name}"`);
    notes.push('Adafruit Unified Sensor was added automatically because an Adafruit driver is in use.');
  }

  if (libraries.some((library) => /Adafruit_GFX|Adafruit_SSD1306/i.test(library.import)) && !libraries.some((library) => /Adafruit_GFX\.h/i.test(library.import))) {
    const gfx: LibraryRequirement = {
      name: 'Adafruit GFX Library',
      import: 'Adafruit_GFX.h',
      manager: 'arduino',
      repository: 'https://github.com/adafruit/Adafruit-GFX-Library',
      purpose: 'Graphics primitives required by display drivers',
    };
    add(gfx);
    installCommands.push(`arduino-cli lib install "${gfx.name}"`);
  }

  const artifact: LibrariesArtifact = {
    libraries,
    installCommands: [...new Set(installCommands)],
    notes: [...new Set(notes)],
    generatedAt: nowIso(),
  };

  handle?.complete(`Libraries resolved — ${libraries.length} librar${libraries.length === 1 ? 'y' : 'ies'} (${external.length} to install)`, {
    libraries: libraries.length,
    toInstall: external.length,
    builtIn: builtIn.length,
  });

  return artifact;
}
