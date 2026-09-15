/**
 * Instruction generator.
 *
 * Produces the human-facing build documentation (setup, wiring, flashing,
 * usage) from the structured project. Everything is derived from the same data
 * that drives the wiring graph and `diagram.json`, so the instructions cannot
 * drift away from the actual design.
 */

import type { ComponentDefinition, ComponentSelection } from '@/types/component';
import type {
  HardwarePlan,
  InstructionsArtifact,
  LibrariesArtifact,
  ProjectRequirements,
  SoftwarePlan,
} from '@/types/project';
import type { PinAssignment, WiringPlan } from '@/types/wiring';
import type { Diagram } from '@/types/diagram';
import type { AgentEventLog } from '@/lib/logging/events';
import { nowIso } from '@/lib/validation/time';

import { unescapeHtmlEntities } from '@/lib/text/entities';

export interface InstructionsGeneratorInput {
  projectName: string;
  projectSummary: string;
  requirements: ProjectRequirements;
  selections: ComponentSelection[];
  catalog: ComponentDefinition[];
  hardwarePlan: HardwarePlan | null;
  pinAssignments: PinAssignment[];
  wiring: WiringPlan | null;
  softwarePlan: SoftwarePlan | null;
  libraries: LibrariesArtifact | null;
  diagram: Diagram | null;
  controllerName: string;
  controllerComponentId?: string;
  revision: number;
  modelInstructions?: unknown;
  events?: AgentEventLog;
}

