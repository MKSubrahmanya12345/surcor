/**
 * CALL 3 — TARGETED FIX.
 *
 * Asks Bedrock for the smallest set of typed changes that repairs the issues
 * the deterministic strategies could not handle. The reply is *never* trusted:
 * every change is validated against the live project state (real ids, real
 * catalog parts, real pins) before it is allowed into the changeset, and
 * anything questionable is rejected with a reason the UI can show.
 */

import { z } from 'zod';

import type { ComponentDefinition, ComponentRole, LibraryRequirement } from '@/types/component';
import type { FixChange, FixChangeOp, RerunStageChange } from '@/types/generation';
import type { AgentEventLog } from '@/lib/logging/events';
import type { LlmCallRecord, ProjectRequirements, ProjectState } from '@/types/project';
import type { ArtifactKind, ValidationIssue, ValidationIssueCode } from '@/types/validation';
import type { ConnectionKind, ConnectionProtocol, PinAssignment, SignalType, WiringConnection, WiringEndpoint } from '@/types/wiring';

import { proposeFixChanges } from '@/lib/bedrock';
import type { FixPromptInput } from '@/lib/bedrock/prompts';
import { describeError, logger } from '@/lib/logging/logger';
import { changeId, createId } from '@/lib/validation/ids';
import { asArray, asRecord, truncate } from '@/lib/validation/json';
import { nowIso } from '@/lib/validation/time';

/** Hard cap on model-authored changes in a single pass. */
export const MAX_MODEL_CHANGES = 12;

const OPS: FixChangeOp[] = [
  'set_field',
  'replace_component',
  'add_component',
  'remove_component',
  'set_quantity',
  'set_pin_assignment',
  'remove_pin_assignment',
  'add_connection',
  'replace_connection',
  'remove_connection',
  'patch_code_file',
  'add_code_file',
  'remove_code_file',
  'set_libraries',
  'add_library',
  'remove_library',
  'patch_instructions',
  'rerun_stage',
];

const STAGES = ['pins', 'wiring', 'diagram', 'instructions', 'libraries', 'code'] as const;
const STAGE_ARTIFACT: Record<(typeof STAGES)[number], RerunStageChange['artifact']> = {
  pins: 'pinAssignments',
  wiring: 'wiring',
  diagram: 'diagram',
  instructions: 'instructions',
  libraries: 'libraries',
  code: 'code',
};

const ROLES: ComponentRole[] = [
  'controller',
  'driver',
  'sensor',
  'actuator',
  'communication',
  'power',
  'input',
  'display',
  'passive',
  'prototyping',
  'other',
];

const REQUIREMENT_FIELDS: (keyof ProjectRequirements)[] = [
  'goal',
  'summary',
  'requirements',
  'inputs',
  'outputs',
  'behaviors',
  'constraints',
  'platformRequirements',
  'communicationRequirements',
  'powerRequirements',
  'quantities',
  'features',
  'assumptions',
  'ambiguities',
  'detectedPlatform',
];

const KINDS: ConnectionKind[] = ['power', 'ground', 'signal'];
const SIGNALS: SignalType[] = [
  'digital',
  'analog',
  'pwm',
  'uart',
  'i2c',
  'spi',
  'one_wire',
  'motor_drive',
  'enable',
  'interrupt',
  'power',
  'ground',
  'unknown',
];
const PROTOCOLS: ConnectionProtocol[] = ['gpio', 'uart', 'i2c', 'spi', 'adc', 'pwm', 'one_wire', 'power', 'other'];

const FixPayloadSchema = z
  .object({
    changes: z.array(z.unknown()).optional().catch(undefined),
    notes: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional().catch(undefined),
  })
  .passthrough();

export interface ModelFixInput {
  project: ProjectState;
  /** Issues this pass must repair (already filtered by the caller). */
  issues: ValidationIssue[];
  catalog: ComponentDefinition[];
  catalogContext: string;
  mcuContext: string;
  iteration: number;
  events?: AgentEventLog;
}

