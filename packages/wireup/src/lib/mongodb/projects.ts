/**
 * Project repository — in-process store backed by the pluggable persistence
 * sink (Forge's SQLite), replacing the MongoDB variant.
 *
 * Same exported surface and shapes as the original `@/lib/mongodb/projects` so
 * every caller (orchestrator, everflow, …) keeps working untouched. Data
 * survives restarts when a sink is registered — otherwise it is memory-only
 * and says so on the project's first event.
 */

import type { AgentEvent } from '@/types/generation';
import type { ExpandedBrief, EverflowState, HumanTask, ProjectDoubt, ResearchFinding } from '@/types/everflow';
import type { ChatMessage, ProjectArtifacts, ProjectState, ProjectStatus } from '@/types/project';
import type { ProjectAtlasState } from '@/types/project-atlas';

import { createLogger, describeError } from '@/lib/logging/logger';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import {
  memoryAppendEvents,
  memoryCreateProject,
  memoryDeleteProject,
  memoryGetProject,
  memoryListProjects,
  memorySaveProject,
  clone,
} from '@/lib/store/memory';
import { getPersistenceSink, hasPersistenceSink, hydrateIfNeeded } from '@/lib/store/persistence';

const logger = createLogger('wireup:store:projects');

export type ProjectPatch = Record<string, unknown>;

type RawProject = Record<string, unknown> & { _id: string };

const EMPTY_ARTIFACTS: ProjectArtifacts = {
  code: null,
  diagram: null,
  libraries: null,
  instructions: null,
};

const EMPTY_EVERFLOW: EverflowState = { graph: null, evaluation: null, pass: 0 };

