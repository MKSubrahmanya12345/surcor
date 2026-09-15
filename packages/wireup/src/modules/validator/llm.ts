/**
 * CALL 2 — VALIDATION (model side).
 *
 * Sends the generated project plus the deterministic engine's findings to
 * Bedrock for a critical review, then converts the reply into typed
 * `ValidationIssue`s that can be merged with the rule-engine output.
 *
 * The model can never delete an engine finding; it can only add to it.
 */

import { z } from 'zod';

import type { AgentEventLog } from '@/lib/logging/events';
import type { LlmCallRecord, ProjectState } from '@/types/project';
import type {
  ArtifactKind,
  ValidationDomain,
  ValidationIssue,
  ValidationIssueCode,
  ValidationSeverity,
} from '@/types/validation';

import { reviewProject } from '@/lib/bedrock';
import { ISSUE_CODE_LIST, type ValidationPromptInput } from '@/lib/bedrock/prompts';
import { describeError, logger } from '@/lib/logging/logger';
import { createId, issueId } from '@/lib/validation/ids';
import { asArray, asRecord, truncate } from '@/lib/validation/json';
import { nowIso } from '@/lib/validation/time';

import { AUTO_FIXABLE_CODES } from './rules';

const ARTIFACT_KINDS: ArtifactKind[] = [
  'requirements',
  'components',
  'hardwarePlan',
  'pinAssignments',
  'wiring',
  'softwarePlan',
  'code',
  'diagram',
  'libraries',
  'instructions',
  'assembly',
];

const DOMAINS: ValidationDomain[] = [
  'requirements',
  'components',
  'compatibility',
  'pins',
  'wiring',
  'power',
  'code',
  'diagram',
  'libraries',
  'instructions',
  'structure',
  'assembly',
];

/* ------------------------------------------------------------------------- */
/* Lenient payload schema — the model is never trusted to be exact            */
/* ------------------------------------------------------------------------- */

const ModelIssueSchema = z
  .object({
    code: z.union([z.string(), z.number()]).optional().catch(undefined),
    severity: z.string().optional().catch(undefined),
    domain: z.string().optional().catch(undefined),
    artifact: z.string().optional().catch(undefined),
    message: z.union([z.string(), z.number()]).optional().catch(undefined),
    details: z.string().optional().catch(undefined),
    fixHint: z.union([z.string(), z.array(z.string())]).optional().catch(undefined),
    autoFixable: z.boolean().optional().catch(undefined),
    target: z.record(z.string(), z.unknown()).optional().catch(undefined),
  })
  .passthrough();

const ModelReviewPayloadSchema = z
  .object({
    verdict: z.string().optional().catch(undefined),
    confidence: z.union([z.number(), z.string()]).optional().catch(undefined),
    issues: z.array(z.unknown()).optional().catch(undefined),
    notes: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional().catch(undefined),
    summary: z.string().optional().catch(undefined),
  })
  .passthrough();

/* ------------------------------------------------------------------------- */
/* Normalisation helpers                                                      */
/* ------------------------------------------------------------------------- */

function squash(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}

function domainFor(value: unknown, fallback: ValidationDomain): ValidationDomain {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback;
  const normalised = squash(value);
  const exact = DOMAINS.find((domain) => squash(domain) === normalised);
  if (exact) return exact;
  if (normalised.includes('pin') || normalised.includes('gpio')) return 'pins';
  if (normalised.includes('wir') || normalised.includes('connect')) return 'wiring';
  if (normalised.includes('pow') || normalised.includes('volt') || normalised.includes('current')) return 'power';
  if (normalised.includes('code') || normalised.includes('firmware') || normalised.includes('sketch')) return 'code';
  if (normalised.includes('diagram') || normalised.includes('schematic')) return 'diagram';
  if (normalised.includes('librar') || normalised.includes('depend')) return 'libraries';
  if (normalised.includes('component') || normalised.includes('part') || normalised.includes('bom')) return 'components';
  if (normalised.includes('compat')) return 'compatibility';
    if (normalised.includes('instruction') || normalised.includes('doc')) return 'instructions';
  if (normalised.includes('requirement') || normalised.includes('goal')) return 'requirements';
  if (normalised.includes('assembl') || normalised.includes('3d') || normalised.includes('chassis')) return 'assembly';
  return fallback;
}