export interface ModelFixResult {
  changes: FixChange[];
  rejected: { op: string; reason: string }[];
  notes: string[];
  call: LlmCallRecord;
  error?: string;
}

/* ------------------------------------------------------------------------- */
/* Prompt context                                                             */
/* ------------------------------------------------------------------------- */

function dominantArtifact(issues: ValidationIssue[]): ArtifactKind {
  const counts = new Map<ArtifactKind, number>();
  for (const issue of issues) {
    const artifact = issue.target?.artifact ?? 'requirements';
    counts.set(artifact, (counts.get(artifact) ?? 0) + (issue.severity === 'error' ? 3 : 1));
  }
  const best = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
  return best?.[0] ?? 'requirements';
}

function projectContext(project: ProjectState): string {
  return truncate(
    JSON.stringify(
      {
        projectId: project.id,
        revision: project.revision,
        requirements: project.requirements
          ? { goal: project.requirements.goal, features: project.requirements.features, quantities: project.requirements.quantities }
          : null,
        selections: project.components.map((selection) => ({
          selectionId: selection.id,
          componentId: selection.componentId,
          name: selection.name,
          role: selection.role,
          quantity: selection.quantity,
          required: selection.required,
          instances: selection.instances.map((instance) => ({ instanceId: instance.instanceId, index: instance.index, label: instance.label ?? null })),
        })),
        controller: project.hardwarePlan?.controller ?? null,
        power: project.hardwarePlan?.power ?? null,
        pinAssignments: project.pinAssignments.map((assignment) => ({
          id: assignment.id,
          pin: assignment.pin,
          targetInstanceId: assignment.targetInstanceId,
          targetPin: assignment.targetPin,
          direction: assignment.direction,
          signal: assignment.signal,
        })),
        connections: (project.wiring?.connections ?? []).map((connection) => ({
          id: connection.id,
          from: `${connection.from.instanceId}.${connection.from.pin}`,
          to: `${connection.to.instanceId}.${connection.to.pin}`,
          kind: connection.kind,
          signal: connection.signal,
        })),
        softwarePlan: project.softwarePlan
          ? { architecture: project.softwarePlan.architecture, files: project.softwarePlan.files, libraries: project.softwarePlan.libraries.map((library) => library.name) }
          : null,
        codeFiles: (project.artifacts.code?.files ?? []).map((file) => ({ path: file.path, language: file.language, characters: file.content.length })),
        libraries: (project.artifacts.libraries?.libraries ?? []).map((library) => ({ name: library.name, import: library.import })),
        diagramComponents: (project.artifacts.diagram?.components ?? []).map((component) => ({ id: component.id, ref: component.ref })),
        instructionSections: (project.artifacts.instructions?.sections ?? []).map((section) => ({ id: section.id, title: section.title })),
      },
      null,
      2,
    ),
    14000,
  );
}

function relevantArtifact(project: ProjectState, artifact: ArtifactKind): string {
  switch (artifact) {
    case 'requirements':
      return truncate(JSON.stringify(project.requirements ?? {}, null, 2), 6000);
    case 'components':
      return truncate(JSON.stringify(project.components, null, 2), 9000);
    case 'hardwarePlan':
      return truncate(JSON.stringify(project.hardwarePlan ?? {}, null, 2), 8000);
    case 'pinAssignments':
      return truncate(JSON.stringify(project.pinAssignments, null, 2), 9000);
    case 'wiring':
      return truncate(JSON.stringify(project.wiring ?? {}, null, 2), 12000);
    case 'softwarePlan':
      return truncate(JSON.stringify(project.softwarePlan ?? {}, null, 2), 8000);
    case 'code':
      return truncate(
        (project.artifacts.code?.files ?? []).map((file) => `--- ${file.path} ---\n${file.content}`).join('\n\n'),
        16000,
      );
    case 'diagram':
      return truncate(JSON.stringify(project.artifacts.diagram ?? {}, null, 2), 10000);
    case 'libraries':
      return truncate(JSON.stringify(project.artifacts.libraries ?? {}, null, 2), 6000);
    case 'instructions':
      return truncate(
        JSON.stringify(
          {
            markdown: project.artifacts.instructions?.markdown ?? '',
            sections: (project.artifacts.instructions?.sections ?? []).map((section) => ({ id: section.id, title: section.title, body: section.body })),
          },
          null,
          2,
        ),
        10000,
      );
    default:
      return '(none)';
  }
}