interface Section {
  id: string;
  title: string;
  body: string;
  order: number;
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '_Nothing to report._';
  const headerLine = `| ${headers.join(' | ')} |`;
  const separator = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map((cell) => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`).join('\n');
  return [headerLine, separator, body].join('\n');
}

function bulletList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '_None recorded._';
}

/** ASCII wiring tree derived from the connection graph (never hardcoded). */
export function buildWiringTree(wiring: WiringPlan | null, selections: ComponentSelection[]): string {
  if (!wiring || wiring.connections.length === 0) return '_No connections were produced._';

  const labelFor = (instanceId: string): string => {
    for (const selection of selections) {
      const instance = selection.instances.find((candidate) => candidate.instanceId === instanceId);
      if (instance) return instance.label && instance.label !== selection.name ? `${instance.label} (${instanceId})` : instanceId;
    }
    return instanceId;
  };

  const bySource = new Map<string, typeof wiring.connections>();
  for (const connection of wiring.connections) {
    const list = bySource.get(connection.from.instanceId) ?? [];
    list.push(connection);
    bySource.set(connection.from.instanceId, list);
  }

  const lines: string[] = [];
  for (const [sourceId, connections] of bySource) {
    lines.push(`${labelFor(sourceId)}`);
    connections.forEach((connection, index) => {
      const branch = index === connections.length - 1 ? '└──' : '├──';
      const tag = `[${connection.kind}/${connection.signal}]`;
      lines.push(` ${branch} ${connection.from.pin} ──── ${labelFor(connection.to.instanceId)}.${connection.to.pin}  ${tag}`);
    });
    lines.push('');
  }

  return ['```text', ...lines, '```'].join('\n');
}

function extractModelMarkdown(raw: unknown): { markdown?: string; sections: Section[] } {
  if (!raw || typeof raw !== 'object') return { sections: [] };
  const record = raw as Record<string, unknown>;
  /*
   * Model prose arrives HTML-escaped ("temperature &amp; humidity sensor").
   * Decoding it here, once, stops the guide page from showing entities: React
   * escapes again at render time, so nothing becomes raw HTML.
   */
  const markdown = typeof record.markdown === 'string' ? unescapeHtmlEntities(record.markdown) : undefined;
  const rawSections = Array.isArray(record.sections) ? record.sections : [];
  const sections: Section[] = [];

  for (const entry of rawSections) {
    if (!entry || typeof entry !== 'object') continue;
    const sectionRecord = entry as Record<string, unknown>;
    const id = String(sectionRecord.id ?? '').trim();
    const title = unescapeHtmlEntities(String(sectionRecord.title ?? '')).trim();
    const body = unescapeHtmlEntities(String(sectionRecord.body ?? '')).trim();
    if (!id || !title || !body) continue;
    sections.push({ id, title, body, order: typeof sectionRecord.order === 'number' ? sectionRecord.order : sections.length + 1 });
  }

  return { ...(markdown ? { markdown } : {}), sections };
}

export function generateInstructions(input: InstructionsGeneratorInput): InstructionsArtifact {
  const handle = input.events?.start('instructions_generation_started', 'Writing setup and build instructions...', { stage: 'instructions' });

  const sections: Section[] = [];
  const model = extractModelMarkdown(input.modelInstructions);
  const push = (id: string, title: string, body: string) => sections.push({ id, title, body, order: sections.length + 1 });

  /* 1. Overview ------------------------------------------------------------- */
  push(
    'overview',
    'Overview',
    [
      `**${input.projectName}**`,
      '',
      input.projectSummary || input.requirements.summary || input.requirements.goal,
      '',
      '### Goal',
      input.requirements.goal,
      '',
      '### What the build does',
      bulletList(input.requirements.behaviors.length > 0 ? input.requirements.behaviors : input.requirements.requirements),
      '',
      input.hardwarePlan && input.hardwarePlan.signalFlow.length > 0
        ? ['### Signal flow', '```text', input.hardwarePlan.signalFlow.join('\n  ↓ '), '```'].join('\n')
        : '',
      '',
      input.requirements.assumptions.length > 0 ? ['### Assumptions made', bulletList(input.requirements.assumptions)].join('\n') : '',
      input.requirements.ambiguities.length > 0 ? ['### Open questions', bulletList(input.requirements.ambiguities)].join('\n') : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  /* 2. Bill of materials ---------------------------------------------------- */
  push(
    'bill-of-materials',
    'Bill of materials',
    table(
      ['Qty', 'Component', 'Role', 'Why it is in the build'],
      input.selections.map((selection) => [
        String(selection.quantity),
        `${selection.name}${selection.matchedFrom ? ` (requested as "${selection.matchedFrom}")` : ''}`,
        selection.role,
        selection.reason,
      ]),
    ),
  );

  /* 3. Tools ---------------------------------------------------------------- */
  push(
    'tools-and-preparation',
    'Tools and preparation',
    bulletList([
      'Breadboard and jumper wires (already in the bill of materials).',
      'USB cable matching the controller board for programming and initial power.',
      'Arduino IDE 2.x or `arduino-cli` with the board core installed.',
      'Multimeter — verify rail voltages before connecting the controller.',
      input.selections.some((selection) => selection.category === 'motor')
        ? 'Battery or bench supply able to deliver the stall current listed in the power section.'
        : 'Power supply matching the voltage listed in the power section.',
      'Optional: small screwdriver for driver terminal blocks and trimmers.',
    ]),
  );

  /* 4. Wiring --------------------------------------------------------------- */
  const wiringConnections = input.wiring?.connections ?? [];
  push(
    'wiring',
    'Wiring',
    [
      `${wiringConnections.length} connection(s): ${wiringConnections.filter((connection) => connection.kind === 'signal').length} signal, ${
        wiringConnections.filter((connection) => connection.kind === 'power').length
      } power, ${wiringConnections.filter((connection) => connection.kind === 'ground').length} ground.`,
      '',
      table(
        ['From', 'To', 'Type', 'Why'],
        wiringConnections.map((connection) => [
          `${connection.from.instanceId}.${connection.from.pin}`,
          `${connection.to.instanceId}.${connection.to.pin}`,
          `${connection.kind} / ${connection.signal}`,
          connection.explanation,
        ]),
      ),
      '',
      '### Connection tree',
      buildWiringTree(input.wiring, input.selections),
      input.wiring && input.wiring.notes.length > 0 ? ['### Planner notes', bulletList(input.wiring.notes)].join('\n') : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  /* 5. Pinout --------------------------------------------------------------- */
  push(
    'pinout',
    'Pin assignments',
    input.pinAssignments.length > 0
      ? table(
          ['MCU pin', 'Peripheral', 'Direction', 'Protocol', 'Purpose', 'Why this pin'],
          input.pinAssignments.map((assignment) => [
            assignment.pin,
            `${assignment.targetInstanceId}.${assignment.targetPin}`,
            assignment.direction,
            assignment.protocol,
            assignment.purpose,
            assignment.rationale,
          ]),
        )
      : '_No MCU pins were assigned (this build has no controller-connected peripherals)._'
  );

  /* 6. Power ---------------------------------------------------------------- */
  const power = input.hardwarePlan?.power;
  push(
    'power',
    'Power requirements',
    power
      ? [
          power.supplyVoltage !== undefined
            ? `**Supply:** ${power.supplyVoltage} V from \`${power.supplyComponentId ?? 'unresolved'}\`${power.supplyInstanceId ? ` (${power.supplyInstanceId})` : ''}`
            : '**Supply:** not resolved — see the notes below.',
          power.totalTypicalMa !== undefined ? `**Typical load:** ${power.totalTypicalMa} mA` : '',
          power.totalPeakMa !== undefined ? `**Peak load:** ${power.totalPeakMa} mA` : '',
          power.adequate ? '✅ The selected supply covers the calculated load.' : '⚠️ The power budget check failed — read the notes before powering up.',
          '',
          '### Rails',
          table(
            ['Rail', 'Voltage', 'Typical', 'Peak', 'Loads'],
            power.rails.map((rail) => [
              rail.rail,
              `${rail.voltage} V`,
              rail.typicalMa !== undefined ? `${rail.typicalMa} mA` : '—',
              rail.peakMa !== undefined ? `${rail.peakMa} mA` : '—',
              rail.loads.join(', ') || '—',
            ]),
          ),
          '',
          '### Notes',
          bulletList(power.notes),
        ]
          .filter(Boolean)
          .join('\n')
      : '_No power analysis was produced._',
  );

  /* 7. Software setup ------------------------------------------------------- */
  const libraries = input.libraries;
  push(
    'software-setup',
    'Software setup',
    libraries
      ? [
          '### Libraries',
          table(
            ['Library', 'Header', 'Install', 'Purpose'],
            libraries.libraries.map((library) => [
              library.name,
              `\`${library.import}\``,
              library.builtIn ? 'included with the platform core' : library.manager ?? 'arduino',
              library.purpose,
            ]),
          ),
          '',
          '### Install commands',
          ['```bash', ...libraries.installCommands, '```'].join('\n'),
          libraries.notes.length > 0 ? ['### Notes', bulletList(libraries.notes)].join('\n') : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '_No library metadata was produced._',
  );

  /* 8. Flashing ------------------------------------------------------------- */
  const isEsp32 = /esp32/i.test(input.controllerComponentId ?? input.controllerName);
  push(
    'flashing',
    'Flashing the firmware',
    bulletList([
      `1. Install the ${isEsp32 ? 'esp32:esp32' : 'arduino:avr'} board core (${libraries?.installCommands[0] ?? 'arduino-cli core install …'}).`,
      `2. Select the board: ${isEsp32 ? 'Tools → Board → esp32 → "ESP32 Dev Module"' : 'Tools → Board → Arduino AVR Boards → the matching board'}.`,
      '3. Open `sketch.ino` from the generated artifacts.',
      `4. Connect the board over USB and pick the serial port${isEsp32 ? ' (hold BOOT if the board does not enter download mode)' : ''}.`,
      '5. Verify first, then Upload. Fix any missing library reported by the compiler using the install commands above.',
      '6. Open the serial monitor at 115200 baud to see the start-up banner.',
      input.wiring && input.wiring.conflicts.length > 0
        ? '7. ⚠️ Resolve the wiring conflicts listed in the validation report before connecting motor or mains-adjacent loads.'
        : '7. Power the motor/logic rails, then reset the board.',
    ]),
  );

  /* 9. Usage ---------------------------------------------------------------- */
  const commandSet = input.softwarePlan?.communication?.commandSet ?? [];
  push(
    'usage',
    'Usage',
    [
      input.softwarePlan?.communication
        ? `**Control link:** ${input.softwarePlan.communication.protocol} over ${input.softwarePlan.communication.transport}.`
        : '**Control link:** none — the build runs standalone.',
      input.softwarePlan?.communication?.details ? `_${input.softwarePlan.communication.details}_` : '',
      '',
      commandSet.length > 0
        ? ['### Commands', table(['Send', 'Meaning', 'Reply'], commandSet.map((entry) => [`\`${entry.command}\``, entry.meaning, entry.response ?? '—']))].join('\n')
        : '',
      '',
      '### Behaviour',
      bulletList(input.softwarePlan?.controlStates.map((state) => `**${state.name}** — ${state.description}`) ?? []),
      '',
      input.softwarePlan && input.softwarePlan.safety.length > 0 ? ['### Safety behaviour', bulletList(input.softwarePlan.safety)].join('\n') : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  /* 10. Pre-power checklist --------------------------------------------------- */
  const conflicts = input.wiring?.conflicts ?? [];
  push(
    'pre-power-checklist',
    'Pre-power checklist',
    bulletList([
      'Every ground pin in the wiring table is connected to the common ground net.',
      'Motor supply and logic supply are measured with a multimeter before the controller is plugged in.',
      'Polarised parts (electrolytic capacitors, diodes, LEDs, battery leads) are oriented correctly.',
      conflicts.length === 0
        ? 'The Wireup validation report shows no electrical conflicts.'
        : `⚠️ ${conflicts.length} conflict(s) are recorded in the wiring plan — review the validation section before powering up.`,
      input.selections.some((selection) => selection.category === 'motor_driver')
        ? 'Motor driver enable jumpers are set as described in the wiring notes (remove them only if PWM speed control is wired).'
        : 'No motor driver present — skip enable jumper checks.',
      'The controller is flashed with the generated sketch before the load rails are connected.',
    ]),
  );

  /* 11. Simulator ----------------------------------------------------------- */
  push(
    'simulation',
    'Simulation notes',
    input.diagram
      ? bulletList([
          `\`diagram.json\` (${input.diagram.format} v${input.diagram.version}) describes ${input.diagram.stats.components} components, ${input.diagram.stats.connections} connections and ${input.diagram.stats.pins} pins.`,
          'It is simulator-agnostic: components carry layout coordinates, pin anchors and per-part simulator hints.',
          `Parts without a verified simulator mapping: ${
            input.diagram.components.filter((component) => !component.simulator?.part || component.simulator.supported === false).length
          } — the Wokwi projection skips these and reports them.`,
          'Simulation execution is not implemented yet; the diagram is ready for a simulator adapter to consume.',
        ])
      : '_No diagram was produced._',
  );

  /* 12. Model-authored README (when the generation call supplied one) --------- */
  if (model.markdown && model.markdown.trim().length > 0) {
    push('generator-readme', 'Generator notes (model authored)', model.markdown.trim());
  }
  for (const modelSection of model.sections) {
    if (sections.some((section) => section.id === modelSection.id)) continue;
    if (['overview', 'usage'].includes(modelSection.id)) continue;
    push(`model-${modelSection.id}`, modelSection.title, modelSection.body);
  }

  /* 13. Revision history ----------------------------------------------------- */
  push(
    'revision',
    'Revision',
    `This document was generated for revision ${input.revision} at ${nowIso()}. Every fix produced by the validation loop creates a new revision with an explicit changeset, so you can compare this build against the previous one in the workspace.`,
  );

  const billOfMaterials = input.selections.map((selection) => ({
    name: selection.name,
    quantity: selection.quantity,
    ...(selection.notes ? { notes: selection.notes } : {}),
  }));

  const connectionCount = wiringConnections.length;
  const partCount = input.selections.reduce((sum, selection) => sum + selection.quantity, 0);
  const estimatedBuildTimeMinutes = Math.max(20, 15 + partCount * 4 + Math.round(connectionCount / 4) * 2);

  const markdown = [
    `# ${input.projectName}`,
    '',
    ...sections.map((section) => [`## ${section.title}`, '', section.body, ''].flat()),
  ].join('\n');

  const artifact: InstructionsArtifact = {
    markdown,
    sections,
    billOfMaterials,
    estimatedBuildTimeMinutes,
    generatedAt: nowIso(),
  };

  handle?.complete(`Instructions written — ${sections.length} section(s), ~${estimatedBuildTimeMinutes} min build estimate`, {
    sections: sections.length,
    billOfMaterials: billOfMaterials.length,
    characters: markdown.length,
  });

  return artifact;
}
