/**
 * Hardware Copilot — a small, deterministic edit planner for the workspace.
 *
 * The interaction is intentionally Cursor-shaped:
 *
 *   intent → plan → reviewable multi-artifact diff → apply → verify
 *
 * This module does not pretend to be GPT-6 Astra and it never invents a part.
 * It turns the common edit language judges use (“add a second button”, “swap
 * the ultrasonic sensor for a PIR”) into the same typed FixChange operations
 * the validator/fixer already trusts. A model can be plugged in at this seam
 * later without changing the UI or persistence contract.
 */

import type { ComponentDefinition, ComponentRole, ComponentSelection } from '@/types/component';
import type { ProjectState } from '@/types/project';
import type { FixChange } from '@/types/generation';

import { createId } from '@/lib/validation/ids';
import { matchComponent, matchComponentStrict } from '@/modules/components/service';

export type HardwareCopilotStatus = 'ready' | 'needs_clarification' | 'unsupported';

export interface HardwareEditPlan {
  status: HardwareCopilotStatus;
  title: string;
  summary: string;
  rationale: string;
  /** Human-readable steps shown before Apply. */
  steps: { label: string; detail: string; tone: 'change' | 'derive' | 'verify' }[];
  /** Files/artifacts that will move together. */
  affected: string[];
  /** Stable base revision for optimistic concurrency at Apply time. */
  baseRevision: number;
  /** The request echoed back so the UI can keep a single conversation turn. */
  request: string;
  /** Server-generated plan changes; never accepted from the browser on Apply. */
  changes: FixChange[];
  preview?: HardwareEditPreview;
  suggestions?: string[];
}

export interface HardwareEditPreview {
  parts: { kind: 'added' | 'removed' | 'changed'; before?: string; after?: string; detail: string }[];
  pins: { before: number; after: number; delta: number };
  wires: { before: number; after: number; delta: number };
  firmware: { files: number; changed: boolean };
  applied: number;
  rejected: { op: string; reason: string }[];
  notes: string[];
}

export interface HardwareEditResolution {
  plan: Omit<HardwareEditPlan, 'preview' | 'baseRevision' | 'request'>;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
};

const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
};

const ROLE_BY_CATEGORY: Partial<Record<ComponentDefinition['category'], ComponentRole>> = {
  microcontroller: 'controller',
  motor_driver: 'driver',
  motor: 'actuator',
  sensor: 'sensor',
  communication: 'communication',
  actuator: 'actuator',
  display: 'display',
  power: 'power',
  input_device: 'input',
  passive: 'passive',
  discrete: 'other',
  electromechanical: 'actuator',
  prototyping: 'prototyping',
  other: 'other',
};

function baseChange<A extends FixChange['artifact']>(artifact: A, reason: string): { id: string; artifact: A; reason: string; origin: 'model' } {
  return { id: createId('chg'), artifact, reason, origin: 'model' };
}

function stageChange(
  stage: 'pins' | 'wiring' | 'code' | 'libraries' | 'diagram' | 'instructions',
  reason: string,
  force = false,
): FixChange {
  const artifact: Extract<FixChange, { op: 'rerun_stage' }>['artifact'] =
    stage === 'pins' ? 'pinAssignments' : stage === 'wiring' ? 'wiring' : stage;
  return {
    ...baseChange(artifact, reason),
    op: 'rerun_stage',
    stage,
    ...(stage === 'code' && force ? { force: true } : {}),
  } as FixChange;
}

