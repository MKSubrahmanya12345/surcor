/**
 * Revision bookkeeping.
 *
 * A revision is a frozen snapshot of the artifacts at a point in the pipeline:
 * v1 is the initial generation, every later version is a targeted fix. Nothing
 * is ever overwritten in place — the UI can show exactly what changed.
 */

import type { FixChange } from '@/types/generation';
import type { ProjectRevision, ProjectState, RevisionSnapshot } from '@/types/project';
import type { ValidationResult } from '@/types/validation';

import { env } from '@/lib/validation/env';
import { nowIso } from '@/lib/validation/time';

export function snapshotOf(project: ProjectState): RevisionSnapshot {
  return {
    components: project.components,
    pinAssignments: project.pinAssignments,
    wiring: project.wiring,
    code: project.artifacts.code,
    diagram: project.artifacts.diagram,
    libraries: project.artifacts.libraries,
    instructions: project.artifacts.instructions,
    assembly: project.assembly,
  };
}

export interface CreateRevisionInput {
  project: ProjectState;
  version: number;
  reason: ProjectRevision['reason'];
  summary: string;
  changes?: FixChange[];
  addressedIssueIds?: string[];
  validation?: ValidationResult | null;
  stage?: ProjectRevision['stage'];
}

export function createRevision(input: CreateRevisionInput): ProjectRevision {
  return {
    version: input.version,
    reason: input.reason,
    createdAt: nowIso(),
    summary: input.summary,
    stage: input.stage ?? input.project.stage,
    changes: input.changes ?? [],
    addressedIssueIds: input.addressedIssueIds ?? [],
    validation: input.validation
      ? {
          passed: input.validation.passed,
          errors: input.validation.summary.errors,
          warnings: input.validation.summary.warnings,
        }
      : null,
    snapshot: snapshotOf(input.project),
  };
}

/** Append a revision, keeping the list inside `WIREUP_MAX_REVISIONS`. */
export function appendRevision(project: ProjectState, revision: ProjectRevision): ProjectRevision[] {
  const max = Math.max(1, env().agent.maxRevisions);
  const next = [...project.revisions.filter((entry) => entry.version !== revision.version), revision].sort(
    (a, b) => a.version - b.version,
  );
  if (next.length <= max) return next;

  // Always keep the initial generation plus the most recent revisions.
  const initial = next.filter((entry) => entry.version === 1);
  const recent = next.slice(next.length - (max - initial.length));
  return [...initial, ...recent.filter((entry) => entry.version !== 1)];
}

/** Short human summary of what a fix pass changed. */
export function summariseChanges(changes: FixChange[]): string {
  if (changes.length === 0) return 'no artifact changes';
  const counts = new Map<string, number>();
  for (const change of changes) counts.set(change.op, (counts.get(change.op) ?? 0) + 1);
  const parts = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([op, count]) => `${count} × ${op}`);
  return parts.join(', ');
}