/* ------------------------------------------------------------------------- */
/* Normalisation helpers                                                      */
/* ------------------------------------------------------------------------- */

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number') return String(value);
  return undefined;
}

function num(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback?: T): T | undefined {
  if (!value) return fallback;
  const normalised = value.trim().toLowerCase().replace(/[^a-z_]/g, '_');
  return allowed.find((entry) => entry === normalised) ?? fallback;
}

interface ResolveContext {
  project: ProjectState;
  catalog: ComponentDefinition[];
}

/** Resolve `componentId` + 1-based `instanceIndex` (or a direct instanceId). */
function resolveInstance(ctx: ResolveContext, record: Record<string, unknown>, side: 'from' | 'to'): { endpoint: WiringEndpoint; error?: undefined } | { endpoint?: undefined; error: string } {
  const prefix = side;
  const directId = str(record, `${prefix}InstanceId`) ?? str(record, `${prefix}Instance`);
  if (directId) {
    for (const selection of ctx.project.components) {
      const instance = selection.instances.find((entry) => entry.instanceId === directId);
      if (instance) {
        const pin = str(record, `${prefix}Pin`);
        if (!pin) return { error: `${side} endpoint is missing a pin` };
        return { endpoint: { componentId: instance.componentId, instanceId: instance.instanceId, pin } };
      }
    }
    return { error: `${side} instance "${directId}" is not in the bill of materials` };
  }

  const componentId = str(record, `${prefix}ComponentId`) ?? str(record, `${prefix}Component`);
  const index = num(record, `${prefix}InstanceIndex`) ?? 1;
  if (!componentId) return { error: `${side} endpoint needs either ${prefix}InstanceId or ${prefix}ComponentId` };

  const selection = ctx.project.components.find((entry) => entry.componentId === componentId);
  if (!selection) return { error: `${componentId} is not selected in this project` };
  const instance = selection.instances[Math.max(0, Math.round(index) - 1)] ?? selection.instances[0];
  if (!instance) return { error: `${componentId} has no instances` };
  const pin = str(record, `${prefix}Pin`);
  if (!pin) return { error: `${side} endpoint is missing a pin` };

  const definition = ctx.catalog.find((component) => component.id === componentId);
  if (definition && definition.pins.length > 0 && !definition.pins.some((entry) => entry.name.toLowerCase() === pin.toLowerCase())) {
    return { error: `pin "${pin}" does not exist on ${definition.name}` };
  }

  return { endpoint: { componentId: instance.componentId, instanceId: instance.instanceId, pin } };
}

function normaliseLibrary(raw: unknown): LibraryRequirement | undefined {
  const record = asRecord(raw);
  const name = str(record, 'name');
  const importName = str(record, 'import') ?? str(record, 'header') ?? str(record, 'include');
  if (!name && !importName) return undefined;
  const header = importName ?? `${name}.h`;
  return {
    name: name ?? header.replace(/\.h$/i, ''),
    import: header,
    purpose: str(record, 'purpose') ?? 'Required by the generated firmware.',
    ...(pick(str(record, 'manager'), ['arduino', 'esp-idf', 'platformio', 'pip', 'other'] as const) ? { manager: pick(str(record, 'manager'), ['arduino', 'esp-idf', 'platformio', 'pip', 'other'] as const) } : {}),
    ...(str(record, 'version') ? { version: str(record, 'version') } : {}),
    ...(str(record, 'repository') ? { repository: str(record, 'repository') } : {}),
    ...(record.builtIn === true ? { builtIn: true } : {}),
  };
}

/**
 * Validate + normalise one model-authored change against the live project.
 * Returns either a typed `FixChange` or a rejection reason.
 */