function clean(value: string): string {
  return value
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripBehavior(value: string): string {
  return clean(value.replace(/\s+(?:that|which|so that|so it|to)\s+.+$/i, ''));
}

function quantityToken(value: string | undefined): { quantity?: number; ordinal: boolean; another: boolean } {
  if (!value) return { ordinal: false, another: false };
  const token = value.toLowerCase();
  if (token === 'another') return { quantity: 1, ordinal: false, another: true };
  if (ORDINALS[token] !== undefined) return { quantity: ORDINALS[token], ordinal: true, another: false };
  if (NUMBER_WORDS[token] !== undefined) return { quantity: NUMBER_WORDS[token], ordinal: false, another: false };
  if (/^\d+$/.test(token)) return { quantity: Number.parseInt(token, 10), ordinal: false, another: false };
  return { ordinal: false, another: false };
}

function availableSuggestions(query: string, catalog: ComponentDefinition[], limit = 3): string[] {
  const matches = catalog
    .map((definition) => ({ definition, match: matchComponent(query, [definition]) }))
    .filter((entry) => entry.match && entry.match.score >= 25)
    .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
    .slice(0, limit)
    .map((entry) => entry.definition.name);
  return [...new Set(matches)];
}

function existingSelection(
  query: string,
  project: ProjectState,
  catalog: ComponentDefinition[],
): { selection: ComponentSelection; definition: ComponentDefinition } | undefined {
  const candidates = project.components
    .map((selection) => ({ selection, definition: catalog.find((entry) => entry.id === selection.componentId) }))
    .filter((entry): entry is { selection: ComponentSelection; definition: ComponentDefinition } => Boolean(entry.definition));

  const strict = matchComponentStrict(
    query,
    candidates.map((entry) => entry.definition),
    45,
  );
  if (strict) return candidates.find((entry) => entry.definition.id === strict.definition.id);

  const normalised = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return candidates.find(({ selection, definition }) => {
    const haystack = `${selection.name} ${selection.componentId} ${definition.name} ${(definition.aliases ?? []).join(' ')}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ');
    return normalised.length > 2 && haystack.includes(normalised);
  });
}

function catalogMatch(query: string, catalog: ComponentDefinition[]): ComponentDefinition | undefined {
  const strict = matchComponentStrict(stripBehavior(query), catalog, 50);
  if (strict) return strict.definition;

  const normalised = stripBehavior(query).toLowerCase();
  const hints: [RegExp, string][] = [
    [/\bbutton|push\s*button|tactile\b/, 'pushbutton-6mm'],
    [/\bultrasonic|hc[-\s]?sr04\b/, 'hc-sr04-ultrasonic'],
    [/\bpir|motion sensor\b/, 'pir-sensor-hc-sr501'],
    [/\bled\b/, 'led-5mm'],
    [/\bbuzzer|beeper|piezo\b/, 'buzzer-active-5v'],
    [/\bdht\s*22|am2302\b/, 'dht22-temperature-humidity'],
    [/\besp[-\s]?32\b/, 'esp32-devkit-v1'],
    [/\barduino\s*uno|\buno\b/, 'arduino-uno-r3'],
  ];
  for (const [pattern, id] of hints) {
    if (!pattern.test(normalised)) continue;
    const definition = catalog.find((entry) => entry.id === id);
    if (definition) return definition;
  }
  return undefined;
}

function derivations(reason: string): FixChange[] {
  // A hardware edit is a dependency graph edit. These are the explicit
  // checkpoints shown in the UI; the applier still gates every stage.
  return [
    stageChange('pins', reason),
    stageChange('wiring', reason),
    stageChange('code', reason, true),
    stageChange('libraries', reason),
    stageChange('diagram', reason),
    stageChange('instructions', reason),
  ];
}

function planForAdd(message: string, project: ProjectState, catalog: ComponentDefinition[]): HardwareEditResolution | undefined {
  const match = /^add\s+(?:(?:a|an|the)\s+)?(?:(another|first|second|third|fourth|fifth|one|two|three|four|five|six|seven|eight|\d+)\s+)?(.+)$/i.exec(clean(message));
  if (!match) return undefined;

  const token = quantityToken(match[1]);
  const phrase = stripBehavior(match[2] ?? '');
  const definition = catalogMatch(phrase, catalog);
  if (!definition) {
    return {
      plan: {
        status: 'needs_clarification',
        title: 'I need a catalog part to add',
        summary: `I couldn't map “${phrase}” to a verified component.`,
        rationale: 'Wireup only edits against parts in its catalog; it will not silently invent a substitute.',
        steps: [],
        affected: [],
        changes: [],
        suggestions: availableSuggestions(phrase, catalog),
      },
    };
  }

  const existing = project.components.find((selection) => selection.componentId === definition.id);
  const quantity = token.ordinal ? token.quantity ?? 1 : token.another ? (existing?.quantity ?? 0) + 1 : token.quantity ?? 1;
  const reason = `Hardware Copilot: ${clean(message)}`;
  const changes: FixChange[] = [];
  if (existing) {
    if (quantity <= existing.quantity) {
      return {
        plan: {
          status: 'needs_clarification',
          title: 'That part is already present',
          summary: `${existing.name} is already at quantity ${existing.quantity}.`,
          rationale: 'Tell me the target quantity, for example “make it three buttons”.',
          steps: [],
          affected: [],
          changes: [],
          suggestions: [`make it ${existing.quantity + 1} ${existing.name.toLowerCase()}s`],
        },
      };
    }
    changes.push({
      ...baseChange('components', reason),
      op: 'set_quantity',
      selectionId: existing.id,
      quantity,
    });
  } else {
    changes.push({
      ...baseChange('components', reason),
      op: 'add_component',
      componentId: definition.id,
      quantity,
      role: ROLE_BY_CATEGORY[definition.category] ?? 'other',
      required: true,
    });
  }
  changes.push(...derivations(reason));

  return {
    plan: {
      status: 'ready',
      title: `Add ${quantity} × ${definition.name}`,
      summary: existing
        ? `Increase ${existing.name} from ${existing.quantity} to ${quantity}.`
        : `Add ${quantity} × ${definition.name} to the build.`,
      rationale: `The catalog entry is verified. Wireup will re-run the dependent pin, wiring, firmware, diagram and guide stages before showing the result.`,
      steps: [
        { label: 'BOM', detail: existing ? `Set quantity to ${quantity}` : `Add ${quantity} catalog instance(s)`, tone: 'change' },
        { label: 'Pin map + wiring', detail: 'Choose compatible pins and extend the wiring graph', tone: 'derive' },
        { label: 'Firmware + guide', detail: 'Re-root the sketch and refresh the handoff artifacts', tone: 'derive' },
        { label: 'Validation', detail: 'Compile-check and re-run engineering rules', tone: 'verify' },
      ],
      affected: ['parts', 'pin map', 'wiring', 'firmware', 'libraries', 'diagram', 'build guide'],
      changes,
    },
  };
}