function artifactFor(value: unknown, domain: ValidationDomain): ArtifactKind {
  if (typeof value === 'string' && value.trim().length > 0) {
    const normalised = squash(value);
    const exact = ARTIFACT_KINDS.find((kind) => squash(kind) === normalised);
    if (exact) return exact;
    if (normalised.includes('pin')) return 'pinAssignments';
    if (normalised.includes('wir')) return 'wiring';
    if (normalised.includes('code') || normalised.includes('sketch') || normalised.includes('firmware')) return 'code';
    if (normalised.includes('diagram')) return 'diagram';
    if (normalised.includes('librar')) return 'libraries';
    if (normalised.includes('instruction')) return 'instructions';
    if (normalised.includes('component')) return 'components';
    if (normalised.includes('hardware') || normalised.includes('power')) return 'hardwarePlan';
  }
  switch (domain) {
    case 'pins':
      return 'pinAssignments';
    case 'wiring':
      return 'wiring';
    case 'code':
      return 'code';
    case 'diagram':
      return 'diagram';
    case 'libraries':
      return 'libraries';
    case 'instructions':
      return 'instructions';
    case 'components':
    case 'compatibility':
      return 'components';
    case 'power':
      return 'hardwarePlan';
    case 'requirements':
      return 'requirements';
    case 'assembly':
      return 'assembly';
    default:
      return 'requirements';
  }
}

function severityFor(value: unknown): ValidationSeverity {
  const normalised = String(value ?? '').toLowerCase();
  if (normalised.includes('err') || normalised.includes('critical') || normalised.includes('block') || normalised.includes('fatal')) {
    return 'error';
  }
  if (normalised.includes('info') || normalised.includes('note') || normalised.includes('minor')) return 'info';
  return 'warning';
}

function codeFor(value: unknown): ValidationIssueCode {
  const normalised = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if ((ISSUE_CODE_LIST as string[]).includes(normalised)) return normalised as ValidationIssueCode;
  return 'model_review';
}

function verdictFor(value: unknown, issueCount: number): 'approve' | 'needs_changes' | 'reject' {
  const normalised = String(value ?? '').toLowerCase();
  if (normalised.includes('approve') || normalised.includes('pass') || normalised.includes('accept')) return 'approve';
  if (normalised.includes('reject') || normalised.includes('fail')) return 'reject';
  if (normalised.includes('needs') || normalised.includes('change') || normalised.includes('fix')) return 'needs_changes';
  return issueCount > 0 ? 'needs_changes' : 'approve';
}

function confidenceFor(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '').trim());
  if (!Number.isFinite(parsed)) return 0.5;
  const scaled = parsed > 1 ? parsed / 100 : parsed;
  return Math.min(1, Math.max(0, scaled));
}

