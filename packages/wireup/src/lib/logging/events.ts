/**
 * Agent event log.
 *
 * Every meaningful backend operation emits a structured event through this
 * object. Events are the single source of truth for the frontend console:
 * loaders in the UI correspond to real in-flight operations, never fakes.
 */

import type { AgentEvent, AgentEventStatus, AgentEventType } from '@/types/generation';
import type { GenerationStage } from '@/types/project';

import { eventId } from '@/lib/validation/ids';
import { elapsedMs, nowIso, nowMs } from '@/lib/validation/time';

export type EventSink = (event: AgentEvent) => void;

export interface EmitOptions {
  stage?: GenerationStage;
  metadata?: Record<string, unknown>;
  durationMs?: number;
  id?: string;
}

export interface EventHandle {
  event: AgentEvent;
  complete(message?: string, metadata?: Record<string, unknown>): AgentEvent;
  fail(message: string, error?: unknown, metadata?: Record<string, unknown>): AgentEvent;
}

export class AgentEventLog {
  private readonly events: AgentEvent[] = [];
  private readonly sinks: EventSink[] = [];
  private seq: number;
  private readonly cap: number;

  constructor(options: { initialSeq?: number; cap?: number; sink?: EventSink } = {}) {
    this.seq = options.initialSeq ?? 0;
    this.cap = options.cap ?? 1500;
    if (options.sink) this.sinks.push(options.sink);
  }

  addSink(sink: EventSink): void {
    this.sinks.push(sink);
  }

  get currentSeq(): number {
    return this.seq;
  }

  emit(
    type: AgentEventType,
    message: string,
    options: EmitOptions & { status?: AgentEventStatus } = {},
  ): AgentEvent {
    this.seq += 1;
    const event: AgentEvent = {
      seq: this.seq,
      id: options.id ?? eventId(),
      type,
      status: options.status ?? 'info',
      message,
      timestamp: nowIso(),
      ...(options.stage ? { stage: options.stage } : {}),
      ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    };

    this.events.push(event);
    if (this.events.length > this.cap) this.events.splice(0, this.events.length - this.cap);

    for (const sink of this.sinks) {
      try {
        sink(event);
      } catch {
        // A broken sink must never abort generation.
      }
    }
    return event;
  }

  /**
   * Emit a `started` event and return a handle that closes it out with
   * `completed`/`failed` plus the real elapsed time.
   */
  start(type: AgentEventType, message: string, options: EmitOptions = {}): EventHandle {
    const startedAt = nowMs();
    const event = this.emit(type, message, { ...options, status: 'started' });
    const completedType = completedTypeFor(type);
    const failedType = failedTypeFor(type);

    return {
      event,
      complete: (completeMessage, metadata) =>
        this.emit(completedType, completeMessage ?? message.replace(/\.{3}$/, ''), {
          ...options,
          status: 'completed',
          durationMs: elapsedMs(startedAt),
          metadata: { ...options.metadata, ...metadata },
        }),
      fail: (failMessage, error, metadata) =>
        this.emit(failedType, failMessage, {
          ...options,
          status: 'failed',
          durationMs: elapsedMs(startedAt),
          metadata: {
            ...options.metadata,
            ...metadata,
            ...(error !== undefined ? { error: error instanceof Error ? error.message : String(error) } : {}),
          },
        }),
    };
  }

  list(): AgentEvent[] {
    return [...this.events];
  }

  since(afterSeq: number): AgentEvent[] {
    return this.events.filter((event) => event.seq > afterSeq);
  }

  load(events: AgentEvent[]): void {
    this.events.push(...events);
    const maxSeq = events.reduce((max, event) => Math.max(max, event.seq), this.seq);
    this.seq = maxSeq;
  }
}

function completedTypeFor(type: AgentEventType): AgentEventType {
  if (!type.endsWith('_started')) return type;
  const base = type.slice(0, -'_started'.length);
  return `${base}_completed` as AgentEventType;
}

function failedTypeFor(type: AgentEventType): AgentEventType {
  if (type === 'llm_call_started') return 'llm_call_failed';
  if (!type.endsWith('_started')) return 'generation_failed';
  const base = type.slice(0, -'_started'.length);
  return `${base}_completed` as AgentEventType;
}
