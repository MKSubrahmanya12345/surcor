/**
 * Stalled-run recovery.
 *
 * Generation runs in the same Node process that accepted the request. If that
 * process restarts (deploy, crash, dev-server reload) mid-run, the project
 * document is left in a non-terminal status with nobody working on it — the UI
 * would poll forever.
 *
 * A run is considered interrupted when *all* of these hold:
 *   1. its status is non-terminal (`pending`/`running`/`validating`/`fixing`),
 *   2. no in-process run owns it (`isRunning(id) === false`),
 *   3. it has not been written to for `RECOVERY_GRACE_MS`.
 *
 * Condition 3 only exists to cover the short window between "document created"
 * and "run registered" after `POST /api/projects`; a live run always satisfies
 * condition 2, however long a model call takes.
 */

import type { AgentEvent } from '@/types/generation';
import type { GenerationError, ProjectState, ProjectStatus } from '@/types/project';

import { createLogger } from '@/lib/logging/logger';
import { appendEvents, markProjectFailed } from '@/lib/mongodb/projects';
import { eventId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';

import { isRunning } from './index';

const logger = createLogger('orchestrator:recovery');

export const INTERRUPTED_STATUSES: ProjectStatus[] = ['pending', 'running', 'validating', 'fixing'];

/** Grace period covering create → run registration. */
export const RECOVERY_GRACE_MS = 15_000;

/** The subset of a project needed to decide (both project reads provide it). */
export interface StalledCandidate {
  id: string;
  status: ProjectStatus;
  stage: ProjectState['stage'];
  events: AgentEvent[];
  updatedAt: string;
  /** Highest known seq — the event read may be filtered by an `after` cursor. */
  latestSeq?: number;
}

/** Guard against two concurrent polls recovering the same project twice. */
const inFlight = new Set<string>();

export function isStalled(project: StalledCandidate, now = Date.now()): boolean {
  if (!INTERRUPTED_STATUSES.includes(project.status)) return false;
  if (isRunning(project.id)) return false;
  const updated = new Date(project.updatedAt).getTime();
  if (Number.isNaN(updated)) return false;
  return now - updated > RECOVERY_GRACE_MS;
}

/**
 * Mark an interrupted run as failed, appending a real event so the console
 * explains why it stopped. Returns the updated state, or `null` when there was
 * nothing to recover (or recovery itself failed — never throws).
 */
export async function recoverStalledProject(project: StalledCandidate): Promise<ProjectState | null> {
  if (!isStalled(project)) return null;
  if (inFlight.has(project.id)) return null;

  inFlight.add(project.id);
  try {
    const occurredAt = nowIso();
    const error: GenerationError = {
      stage: project.stage === 'idle' ? 'generating' : project.stage,
      code: 'run_interrupted',
      message:
        `Generation stopped at stage "${project.stage}" (status "${project.status}") and no process owns this run any more — ` +
        'the server was restarted or crashed while the project was being built.',
      details: 'Nothing is cached or reused: submit the same prompt again to start a fresh project.',
      occurredAt,
      retryable: true,
    };

    const event: AgentEvent = {
      seq: Math.max(project.events.reduce((max, entry) => Math.max(max, entry.seq), 0), project.latestSeq ?? 0) + 1,
      id: eventId(),
      type: 'generation_failed',
      status: 'failed',
      message: error.message,
      timestamp: occurredAt,
      stage: error.stage,
      metadata: {
        code: error.code,
        previousStatus: project.status,
        previousStage: project.stage,
        detectedBy: 'stalled-run recovery',
      },
    };

    await appendEvents(project.id, [event]);
    const failed = await markProjectFailed(project.id, error);
    logger.warn('marked an interrupted run as failed', {
      projectId: project.id,
      stage: project.stage,
      previousStatus: project.status,
    });
    return failed;
  } catch (error) {
    logger.error('stalled-run recovery failed', { projectId: project.id, error });
    return null;
  } finally {
    inFlight.delete(project.id);
  }
}