export function normaliseModelChange(raw: unknown, ctx: ResolveContext): { change?: FixChange; reject?: string } {
  const record = asRecord(raw);
  const op = pick(str(record, 'op'), OPS);
  if (!op) return { reject: `unknown op "${String(record.op ?? '')}"` };

  const reason = str(record, 'reason') ?? `Model-provided ${op} change.`;
  const issueId = str(record, 'issueId');
  const issueCodeRaw = str(record, 'issueCode');
  const issueCode = issueCodeRaw as ValidationIssueCode | undefined;
  const declaredArtifact = str(record, 'artifact');

  const base = {
    id: changeId(),
    reason: truncate(reason, 400),
    origin: 'model' as const,
    ...(issueId && ctx.project.validation?.issues.some((issue) => issue.id === issueId) ? { issueId } : {}),
    ...(issueCode ? { issueCode } : {}),
  };

  switch (op) {
    case 'set_field': {
      const field = str(record, 'field') as keyof ProjectRequirements | undefined;
      if (!field || !REQUIREMENT_FIELDS.includes(field)) return { reject: `set_field: "${String(record.field ?? '')}" is not a requirements field` };
      if (record.value === undefined) return { reject: 'set_field: missing value' };
      return { change: { ...base, artifact: 'requirements', op, field, value: record.value } };
    }

    case 'add_component': {
      const componentId = str(record, 'componentId');
      if (!componentId) return { reject: 'add_component: missing componentId' };
      if (!ctx.catalog.some((component) => component.id === componentId)) {
        return { reject: `add_component: "${componentId}" is not in the component database (invented hardware is not allowed)` };
      }
      const role = pick(str(record, 'role'), ROLES, 'other') as ComponentRole;
      const quantity = Math.min(20, Math.max(1, Math.round(num(record, 'quantity') ?? 1)));
      return {
        change: {
          ...base,
          artifact: 'components',
          op,
          componentId,
          quantity,
          role,
          reason: truncate(reason, 400),
          ...(record.required === false ? { required: false } : { required: true }),
        },
      };
    }

    case 'replace_component': {
      const selectionId = str(record, 'selectionId');
      const selection = ctx.project.components.find((entry) => entry.id === selectionId);
      if (!selection) return { reject: `replace_component: selection "${String(selectionId ?? '')}" does not exist` };
      const componentId = str(record, 'componentId');
      if (componentId && !ctx.catalog.some((component) => component.id === componentId)) {
        return { reject: `replace_component: "${componentId}" is not in the component database` };
      }
      if (selection.role === 'controller' && componentId) {
        const definition = ctx.catalog.find((component) => component.id === componentId);
        if (definition && definition.category !== 'microcontroller') {
          return { reject: 'replace_component: the controller can only be replaced by another microcontroller' };
        }
      }
      const role = pick(str(record, 'role'), ROLES) as ComponentRole | undefined;
      return {
        change: {
          ...base,
          artifact: 'components',
          op,
          selectionId: selection.id,
          ...(componentId ? { componentId } : {}),
          ...(num(record, 'quantity') !== undefined ? { quantity: Math.min(20, Math.max(1, Math.round(num(record, 'quantity') as number))) } : {}),
          ...(role ? { role } : {}),
          ...(str(record, 'reason') ? { reason: truncate(str(record, 'reason') as string, 400) } : {}),
        },
      };
    }

    case 'remove_component': {
      const selectionId = str(record, 'selectionId');
      const selection = ctx.project.components.find((entry) => entry.id === selectionId);
      if (!selection) return { reject: `remove_component: selection "${String(selectionId ?? '')}" does not exist` };
      if (selection.role === 'controller') return { reject: 'remove_component: refusing to remove the controller' };
      if (selection.required) return { reject: `remove_component: ${selection.name} is marked required` };
      return { change: { ...base, artifact: 'components', op, selectionId: selection.id } };
    }

    case 'set_quantity': {
      const selectionId = str(record, 'selectionId');
      const selection = ctx.project.components.find((entry) => entry.id === selectionId);
      if (!selection) return { reject: `set_quantity: selection "${String(selectionId ?? '')}" does not exist` };
      const quantity = Math.round(num(record, 'quantity') ?? Number.NaN);
      if (!Number.isFinite(quantity) || quantity < 1 || quantity > 20) return { reject: 'set_quantity: quantity must be between 1 and 20' };
      return { change: { ...base, artifact: 'components', op, selectionId: selection.id, quantity } };
    }

    case 'set_pin_assignment': {
      const assignmentRecord = asRecord(record.assignment);
      const assignmentId = str(record, 'assignmentId');
      const existing = ctx.project.pinAssignments.find((assignment) => assignment.id === assignmentId);
      if (assignmentId && !existing) return { reject: `set_pin_assignment: assignment "${assignmentId}" does not exist` };

      const pin = str(assignmentRecord, 'pin') ?? str(record, 'pin');
      const targetInstanceId = str(assignmentRecord, 'targetInstanceId') ?? str(record, 'targetInstanceId') ?? existing?.targetInstanceId;
      const targetPin = str(assignmentRecord, 'targetPin') ?? str(record, 'targetPin') ?? existing?.targetPin;
      if (!pin) return { reject: 'set_pin_assignment: missing pin' };
      if (!targetInstanceId || !targetPin) return { reject: 'set_pin_assignment: missing targetInstanceId/targetPin' };
      if (!ctx.project.components.some((selection) => selection.instances.some((instance) => instance.instanceId === targetInstanceId))) {
        return { reject: `set_pin_assignment: target instance "${targetInstanceId}" is not in the bill of materials` };
      }

      const patch: Partial<PinAssignment> & { pin: string; targetInstanceId: string; targetPin: string } = {
        pin,
        targetInstanceId,
        targetPin,
        ...(num(assignmentRecord, 'pinNumber') !== undefined ? { pinNumber: num(assignmentRecord, 'pinNumber') } : {}),
        ...(str(assignmentRecord, 'purpose') ? { purpose: str(assignmentRecord, 'purpose') as string } : {}),
        ...(pick(str(assignmentRecord, 'signal'), SIGNALS) ? { signal: pick(str(assignmentRecord, 'signal'), SIGNALS) as SignalType } : {}),
        ...(pick(str(assignmentRecord, 'direction'), ['input', 'output'] as const) ? { direction: pick(str(assignmentRecord, 'direction'), ['input', 'output'] as const) as 'input' | 'output' } : {}),
        ...(pick(str(assignmentRecord, 'protocol'), PROTOCOLS) ? { protocol: pick(str(assignmentRecord, 'protocol'), PROTOCOLS) as ConnectionProtocol } : {}),
        ...(str(assignmentRecord, 'rationale') ? { rationale: str(assignmentRecord, 'rationale') as string } : {}),
        source: 'fixer',
      };

      return {
        change: {
          ...base,
          artifact: 'pinAssignments',
          op,
          ...(existing ? { assignmentId: existing.id } : {}),
          assignment: patch,
        },
      };
    }

    case 'remove_pin_assignment': {
      const assignmentId = str(record, 'assignmentId');
      if (!ctx.project.pinAssignments.some((assignment) => assignment.id === assignmentId)) {
        return { reject: `remove_pin_assignment: assignment "${String(assignmentId ?? '')}" does not exist` };
      }
      return { change: { ...base, artifact: 'pinAssignments', op, assignmentId: assignmentId as string } };
    }

    case 'add_connection': {
      const connectionRecord = asRecord(record.connection);
      const source = Object.keys(connectionRecord).length > 0 ? connectionRecord : record;
      const from = resolveInstance(ctx, source, 'from');
      if (from.error || !from.endpoint) return { reject: `add_connection: ${from.error}` };
      const to = resolveInstance(ctx, source, 'to');
      if (to.error || !to.endpoint) return { reject: `add_connection: ${to.error}` };
      const kind = pick(str(source, 'kind'), KINDS, 'signal') as ConnectionKind;
      const signal = pick(str(source, 'signal'), SIGNALS, kind === 'power' ? 'power' : kind === 'ground' ? 'ground' : 'digital') as SignalType;
      const connection: Omit<WiringConnection, 'id'> = {
        from: from.endpoint,
        to: to.endpoint,
        kind,
        signal,
        protocol: pick(str(source, 'protocol'), PROTOCOLS, kind === 'signal' ? 'gpio' : 'power') as ConnectionProtocol,
        direction: pick(str(source, 'direction'), ['unidirectional', 'bidirectional'] as const, 'unidirectional') as WiringConnection['direction'],
        explanation: truncate(str(source, 'explanation') ?? reason, 400),
        source: 'fixer',
        ...(num(source, 'voltage') !== undefined ? { voltage: num(source, 'voltage') } : {}),
        metadata: { role: 'model_patch', ...(issueId ? { issueId } : {}) },
      };
      return { change: { ...base, artifact: 'wiring', op, connection } };
    }

    case 'replace_connection': {
      const connectionId = str(record, 'connectionId');
      const connection = (ctx.project.wiring?.connections ?? []).find((entry) => entry.id === connectionId);
      if (!connection) return { reject: `replace_connection: connection "${String(connectionId ?? '')}" does not exist` };
      const patch = asRecord(record.connection);
      const fromPin = str(record, 'fromPin') ?? str(patch, 'fromPin');
      const toPin = str(record, 'toPin') ?? str(patch, 'toPin');
      if (Object.keys(patch).length === 0 && !fromPin && !toPin) return { reject: 'replace_connection: nothing to change' };
      return {
        change: {
          ...base,
          artifact: 'wiring',
          op,
          connectionId: connection.id,
          ...(fromPin ? { fromPin } : {}),
          ...(toPin ? { toPin } : {}),
          ...(Object.keys(patch).length > 0
            ? {
                connection: {
                  ...(str(patch, 'kind') && pick(str(patch, 'kind'), KINDS) ? { kind: pick(str(patch, 'kind'), KINDS) as ConnectionKind } : {}),
                  ...(str(patch, 'signal') && pick(str(patch, 'signal'), SIGNALS) ? { signal: pick(str(patch, 'signal'), SIGNALS) as SignalType } : {}),
                  ...(str(patch, 'explanation') ? { explanation: truncate(str(patch, 'explanation') as string, 400) } : {}),
                  ...(num(patch, 'voltage') !== undefined ? { voltage: num(patch, 'voltage') } : {}),
                },
              }
            : {}),
        },
      };
    }

    case 'remove_connection': {
      const connectionId = str(record, 'connectionId');
      if (!(ctx.project.wiring?.connections ?? []).some((entry) => entry.id === connectionId)) {
        return { reject: `remove_connection: connection "${String(connectionId ?? '')}" does not exist` };
      }
      return { change: { ...base, artifact: 'wiring', op, connectionId: connectionId as string } };
    }

    case 'patch_code_file': {
      const path = str(record, 'path');
      const files = ctx.project.artifacts.code?.files ?? [];
      if (!path) return { reject: 'patch_code_file: missing path' };
      const file = files.find((entry) => entry.path === path);
      const mode = pick(str(record, 'mode'), ['replace', 'append', 'prepend', 'find_replace', 'regex_replace'] as const);
      if (!mode) return { reject: `patch_code_file: unsupported mode "${String(record.mode ?? '')}"` };
      if (!file && mode !== 'replace') return { reject: `patch_code_file: ${path} does not exist (use add_code_file)` };
      if (mode === 'replace' && str(record, 'content') === undefined) return { reject: 'patch_code_file: replace mode needs content' };
      if ((mode === 'find_replace' || mode === 'regex_replace') && (str(record, 'find') === undefined || str(record, 'replace') === undefined)) {
        return { reject: 'patch_code_file: find_replace/regex_replace need find and replace' };
      }
      if (mode === 'find_replace' && file && str(record, 'find') && !file.content.includes(str(record, 'find') as string)) {
        return { reject: `patch_code_file: search text not present in ${path}` };
      }
      if (mode === 'replace' && file && path === ctx.project.artifacts.code?.entryPoint) {
        return { reject: `patch_code_file: refusing to wholesale-replace the entry point ${path} — use a targeted mode` };
      }
      return {
        change: {
          ...base,
          artifact: 'code',
          op,
          path,
          mode,
          ...(str(record, 'content') !== undefined ? { content: str(record, 'content') as string } : {}),
          ...(str(record, 'find') !== undefined ? { find: str(record, 'find') as string } : {}),
          ...(str(record, 'replace') !== undefined ? { replace: str(record, 'replace') as string } : {}),
        },
      };
    }

    case 'add_code_file': {
      const path = str(record, 'path');
      const content = str(record, 'content');
      if (!path || content === undefined) return { reject: 'add_code_file: needs path and content' };
      if ((ctx.project.artifacts.code?.files ?? []).some((entry) => entry.path === path)) {
        return { reject: `add_code_file: ${path} already exists` };
      }
      return {
        change: {
          ...base,
          artifact: 'code',
          op,
          path,
          language: str(record, 'language') ?? (path.endsWith('.ino') || path.endsWith('.cpp') || path.endsWith('.h') ? 'arduino-cpp' : 'text'),
          content,
          ...(str(record, 'purpose') ? { purpose: str(record, 'purpose') as string } : {}),
        },
      };
    }

    case 'remove_code_file': {
      const path = str(record, 'path');
      if (!path) return { reject: 'remove_code_file: missing path' };
      if (path === ctx.project.artifacts.code?.entryPoint) return { reject: 'remove_code_file: refusing to remove the entry point' };
      if (!(ctx.project.artifacts.code?.files ?? []).some((entry) => entry.path === path)) {
        return { reject: `remove_code_file: ${path} does not exist` };
      }
      return { change: { ...base, artifact: 'code', op, path } };
    }

    case 'add_library': {
      const library = normaliseLibrary(record.library ?? record);
      if (!library) return { reject: 'add_library: needs at least a library name or import header' };
      return { change: { ...base, artifact: 'libraries', op, library } };
    }

    case 'remove_library': {
      const libraryName = str(record, 'libraryName') ?? str(record, 'name');
      if (!libraryName) return { reject: 'remove_library: missing libraryName' };
      return { change: { ...base, artifact: 'libraries', op, libraryName } };
    }

    case 'set_libraries': {
      const libraries = asArray(record.libraries).map(normaliseLibrary).filter((library): library is LibraryRequirement => library !== undefined);
      if (libraries.length === 0) return { reject: 'set_libraries: no valid library entries' };
      return { change: { ...base, artifact: 'libraries', op, libraries } };
    }

    case 'patch_instructions': {
      const sectionId = str(record, 'sectionId');
      const sections = ctx.project.artifacts.instructions?.sections ?? [];
      if (!sectionId) return { reject: 'patch_instructions: missing sectionId' };
      if (sections.length > 0 && !sections.some((section) => section.id === sectionId)) {
        return { reject: `patch_instructions: section "${sectionId}" does not exist` };
      }
      const content = str(record, 'content');
      if (content === undefined) return { reject: 'patch_instructions: missing content' };
      const mode = pick(str(record, 'mode'), ['replace', 'append'] as const, 'replace') as 'replace' | 'append';
      return { change: { ...base, artifact: 'instructions', op, sectionId, mode, content } };
    }

    case 'rerun_stage': {
      const stage = pick(str(record, 'stage'), STAGES);
      if (!stage) return { reject: `rerun_stage: unsupported stage "${String(record.stage ?? '')}"` };
      return { change: { ...base, artifact: STAGE_ARTIFACT[stage], op, stage } };
    }

    default:
      return { reject: `op "${op}" is not handled (declared artifact "${declaredArtifact ?? 'unknown'}")` };
  }
}