function iso(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/** Convert a raw document into the API/frontend DTO (Dates may be strings). */
export function serializeProject(raw: RawProject | undefined | null): ProjectState {
  const safe = raw ?? ({} as RawProject);
  const id = typeof safe._id === 'string' ? safe._id : 'unknown';

  return {
    id,
    name: typeof safe.name === 'string' ? safe.name : 'Untitled project',
    prompt: typeof safe.prompt === 'string' ? safe.prompt : '',
    status: (safe.status as ProjectStatus) ?? 'pending',
    stage: (safe.stage as ProjectState['stage']) ?? 'idle',
    createdAt: iso(safe.createdAt) ?? nowIso(),
    updatedAt: iso(safe.updatedAt) ?? nowIso(),
    completedAt: iso(safe.completedAt),
    error: (safe.error as ProjectState['error']) ?? null,
    requirements: (safe.requirements as ProjectState['requirements']) ?? null,
    components: Array.isArray(safe.components) ? safe.components : [],
    hardwarePlan: (safe.hardwarePlan as ProjectState['hardwarePlan']) ?? null,
    pinAssignments: Array.isArray(safe.pinAssignments) ? safe.pinAssignments : [],
    wiring: (safe.wiring as ProjectState['wiring']) ?? null,
    softwarePlan: (safe.softwarePlan as ProjectState['softwarePlan']) ?? null,
    assembly: (safe.assembly as ProjectState['assembly']) ?? null,
    artifacts: { ...EMPTY_ARTIFACTS, ...(safe.artifacts as ProjectArtifacts | undefined) },
    validation: (safe.validation as ProjectState['validation']) ?? null,
    revisions: Array.isArray(safe.revisions) ? safe.revisions : [],
    events: Array.isArray(safe.events) ? safe.events : [],
    iteration: (safe.iteration as ProjectState['iteration']) ?? { current: 0, max: envMaxFixIterations() },
    llm: {
      model: typeof safe.model === 'string' ? safe.model : undefined,
      validationModel: typeof safe.validationModel === 'string' ? safe.validationModel : undefined,
      calls: Array.isArray((safe.llm as { calls?: unknown[] } | undefined)?.calls)
        ? ((safe.llm as { calls: unknown[] }).calls as ProjectState['llm']['calls'])
        : [],
    },
    chat: Array.isArray(safe.chat) ? safe.chat as ChatMessage[] : [],
    revision: typeof safe.revision === 'number' ? safe.revision : 0,
    doubts: Array.isArray(safe.doubts) ? safe.doubts as ProjectDoubt[] : [],
    humanTasks: Array.isArray(safe.humanTasks) ? safe.humanTasks as HumanTask[] : [],
    everflow: { ...EMPTY_EVERFLOW, ...(safe.everflow as EverflowState | undefined) },
    intakeContext: typeof safe.intakeContext === 'string' ? safe.intakeContext : null,
    expandedBrief: (safe.expandedBrief as ExpandedBrief | null) ?? null,
    research: Array.isArray(safe.research) ? safe.research as ResearchFinding[] : [],
    ideaGraph: (safe.ideaGraph as ProjectState['ideaGraph']) ?? null,
    atlas: (safe.atlas as ProjectAtlasState | null) ?? null,
  };
}

function envMaxFixIterations(): number {
  try {
    return requireMaxFixIterations();
  } catch {
    return 3;
  }
}

import { env as loadEnv } from '@/lib/validation/env';
function requireMaxFixIterations(): number {
  return loadEnv().agent.maxFixIterations;
}

export interface CreateProjectInput {
  prompt: string;
  name?: string;
  maxIterations?: number;
  notice?: string;
  eventMetadata?: Record<string, unknown>;
}

function flushProject(id: string): void {
  const sink = getPersistenceSink();
  if (!sink) return;
  const doc = memoryGetProject(id);
  if (doc) sink.saveProject(id, doc as unknown as Record<string, unknown>);
}

export async function createProjectRecord(input: CreateProjectInput): Promise<ProjectState> {
  hydrateIfNeeded();

  const survives = hasPersistenceSink();
  const memoryNotice =
    input.notice
      ?? (survives
        ? 'Project created — generation queued'
        : 'Project created on the IN-MEMORY store — no persistence sink is registered, so this project is lost when the server restarts.');

  const doc = memoryCreateProject({
    prompt: input.prompt,
    name: input.name ?? 'Untitled project',
    status: 'pending',
    stage: 'idle',
    error: null,
    requirements: null,
    components: [],
    hardwarePlan: null,
    pinAssignments: [],
    wiring: null,
    softwarePlan: null,
    artifacts: EMPTY_ARTIFACTS,
    validation: null,
    revisions: [],
    events: [
      {
        seq: 1,
        id: createId('evt'),
        type: 'project_created',
        status: 'completed',
        message: memoryNotice,
        timestamp: nowIso(),
        stage: 'idle',
        metadata: { promptLength: input.prompt.length, ...(input.eventMetadata ?? {}), ...(survives ? {} : { store: 'memory' }) },
      },
    ],
    iteration: { current: 0, max: input.maxIterations ?? envMaxFixIterations() },
    llm: { calls: [] },
    revision: 0,
    doubts: [],
    humanTasks: [],
    everflow: EMPTY_EVERFLOW,
    intakeContext: null,
    expandedBrief: null,
    research: [],
    atlas: null,
  });

  flushProject(doc._id);
  logger.info('project created (wireup store)', { id: doc._id, persistent: survives });
  return serializeProject(doc as unknown as RawProject);
}

export async function getProjectState(id: string): Promise<ProjectState | null> {
  hydrateIfNeeded();
  const raw = memoryGetProject(id);
  return raw ? serializeProject(raw as unknown as RawProject) : null;
}

export async function listProjectStates(limit = 25): Promise<ProjectState[]> {
  hydrateIfNeeded();
  return memoryListProjects(limit).map((raw) => serializeProject(raw as unknown as RawProject));
}

export async function saveProjectState(id: string, patch: Record<string, unknown>): Promise<ProjectState | null> {
  hydrateIfNeeded();
  const raw = memorySaveProject(id, patch);
  if (!raw) return null;
  flushProject(id);
  return serializeProject(raw as unknown as RawProject);
}

/** Append events while enforcing the per-project cap. */
export async function appendEvents(id: string, events: AgentEvent[], cap?: number): Promise<void> {
  if (events.length === 0) return;
  hydrateIfNeeded();
  memoryAppendEvents(id, events, cap ?? envMaxEvents());
  flushProject(id);
}

import { env as loadEnvForMax } from '@/lib/validation/env';
function envMaxEvents(): number {
  const env = loadEnvForMax();
  return env.agent.maxEvents;
}

export async function recordLlmCall(
  id: string,
  call: ProjectState['llm']['calls'][number],
): Promise<void> {
  hydrateIfNeeded();
  const raw = memoryGetProject(id);
  if (!raw) return;
  const existing = Array.isArray((raw.llm as { calls?: unknown[] } | undefined)?.calls)
    ? (raw.llm as { calls: unknown[] }).calls
    : [];
  memorySaveProject(id, { llm: { ...(raw.llm as object | undefined), calls: [...existing, clone(call)] } });
  flushProject(id);
}

export async function markProjectFailed(
  id: string,
  error: NonNullable<ProjectState['error']>,
): Promise<ProjectState | null> {
  return saveProjectState(id, { status: 'failed', stage: 'failed', error, completedAt: new Date() });
}

/** Projects that died mid-run (process restart) so the UI can explain them. */
export async function findStalledProjects(maxAgeMs = 10 * 60_000): Promise<ProjectState[]> {
  hydrateIfNeeded();
  const cutoff = Date.now() - maxAgeMs;
  return memoryListProjects(50)
    .filter((raw) => {
      const status = String(raw.status);
      return ['pending', 'running', 'validating', 'fixing'].includes(status) && toMillis(raw.updatedAt) < cutoff;
    })
    .map((raw) => serializeProject(raw as unknown as RawProject));
}

function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? Infinity : parsed.getTime();
  }
  return Infinity;
}

/** Lightweight polling read for the agent console: only the event log plus the
 * few fields the UI needs to decide whether to keep polling. */
export async function getProjectEvents(
  id: string,
  after = 0,
): Promise<{
  events: AgentEvent[];
  latestSeq: number;
  status: ProjectStatus;
  stage: ProjectState['stage'];
  revision: number;
  updatedAt: string;
} | null> {
  hydrateIfNeeded();
  const raw = memoryGetProject(id);
  if (!raw) return null;
  const events = Array.isArray(raw.events) ? raw.events : [];
  const latestSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
  return {
    events: after > 0 ? events.filter((event) => event.seq > after) : events,
    latestSeq,
    status: raw.status as ProjectStatus,
    stage: raw.stage as ProjectState['stage'],
    revision: typeof raw.revision === 'number' ? raw.revision : 1,
    updatedAt: iso(raw.updatedAt) ?? nowIso(),
  };
}

export async function deleteProject(id: string): Promise<boolean> {
  hydrateIfNeeded();
  const deleted = memoryDeleteProject(id);
  if (deleted) {
    const sink = getPersistenceSink();
    sink?.deleteProject(id);
  }
  return deleted;
}