function existingSelectionFlexible(
  query: string,
  project: ProjectState,
  catalog: ComponentDefinition[],
): { selection: ComponentSelection; definition: ComponentDefinition } | undefined {
  return existingSelection(query, project, catalog) ?? existingSelection(query.replace(/\b([a-z0-9-]+)s\b/gi, '$1'), project, catalog);
}

function planForQuantity(message: string, project: ProjectState, catalog: ComponentDefinition[]): HardwareEditResolution | undefined {
  const quantity = '(one|two|three|four|five|six|seven|eight|\\d+)';
  const direct = new RegExp(`^(?:make|set|change)\\s+(?:it|them)\\s+${quantity}\\s+(.+)$`, 'i').exec(clean(message));
  const target = new RegExp(`^(?:make|set|change)\\s+(?:the\\s+)?(?:(?:quantity|number)\\s+of\\s+)?(.+?)\\s+(?:to|at)\\s+${quantity}$`, 'i').exec(clean(message));
  const countToken = direct?.[1] ?? target?.[2];
  const phrase = stripBehavior(direct?.[2] ?? target?.[1] ?? '');
  if (!countToken || !phrase) return undefined;

  const count = quantityToken(countToken).quantity;
  const existing = existingSelectionFlexible(phrase, project, catalog);
  if (!count || count < 1 || !existing) {
    return {
      plan: {
        status: 'needs_clarification',
        title: existing ? 'That quantity is not valid' : 'I cannot find that part in this build',
        summary: existing ? 'Choose a positive target quantity.' : `There is no verified “${phrase}” selection to resize.`,
        rationale: 'Quantity edits apply to an existing BOM selection and never create an unverified part.',
        steps: [],
        affected: [],
        changes: [],
        suggestions: existing ? [`make it ${existing.selection.quantity + 1} ${existing.selection.name.toLowerCase()}s`] : project.components.map((selection) => selection.name).slice(0, 5),
      },
    };
  }
  if (count === existing.selection.quantity) {
    return {
      plan: {
        status: 'needs_clarification',
        title: 'That is already the current quantity',
        summary: `${existing.selection.name} is already at quantity ${count}.`,
        rationale: 'Choose a different target quantity to create a reviewable revision.',
        steps: [],
        affected: [],
        changes: [],
      },
    };
  }

  const reason = `Hardware Copilot: ${clean(message)}`;
  return {
    plan: {
      status: 'ready',
      title: `Set ${existing.selection.name} to ${count}`,
      summary: `Change ${existing.selection.name} from ${existing.selection.quantity} to ${count}.`,
      rationale: 'The BOM quantity is updated first; instance assignments, wiring, firmware and the handoff guide are then re-derived together.',
      steps: [
        { label: 'BOM', detail: `Set quantity to ${count}`, tone: 'change' },
        { label: 'Pin map + wiring', detail: 'Add or remove instance-level assignments and connections', tone: 'derive' },
        { label: 'Firmware + guide', detail: 'Refresh managed code and assembly instructions', tone: 'derive' },
        { label: 'Validation', detail: 'Compile-check and re-run engineering rules', tone: 'verify' },
      ],
      affected: ['parts', 'pin map', 'wiring', 'firmware', 'libraries', 'diagram', 'build guide'],
      changes: [
        { ...baseChange('components', reason), op: 'set_quantity', selectionId: existing.selection.id, quantity: count },
        ...derivations(reason),
      ],
    },
  };
}