/* ------------------------------------------------------------------------- */
/* Entry point                                                                */
/* ------------------------------------------------------------------------- */

export async function proposeModelChanges(input: ModelFixInput): Promise<ModelFixResult> {
  const startedAt = Date.now();
  const call: LlmCallRecord = {
    id: createId('llm'),
    op: 'fix',
    model: 'unknown',
    startedAt: nowIso(),
    status: 'failed',
    iteration: input.iteration,
  };

  const artifactKind = dominantArtifact(input.issues);
  const handle = input.events?.start('llm_call_started', `Asking the model for a targeted fix (${artifactKind})...`, {
    stage: 'fixing',
    metadata: { op: 'fix', iteration: input.iteration, artifact: artifactKind, issues: input.issues.length },
  });

  const promptInput: FixPromptInput = {
    prompt: input.project.prompt,
    issues: truncate(
      JSON.stringify(
        input.issues.map((issue) => ({
          id: issue.id,
          code: issue.code,
          severity: issue.severity,
          domain: issue.domain,
          message: issue.message,
          details: issue.details ?? null,
          fixHint: issue.fixHint ?? null,
          target: issue.target ?? null,
        })),
        null,
        2,
      ),
      8000,
    ),
    projectContext: projectContext(input.project),
    relevantArtifact: relevantArtifact(input.project, artifactKind),
    artifactKind,
    catalogContext: truncate(input.catalogContext, 14000),
    mcuContext: truncate(input.mcuContext, 5000),
    iteration: input.iteration,
  };

  const ctx: ResolveContext = { project: input.project, catalog: input.catalog };

  try {
    const response = await proposeFixChanges(promptInput);

    call.model = response.model;
    call.finishedAt = nowIso();
    call.durationMs = Date.now() - startedAt;
    call.inputTokens = response.usage.inputTokens;
    call.outputTokens = response.usage.outputTokens;

    if (!response.ok || response.payload === undefined) {
      const failure = response.error ?? 'Model returned no parsable payload.';
      call.status = 'failed';
      call.error = failure;
      handle?.fail(`Model fix proposal failed: ${failure}`, failure, { op: 'fix' });
      return { changes: [], rejected: [], notes: [], call, error: failure };
    }

    call.status = 'ok';
    const parsed = FixPayloadSchema.safeParse(response.payload);
    const payload = parsed.success ? parsed.data : {};
    const changes: FixChange[] = [];
    const rejected: { op: string; reason: string }[] = [];

    for (const raw of asArray(payload.changes)) {
      if (changes.length >= MAX_MODEL_CHANGES) {
        rejected.push({ op: String(asRecord(raw).op ?? 'unknown'), reason: `change budget of ${MAX_MODEL_CHANGES} model changes reached` });
        continue;
      }
      const outcome = normaliseModelChange(raw, ctx);
      if (outcome.change) changes.push(outcome.change);
      else rejected.push({ op: String(asRecord(raw).op ?? 'unknown'), reason: outcome.reject ?? 'invalid change' });
    }

    const notes = asArray(payload.notes)
      .map((note) => (typeof note === 'string' ? note.trim() : truncate(JSON.stringify(note), 300)))
      .filter((note) => note.length > 0);

    handle?.complete(`Model proposed ${changes.length} change(s)${rejected.length > 0 ? `, ${rejected.length} rejected` : ''}.`, {
      op: 'fix',
      proposed: changes.length,
      rejected: rejected.length,
      artifact: artifactKind,
      repaired: response.repaired,
      attempts: response.attempts,
      inputTokens: response.usage.inputTokens ?? 0,
      outputTokens: response.usage.outputTokens ?? 0,
    });

    for (const entry of rejected) {
      input.events?.emit('fix_change_rejected', `Model change rejected (${entry.op}): ${entry.reason}`, {
        stage: 'fixing',
        metadata: { op: entry.op, reason: entry.reason, origin: 'model' },
      });
    }

    logger.debug({ changes: changes.length, rejected: rejected.length }, 'fixer: model proposal normalised');
    return { changes, rejected, notes, call };
  } catch (error) {
    const described = describeError(error);
    call.status = 'failed';
    call.error = described.message;
    call.finishedAt = nowIso();
    call.durationMs = Date.now() - startedAt;
    handle?.fail(`Model fix proposal failed: ${described.message}`, described.message, { op: 'fix' });
    logger.error({ err: error }, 'fixer: model proposal threw');
    return { changes: [], rejected: [], notes: [], call, error: described.message };
  }
}