function stringField(target: Record<string, unknown>, key: string): string | undefined {
  const value = target[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Signature used to suppress model duplicates of engine findings. */
export function issueSignature(issue: ValidationIssue): string {
  return [
    issue.code,
    issue.target?.pin ?? '',
    issue.target?.componentInstanceId ?? '',
    issue.target?.connectionId ?? '',
    issue.target?.filePath ?? '',
    issue.target?.library ?? '',
    issue.message.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 48),
  ].join('|');
}

/* ------------------------------------------------------------------------- */
/* Prompt input assembly                                                      */
/* ------------------------------------------------------------------------- */

export interface ModelReviewInput {
  project: ProjectState;
  catalogContext: string;
  mcuContext: string;
  ruleIssues: ValidationIssue[];
  iteration: number;
  events?: AgentEventLog;
}

export interface ModelReviewResult {
  issues: ValidationIssue[];
  notes: string[];
  verdict: 'approve' | 'needs_changes' | 'reject';
  confidence: number;
  call: LlmCallRecord;
  error?: string;
}

function buildPromptInput(input: ModelReviewInput): ValidationPromptInput {
  const { project } = input;
  const diagram = project.artifacts.diagram;

  return {
    prompt: project.prompt,
    requirements: truncate(JSON.stringify(project.requirements ?? {}, null, 2), 4000),
    components: truncate(
      JSON.stringify(
        project.components.map((selection) => ({
          selectionId: selection.id,
          componentId: selection.componentId,
          name: selection.name,
          role: selection.role,
          quantity: selection.quantity,
          reason: selection.reason,
          instances: selection.instances.map((instance) => instance.instanceId),
        })),
        null,
        2,
      ),
      6000,
    ),
    hardwarePlan: truncate(JSON.stringify(project.hardwarePlan ?? {}, null, 2), 5000),
    pinAssignments: truncate(
      JSON.stringify(
        project.pinAssignments.map((assignment) => ({
          id: assignment.id,
          pin: assignment.pin,
          targetInstanceId: assignment.targetInstanceId,
          targetPin: assignment.targetPin,
          direction: assignment.direction,
          signal: assignment.signal,
          protocol: assignment.protocol,
          purpose: assignment.purpose,
        })),
        null,
        2,
      ),
      7000,
    ),
    wiring: truncate(
      JSON.stringify(
        (project.wiring?.connections ?? []).map((connection) => ({
          id: connection.id,
          from: `${connection.from.instanceId}.${connection.from.pin}`,
          to: `${connection.to.instanceId}.${connection.to.pin}`,
          kind: connection.kind,
          signal: connection.signal,
          voltage: connection.voltage ?? null,
          explanation: connection.explanation,
        })),
        null,
        2,
      ),
      9000,
    ),
    softwarePlan: truncate(JSON.stringify(project.softwarePlan ?? {}, null, 2), 4000),
    code: truncate(
      (project.artifacts.code?.files ?? []).map((file) => `--- ${file.path} (${file.language}) ---\n${file.content}`).join('\n\n'),
      14000,
    ),
    diagram: truncate(
      JSON.stringify(
        {
          meta: diagram?.meta ?? null,
          stats: diagram?.stats ?? null,
          components: (diagram?.components ?? []).map((component) => ({
            id: component.id,
            ref: component.ref,
            type: component.type,
            pins: component.pins.map((pin) => pin.name),
          })),
          connections: (diagram?.connections ?? []).map((connection) => ({
            id: connection.id,
            from: `${connection.from.component}:${connection.from.pin}`,
            to: `${connection.to.component}:${connection.to.pin}`,
            kind: connection.kind,
            signal: connection.signal,
          })),
          rails: (diagram?.rails ?? []).map((rail) => ({ id: rail.id, name: rail.name, kind: rail.kind, members: rail.members.length })),
        },
        null,
        2,
      ),
      6000,
    ),
    libraries: truncate(JSON.stringify(project.artifacts.libraries ?? {}, null, 2), 3000),
    instructions: truncate(
      JSON.stringify(
        {
          estimatedBuildTimeMinutes: project.artifacts.instructions?.estimatedBuildTimeMinutes ?? null,
          billOfMaterials: project.artifacts.instructions?.billOfMaterials ?? [],
          sections: (project.artifacts.instructions?.sections ?? []).map((section) => ({
            id: section.id,
            title: section.title,
            characters: section.body.length,
          })),
        },
        null,
        2,
      ),
      3000,
    ),
    catalogContext: truncate(input.catalogContext, 16000),
    mcuContext: truncate(input.mcuContext, 5000),
    ruleEngineFindings:
      input.ruleIssues.length === 0
        ? 'None — the deterministic rule engine found no problems.'
        : truncate(
            JSON.stringify(
              input.ruleIssues.map((issue) => ({
                id: issue.id,
                code: issue.code,
                severity: issue.severity,
                domain: issue.domain,
                message: issue.message,
                details: issue.details ?? null,
                target: issue.target ?? null,
              })),
              null,
              2,
            ),
            7000,
          ),
    iteration: input.iteration,
  };
}

/* ------------------------------------------------------------------------- */
/* Entry point                                                                */
/* ------------------------------------------------------------------------- */

export async function runModelReview(input: ModelReviewInput): Promise<ModelReviewResult> {
  const startedAt = Date.now();
  const call: LlmCallRecord = {
    id: createId('llm'),
    op: 'validation',
    model: 'unknown',
    startedAt: nowIso(),
    status: 'failed',
    iteration: input.iteration,
  };

  const handle = input.events?.start('llm_call_started', 'Asking the model for a critical design review...', {
    stage: 'validating',
    metadata: { op: 'validation', iteration: input.iteration },
  });

  try {
    const response = await reviewProject(buildPromptInput(input));

    call.model = response.model;
    call.finishedAt = nowIso();
    call.durationMs = Date.now() - startedAt;
    call.inputTokens = response.usage.inputTokens;
    call.outputTokens = response.usage.outputTokens;

    if (!response.ok || response.payload === undefined) {
      const failure = response.error ?? 'Model returned no parsable payload.';
      call.status = 'failed';
      call.error = failure;
      handle?.fail(`Model review failed: ${failure}`, failure, { op: 'validation' });
      logger.warn({ failure, projectId: input.project.id }, 'validator: model review failed');
      return { issues: [], notes: [], verdict: 'needs_changes', confidence: 0, call, error: failure };
    }

    call.status = 'ok';

    const parsed = ModelReviewPayloadSchema.safeParse(response.payload);
    const payload = parsed.success ? parsed.data : {};
    if (!parsed.success) {
      logger.debug({ problems: parsed.error.issues.slice(0, 5) }, 'validator: review payload did not match the expected shape');
    }

    const ruleSignatures = new Set(input.ruleIssues.map(issueSignature));
    const issues: ValidationIssue[] = [];
    let rejected = 0;

    for (const raw of asArray(payload.issues)) {
      const candidate = ModelIssueSchema.safeParse(raw);
      if (!candidate.success) {
        rejected += 1;
        continue;
      }
      const value = candidate.data;
      const message = String(value.message ?? '').trim();
      if (message.length === 0) {
        rejected += 1;
        continue;
      }

      const code = codeFor(value.code);
      const domain = domainFor(value.domain ?? value.artifact, 'structure');
      const target = asRecord(value.target);
      const artifact = artifactFor(value.artifact ?? target.artifact, domain);

      const issue: ValidationIssue = {
        id: issueId(),
        code,
        severity: severityFor(value.severity),
        domain,
        message,
        autoFixable: value.autoFixable === true ? true : AUTO_FIXABLE_CODES.includes(code),
        origin: 'model',
        ...(value.details ? { details: truncate(String(value.details), 600) } : {}),
        ...(value.fixHint
          ? { fixHint: truncate(Array.isArray(value.fixHint) ? value.fixHint.join(' ') : String(value.fixHint), 400) }
          : {}),
        target: {
          artifact,
          ...(stringField(target, 'componentInstanceId') ? { componentInstanceId: stringField(target, 'componentInstanceId') } : {}),
          ...(stringField(target, 'componentId') ? { componentId: stringField(target, 'componentId') } : {}),
          ...(stringField(target, 'selectionId') ? { selectionId: stringField(target, 'selectionId') } : {}),
          ...(stringField(target, 'pin') ? { pin: stringField(target, 'pin') } : {}),
          ...(stringField(target, 'assignmentId') ? { assignmentId: stringField(target, 'assignmentId') } : {}),
          ...(stringField(target, 'connectionId') ? { connectionId: stringField(target, 'connectionId') } : {}),
          ...(stringField(target, 'filePath') ? { filePath: stringField(target, 'filePath') } : {}),
          ...(stringField(target, 'library') ? { library: stringField(target, 'library') } : {}),
          ...(stringField(target, 'sectionId') ? { sectionId: stringField(target, 'sectionId') } : {}),
        },
      };

      const signature = issueSignature(issue);
      if (ruleSignatures.has(signature)) {
        rejected += 1;
        continue;
      }
      ruleSignatures.add(signature);
      issues.push(issue);
    }

    const notes = [
      ...(typeof payload.summary === 'string' && payload.summary.trim().length > 0 ? [payload.summary.trim()] : []),
      ...asArray(payload.notes).map((note) => (typeof note === 'string' ? note.trim() : truncate(JSON.stringify(note), 300))),
    ].filter((note) => note.length > 0);

    const verdict = verdictFor(payload.verdict, issues.length);
    const confidence = confidenceFor(payload.confidence);

    handle?.complete(`Model review: ${verdict} — ${issues.length} new finding(s) beyond the rule engine.`, {
      op: 'validation',
      verdict,
      confidence,
      newIssues: issues.length,
      ignored: rejected,
      notes: notes.length,
      repaired: response.repaired,
      attempts: response.attempts,
      inputTokens: response.usage.inputTokens ?? 0,
      outputTokens: response.usage.outputTokens ?? 0,
    });

    return { issues, notes, verdict, confidence, call };
  } catch (error) {
    const described = describeError(error);
    call.status = 'failed';
    call.error = described.message;
    call.finishedAt = nowIso();
    call.durationMs = Date.now() - startedAt;
    handle?.fail(`Model review failed: ${described.message}`, described.message, { op: 'validation' });
    logger.error({ err: error, projectId: input.project.id }, 'validator: model review threw');
    return { issues: [], notes: [], verdict: 'needs_changes', confidence: 0, call, error: described.message };
  }
}
