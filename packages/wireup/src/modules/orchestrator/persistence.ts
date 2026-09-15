/**
 * Persistence helpers for the orchestrator.
 *
 * The event log lives in MongoDB and is polled by the UI, so events are flushed
 * on a short interval *and* at every stage boundary. State writes are fatal (a
 * project we cannot store is a failed project); bookkeeping writes are not.
 */

import type { AgentEvent } from '@/types/generation';
import type { AgentEventLog } from '@/lib/logging/events';
import type { LlmCallRecord, ProjectState } from '@/types/project';

import { describeError, logger } from '@/lib/logging/logger';
import { appendEvents, markProjectFailed, recordLlmCall, saveProjectState, type ProjectPatch } from '@/lib/mongodb/projects';

export class PersistenceError extends Error {
  readonly code = 'persistence_failed';
  readonly retryable = false;
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PersistenceError';
    this.cause = cause;
  }
}

/** Batches agent events into MongoDB so the console stays live. */
export class EventFlusher {
  private readonly queue: AgentEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> | null = null;
  private failures = 0;

  constructor(
    private readonly projectId: string,
    private readonly intervalMs = 700,
  ) {}

  get pending(): number {
    return this.queue.length;
  }

  /** Every event emitted through this log will be queued for persistence. */
  attach(log: AgentEventLog): void {
    log.addSink((event) => {
      this.queue.push(event);
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.intervalMs);
    // Never keep the Node event loop alive just for this timer.
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref?.();
  }

  async flush(): Promise<number> {
    if (this.queue.length === 0) return 0;
    if (this.flushing) {
      await this.flushing;
      return 0;
    }

    const batch = this.queue.splice(0, this.queue.length);
    this.flushing = (async () => {
      try {
        await appendEvents(this.projectId, batch);
      } catch (error) {
        this.failures += 1;
        // Put the events back so a later flush can retry them.
        this.queue.unshift(...batch);
        logger.warn({ err: error, projectId: this.projectId, events: batch.length }, 'event flush failed (will retry)');
      } finally {
        this.flushing = null;
      }
    })();
    await this.flushing;
    return batch.length;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    if (this.failures > 0) {
      logger.warn({ projectId: this.projectId, failures: this.failures, pending: this.queue.length }, 'some agent events could not be persisted');
    }
  }
}

/** Fatal state write — throws `PersistenceError` when MongoDB refuses. */
export async function persistState(id: string, patch: ProjectPatch): Promise<ProjectState> {
  try {
    const saved = await saveProjectState(id, patch);
    if (!saved) throw new PersistenceError(`Project ${id} disappeared while being updated.`);
    return saved;
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    const described = describeError(error);
    logger.error({ err: error, projectId: id }, 'failed to persist project state');
    throw new PersistenceError(`Could not persist project state: ${described.message}`, error);
  }
}

/** Best-effort bookkeeping write (never aborts generation). */
export async function persistLlmCall(id: string, call: LlmCallRecord | undefined): Promise<void> {
  if (!call) return;
  try {
    await recordLlmCall(id, call);
  } catch (error) {
    logger.warn({ err: error, projectId: id, op: call.op }, 'could not record LLM call');
  }
}

/** Best-effort failure marker used when the pipeline dies. */
export async function persistFailure(id: string, error: NonNullable<ProjectState['error']>): Promise<void> {
  try {
    await markProjectFailed(id, error);
  } catch (innerError) {
    logger.error({ err: innerError, projectId: id }, 'could not mark the project as failed');
  }
}