function planForRemove(message: string, project: ProjectState, catalog: ComponentDefinition[]): HardwareEditResolution | undefined {
  const match = /^remove\s+(?:the\s+)?(?:(one|two|three|four|\d+)\s+)?(.+)$/i.exec(clean(message));
  if (!match) return undefined;
  const token = quantityToken(match[1]);
  const phrase = stripBehavior(match[2] ?? '');
  const existing = existingSelectionFlexible(phrase, project, catalog);
  if (!existing) {
    return {
      plan: {
        status: 'needs_clarification',
        title: 'I cannot find that part in this build',
        summary: `There is no verified “${phrase}” selection to remove.`,
        rationale: 'The current BOM is the source of truth for an edit.',
        steps: [],
        affected: [],
        changes: [],
        suggestions: project.components.map((selection) => selection.name).slice(0, 5),
      },
    };
  }
  const reason = `Hardware Copilot: ${clean(message)}`;
  const removeCount = token.quantity ?? existing.selection.quantity;
  const changes: FixChange[] = [];
  if (removeCount < existing.selection.quantity) {
    changes.push({
      ...baseChange('components', reason),
      op: 'set_quantity',
      selectionId: existing.selection.id,
      quantity: existing.selection.quantity - removeCount,
    });
  } else {
    changes.push({ ...baseChange('components', reason), op: 'remove_component', selectionId: existing.selection.id });
  }
  changes.push(...derivations(reason));
  return {
    plan: {
      status: 'ready',
      title: `Remove ${existing.selection.name}`,
      summary: removeCount < existing.selection.quantity ? `Reduce ${existing.selection.name} to ${existing.selection.quantity - removeCount}.` : `Remove ${existing.selection.name} from the build.`,
      rationale: 'Removing a part also removes its assignments and wires, then the downstream artifacts are re-derived.',
      steps: [
        { label: 'BOM', detail: removeCount < existing.selection.quantity ? `Remove ${removeCount} instance(s)` : 'Remove the selection', tone: 'change' },
        { label: 'Pins + wiring', detail: 'Drop stale assignments and connections, then re-plan', tone: 'derive' },
        { label: 'Artifacts', detail: 'Refresh firmware, diagram and guide', tone: 'derive' },
        { label: 'Validation', detail: 'Re-run compile and engineering checks', tone: 'verify' },
      ],
      affected: ['parts', 'pin map', 'wiring', 'firmware', 'libraries', 'diagram', 'build guide'],
      changes,
    },
  };
}

function planForReplace(message: string, project: ProjectState, catalog: ComponentDefinition[]): HardwareEditResolution | undefined {
  const match = /^(?:replace|swap|change)\s+(?:the\s+)?(.+?)\s+(?:with|for|to)\s+(.+)$/i.exec(clean(message));
  const switchMatch = /^switch\s+from\s+(.+?)\s+to\s+(.+)$/i.exec(clean(message));
  const source = match?.[1] ?? switchMatch?.[1];
  const target = match?.[2] ?? switchMatch?.[2];
  if (!source || !target) return undefined;

  const current = existingSelectionFlexible(stripBehavior(source), project, catalog);
  const definition = catalogMatch(stripBehavior(target), catalog);
  if (!current || !definition) {
    const missing = !current ? `I cannot find “${stripBehavior(source)}” in the current BOM.` : `I cannot map “${stripBehavior(target)}” to a verified catalog part.`;
    return {
      plan: {
        status: 'needs_clarification',
        title: 'I need one more hardware choice',
        summary: missing,
        rationale: 'A replacement must name both an existing selection and a real catalog target.',
        steps: [],
        affected: [],
        changes: [],
        suggestions: definition ? project.components.map((selection) => selection.name).slice(0, 5) : availableSuggestions(target, catalog),
      },
    };
  }
  const controllerMismatch = (current.selection.role === 'controller') !== (definition.category === 'microcontroller');
  if (controllerMismatch) {
    return {
      plan: {
        status: 'needs_clarification',
        title: 'That replacement changes the hardware class',
        summary: current.selection.role === 'controller'
          ? `${definition.name} is not a microcontroller, so it cannot replace ${current.selection.name} as the board.`
          : `${definition.name} is a board, so it cannot replace ${current.selection.name} as a peripheral.`,
        rationale: 'Keep replacements within the same hardware role so the pin and power plan stays explainable.',
        steps: [],
        affected: [],
        changes: [],
        suggestions: current.selection.role === 'controller'
          ? catalog.filter((entry) => entry.category === 'microcontroller').slice(0, 5).map((entry) => entry.name)
          : project.components.filter((entry) => entry.role !== 'controller').slice(0, 5).map((entry) => entry.name),
      },
    };
  }

  const reason = `Hardware Copilot: ${clean(message)}`;
  const changes: FixChange[] = [
    {
      ...baseChange('components', reason),
      op: 'replace_component',
      selectionId: current.selection.id,
      componentId: definition.id,
      quantity: current.selection.quantity,
      role: current.selection.role,
    },
    ...derivations(reason),
  ];
  return {
    plan: {
      status: 'ready',
      title: `Replace ${current.selection.name} with ${definition.name}`,
      summary: `Swap the existing ${current.selection.name} for ${current.selection.quantity} × ${definition.name}.`,
      rationale: 'The old selection, its pin assignments and its wires will be removed before the new part is planned. Nothing is silently substituted.',
      steps: [
        { label: 'BOM', detail: `${current.selection.name} → ${definition.name}`, tone: 'change' },
        { label: 'Pin map + wiring', detail: 'Drop stale connections and assign compatible pins for the replacement', tone: 'derive' },
        { label: 'Firmware + guide', detail: 'Regenerate managed code blocks and assembly instructions', tone: 'derive' },
        { label: 'Validation', detail: 'Compile-check and re-run engineering rules', tone: 'verify' },
      ],
      affected: ['parts', 'pin map', 'wiring', 'firmware', 'libraries', 'diagram', 'build guide'],
      changes,
    },
  };
}

export function resolveHardwareEdit(message: string, project: ProjectState, catalog: ComponentDefinition[]): HardwareEditResolution {
  const text = clean(message);
  const resolved = planForQuantity(text, project, catalog) ?? planForReplace(text, project, catalog) ?? planForAdd(text, project, catalog) ?? planForRemove(text, project, catalog);
  if (resolved) return resolved;

  return {
    plan: {
      status: 'needs_clarification',
      title: 'Tell me the hardware change',
      summary: 'I can plan a safe BOM edit from a request like “add a second button” or “switch from Uno to ESP32”.',
      rationale: 'The edit surface is intentionally scoped: every change must map to a catalog part and a reviewable dependency diff.',
      steps: [],
      affected: [],
      changes: [],
      suggestions: ['add a second button', 'replace the ultrasonic sensor with a PIR sensor', 'switch from Uno to ESP32'],
    },
  };
}

export function buildHardwareEditPlan(
  resolution: HardwareEditResolution,
  project: ProjectState,
  request: string,
): HardwareEditPlan {
  return {
    ...resolution.plan,
    baseRevision: project.revision,
    request,
    changes: resolution.plan.changes,
  };
}
