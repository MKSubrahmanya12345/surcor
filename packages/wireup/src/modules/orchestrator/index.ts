/**
 * ORCHESTRATOR MODULE.
 *
 * Owns the whole agent run for one project:
 *   create → pipeline (v1) → validate → targeted fix → revalidate → … → final
 *
 * Responsibilities:
 *   • emit and persist the real event log the UI polls;
 *   • persist every stage so partial results survive a refresh;
 *   • freeze a revision per version (v1 initial, v2+ targeted fixes);
 *   • stop cleanly on Bedrock failures, MongoDB failures, malformed model JSON
 *     and the fix-iteration cap — never spin, never lose the work.
 */

import type { GenerationStage, ProjectState } from '@/types/project';
import type { ValidationResult } from '@/types/validation';
import type { ProjectPatch } from '@/lib/mongodb/projects';

import { AgentEventLog } from '@/lib/logging/events';
import { describeError, logger } from '@/lib/logging/logger';
import { env } from '@/lib/validation/env';
import { nowIso } from '@/lib/validation/time';
import { getProjectState } from '@/lib/mongodb/projects';

import { validateProject } from '@/modules/validator';
import { fixProject } from '@/modules/fixer';

import { buildRefreshers, controllerInfo, refreshSoftware, type GenerationContext } from './context';
import { EventFlusher, persistFailure, persistLlmCall, persistState } from './persistence';
import { runPipeline } from './pipeline';
import { appendRevision, createRevision, summariseChanges } from './revisions';

/** Cap on per-issue "could not repair" events emitted per fix pass. */
const MAX_UNRESOLVED_EVENTS = 10;

export class OrchestratorError extends Error {
  readonly code: string;
  readonly stage: GenerationStage;
  readonly retryable: boolean;

  constructor(code: string, message: string, stage: GenerationStage = 'idle', retryable = false) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
    this.stage = stage;
    this.retryable = retryable;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __wireupRunning: Set<string> | undefined;
}

const running: Set<string> = globalThis.__wireupRunning ?? new Set<string>();
globalThis.__wireupRunning = running;

export function isRunning(projectId: string): boolean {
  return running.has(projectId);
}

function lastSeq(events: ProjectState['events']): number {
  return events.reduce((max, event) => Math.max(max, event.seq), 0);
}

export interface RunOptions {
  /** Called with the persisted state after every stage (used by tests/API). */
  onProgress?: (project: ProjectState) => void;
  /** Rebuild support: base revision for a replan (1 = initial generation). */
  baseRevision?: number;
  /** Why this run exists (`initial_generation` | `replanned_after_human_input`). */
  reason?: ProjectState['revisions'][number]['reason'];
  /** Trigger label for the everflow pass that follows a finalised run. */
  trigger?: string;
}

/**
 * Run the full agent pipeline for one project. Resolves with the final state;
 * failures are recorded on the project (status `failed`) rather than thrown,
 * except when the project itself cannot be loaded.
 */
export async function runGeneration(projectId: string, options: RunOptions = {}): Promise<ProjectState> {
  if (running.has(projectId)) {
    logger.warn({ projectId }, 'generation already running for this project');
    const current = await getProjectState(projectId);
    if (current) return current;
    throw new OrchestratorError('project_not_found', `Project ${projectId} does not exist.`);
  }

  const loaded = await getProjectState(projectId);
  if (!loaded) throw new OrchestratorError('project_not_found', `Project ${projectId} does not exist.`);

  running.add(projectId);
  const events = new AgentEventLog({ initialSeq: lastSeq(loaded.events) });
  const flusher = new EventFlusher(projectId);
  flusher.attach(events);
  flusher.start();

  let project: ProjectState = loaded;
  let stage: GenerationStage = 'idle';

  const persist = async (patch: ProjectPatch): Promise<void> => {
    project = await persistState(projectId, patch);
    await flusher.flush();
    options.onProgress?.(project);
  };

  try {
    await persist({ status: 'running', stage: 'understanding' });
    stage = 'understanding';

    /* ---------------- initial build (revision 1) ---------------- */
    const pipeline = await runPipeline({
      project,
      events,
      onStage: async (patch, nextStage) => {
        stage = nextStage;
        await persist(patch);
      },
    });

    const context: GenerationContext = pipeline.context;
    const catalog = context.catalog;
    project = pipeline.project;
    stage = 'instructions';

    const initialVersion = options.baseRevision ?? 1;
    const initialReason = options.reason ?? 'initial_generation';
    const initialRevision = createRevision({
      project,
      version: initialVersion,
      reason: initialReason,
      summary:
        initialReason === 'initial_generation'
          ? `Initial build: ${project.components.length} part(s), ${project.pinAssignments.length} pin assignment(s), ${project.wiring?.connections.length ?? 0} wire(s), ${project.artifacts.code?.files.length ?? 0} firmware file(s).`
          : `Replanned from the doubt session / human additions: ${project.components.length} part(s), ${project.wiring?.connections.length ?? 0} wire(s), ${project.artifacts.code?.files.length ?? 0} firmware file(s).`,
      stage: 'instructions',
    });
    project = { ...project, revisions: appendRevision(project, initialRevision) };

    await persist({
      name: project.name,
      requirements: project.requirements,
      components: project.components,
      hardwarePlan: project.hardwarePlan,
      pinAssignments: project.pinAssignments,
      wiring: project.wiring,
      softwarePlan: project.softwarePlan,
      artifacts: project.artifacts,
      revisions: project.revisions,
      revision: initialVersion,
      llm: project.llm,
      status: 'validating',
      stage: 'validating',
    });

    events.emit('revision_created', `Revision v${initialVersion} created — ${initialReason === 'initial_generation' ? 'initial generation frozen for diffing' : 'replanned after human input'}.`, {
      stage: 'validating',
      metadata: { version: initialVersion, reason: initialReason },
    });

    /* ---------------- validate / fix loop ---------------- */
    const maxIterations = Math.max(0, env().agent.maxFixIterations);
    let validation: ValidationResult | null = null;
    let lastFixApplied = 0;

    for (let iteration = 0; iteration <= maxIterations; iteration += 1) {
      stage = 'validating';
      const controller = controllerInfo(project, catalog);

      const outcome = await validateProject({
        project,
        catalog,
        catalogContext: context.fullCatalogContext,
        mcuContext: context.mcuContext,
        ...(controller.profile ? { profile: controller.profile } : {}),
        iteration,
        events,
        enableModelReview: env().agent.enableLlmValidation,
      });

      validation = outcome.result;
      if (outcome.llmCall) {
        project = { ...project, llm: { ...project.llm, calls: [...project.llm.calls, outcome.llmCall] } };
        await persistLlmCall(projectId, outcome.llmCall);
      }

      project = {
        ...project,
        validation,
        status: 'validating',
        stage: 'validating',
        iteration: { current: iteration, max: maxIterations },
      };
      await persist({ validation, iteration: project.iteration, llm: project.llm, status: 'validating', stage: 'validating' });

      if (validation.passed) {
        events.emit('info', `Validation gate passed at iteration ${iteration + 1}.`, {
          stage: 'validating',
          metadata: { iteration, warnings: validation.summary.warnings },
        });
        break;
      }

      if (iteration === maxIterations) {
        events.emit('info', `Fix-iteration cap reached (${maxIterations}) with ${validation.summary.errors} unresolved blocking issue(s) — stopping the loop and reporting the state honestly.`, {
          stage: 'fixing',
          metadata: { iteration, maxIterations, errors: validation.summary.errors, capReached: true },
        });
        break;
      }

      /* ---------------- targeted fix ---------------- */
      stage = 'fixing';
      const nextRevision = project.revision + 1;
      const baseline = project;
      const projectForFix: ProjectState = { ...project, revision: nextRevision, status: 'fixing', stage: 'fixing' };

      const fixProfile = controllerInfo(projectForFix, catalog).profile;
      const refreshers = buildRefreshers({ catalog, baseline, analysis: pipeline.analysis, events });
      const fix = await fixProject({
        project: projectForFix,
        validation,
        catalog,
        catalogContext: context.fullCatalogContext,
        mcuContext: context.mcuContext,
        ...(fixProfile ? { profile: fixProfile } : {}),
        iteration,
        events,
        enableLlmFixer: env().agent.enableLlmFixer,
        refresh: {
          ...refreshers,
          software: (candidate) => refreshSoftware(candidate, catalog, events),
        },
      });

      if (fix.llmCall) await persistLlmCall(projectId, fix.llmCall);

      /*
       * The fixer explains every issue it could not repair. Those reasons used
       * to die inside the returned object — emit them so the console (and the
       * event log) says *why* nothing changed instead of only that nothing did.
       */
      for (const entry of fix.unresolved.slice(0, MAX_UNRESOLVED_EVENTS)) {
        events.emit('info', `${entry.issue.code}: not repaired — ${entry.reason}`, {
          stage: 'fixing',
          metadata: {
            issueId: entry.issue.id,
            code: entry.issue.code,
            severity: entry.issue.severity,
            domain: entry.issue.domain,
            reason: entry.reason,
            autoFixable: entry.issue.autoFixable,
            iteration,
          },
        });
      }
      if (fix.unresolved.length > MAX_UNRESOLVED_EVENTS) {
        events.emit('info', `${fix.unresolved.length - MAX_UNRESOLVED_EVENTS} further unrepaired issue(s) — see the VALIDATION card.`, {
          stage: 'fixing',
          metadata: { truncated: true, totalUnresolved: fix.unresolved.length, iteration },
        });
      }
      const fixedProject: ProjectState = fix.llmCall
        ? { ...fix.project, llm: { ...fix.project.llm, calls: [...fix.project.llm.calls, fix.llmCall] } }
        : fix.project;

      const addressed = validation.issues
        .filter((issue) => issue.severity === 'error' || issue.autoFixable)
        .map((issue) => issue.id);

      const revision = createRevision({
        project: fixedProject,
        version: nextRevision,
        reason: 'targeted_fix',
        summary: `Fix pass ${iteration + 1}: ${summariseChanges(fix.result.changes)}${
          fix.result.rejected.length > 0 ? `; ${fix.result.rejected.length} change(s) rejected` : ''
        }.`,
        changes: fix.result.changes,
        addressedIssueIds: addressed,
        validation,
        stage: 'fixing',
      });

      project = {
        ...fixedProject,
        revision: nextRevision,
        revisions: appendRevision(fixedProject, revision),
        status: 'fixing',
        stage: 'fixing',
        iteration: { current: iteration + 1, max: maxIterations },
      };

      events.emit('revision_created', `Revision v${nextRevision} created — ${summariseChanges(fix.result.changes)}.`, {
        stage: 'fixing',
        metadata: {
          version: nextRevision,
          reason: 'targeted_fix',
          applied: fix.result.applied.length,
          rejected: fix.result.rejected.length,
          touchedArtifacts: fix.result.touchedArtifacts,
          addressedIssues: addressed.length,
        },
      });

      await persist({
        name: project.name,
        requirements: project.requirements,
        components: project.components,
        hardwarePlan: project.hardwarePlan,
        pinAssignments: project.pinAssignments,
        wiring: project.wiring,
        softwarePlan: project.softwarePlan,
        artifacts: project.artifacts,
        revisions: project.revisions,
        revision: project.revision,
        llm: project.llm,
        iteration: project.iteration,
        status: 'fixing',
        stage: 'fixing',
      });

      lastFixApplied = fix.result.applied.length;
      if (lastFixApplied === 0) {
        events.emit('info', 'The fix pass could not apply any change — stopping the loop instead of spinning.', {
          stage: 'fixing',
          metadata: { iteration, rejected: fix.result.rejected.length, unresolved: fix.unresolved.length },
        });
        break;
      }
    }

    /* ---------------- finalise ---------------- */
    const errors = validation?.summary.errors ?? 0;
    const warnings = validation?.summary.warnings ?? 0;
    const status: ProjectState['status'] =
      errors > 0 ? 'completed_with_errors' : warnings > 0 ? 'completed_with_warnings' : 'completed';

    project = { ...project, status, stage: 'completed', completedAt: nowIso() };

    /* Pipeline caveats (model outage, missing catalog parts, …) were computed
     * but never surfaced; emit them so the run explains its own compromises. */
    for (const note of pipeline.notes.slice(0, MAX_UNRESOLVED_EVENTS)) {
      events.emit('info', note, { stage: 'completed', metadata: { note: true } });
    }

    const finalMessage =
      errors > 0
        ? `Project finalised with ${errors} unresolved blocking issue(s) — revision v${project.revision}, ${warnings} warning(s). The design is usable but NOT validated clean.`
        : `Project finalised — revision v${project.revision}, ${errors} blocking issue(s), ${warnings} warning(s).`;

    events.emit('final_project_completed', finalMessage, {
      stage: 'completed',
      status: errors > 0 ? 'failed' : 'completed',
      metadata: {
        revision: project.revision,
        revisions: project.revisions.length,
        errors,
        warnings,
        infos: validation?.summary.info ?? 0,
        passed: validation?.passed ?? false,
        finalStatus: status,
        llmCalls: project.llm.calls.length,
        llmCallsFailed: project.llm.calls.filter((call) => call.status === 'failed').length,
        events: events.currentSeq,
      },
    });

    await persist({
      status,
      stage: 'completed',
      completedAt: new Date(),
      validation: project.validation,
      revision: project.revision,
      revisions: project.revisions,
      components: project.components,
      pinAssignments: project.pinAssignments,
      wiring: project.wiring,
      hardwarePlan: project.hardwarePlan,
      softwarePlan: project.softwarePlan,
      artifacts: project.artifacts,
      llm: project.llm,
      iteration: project.iteration,
      error: null,
    });

    /*
     * EVERFLOW — the run is not the end: evaluate the project graph and file
     * the asks only a human can close (confirm assumptions, verify behaviour
     * in the simulator). Best-effort: a failure here never fails the run.
     */
    try {
      const { continueEverflow, mongoEverflowStore } = await import('@/modules/everflow');
      // The bounded loop, not a single pass: the build hands over to the idea
      // graph and it keeps making progress (expansions, stop decisions) until
      // it runs out of progress or pauses on a human ask — never unbounded.
      const pass = await continueEverflow(projectId, options.trigger ?? 'generation_finalised', mongoEverflowStore(), {
        maxPasses: env().agent.everflowMaxPasses,
        maxHumanTasks: env().agent.everflowMaxHumanTasks,
      });
      if (pass) {
        logger.info(
          {
            projectId,
            completion: Math.round(pass.evaluation.completion * 100),
            done: pass.evaluation.done,
            blockedOnHuman: pass.evaluation.blockedOnHuman,
            tasksFiled: pass.plan.newTasks.length + pass.plan.followUps.length,
          },
          'everflow pass after finalisation',
        );
      }
    } catch (error) {
      logger.warn({ err: describeError(error).message, projectId }, 'everflow pass after finalisation failed (non-fatal)');
    }

    logger.info(
      {
        projectId,
        status,
        revision: project.revision,
        errors,
        warnings,
        llmCalls: project.llm.calls.length,
        llmCallsFailed: project.llm.calls.filter((call) => call.status === 'failed').length,
      },
      'generation finished',
    );
    return project;
  } catch (error) {
    const described = describeError(error);
    const isPersistence = described.name === 'PersistenceError' || /persist|mongo/i.test(described.message);
    const failure = {
      stage,
      code: isPersistence ? 'persistence_failed' : described.name === 'BedrockError' ? 'bedrock_failed' : 'generation_failed',
      message: described.message,
      ...(described.stack ? { details: described.stack.split('\n').slice(0, 4).join(' | ') } : {}),
      occurredAt: nowIso(),
      retryable: isPersistence,
    };

    events.emit('generation_failed', `Generation failed during ${stage}: ${described.message}`, {
      stage,
      status: 'failed',
      metadata: { code: failure.code, error: described.message, retryable: failure.retryable },
    });

    logger.error({ err: error, projectId, stage }, 'generation failed');

    await persistFailure(projectId, failure);

    return { ...project, status: 'failed', stage: 'failed', error: failure };
  } finally {
    /*
     * Guaranteed teardown. A projectId left in `running` makes every later
     * runGeneration() return the stale state without ever regenerating, and a
     * flusher left attached keeps a timer alive for a finished run — so both
     * are released here no matter how the run exited (success, failure, or an
     * unexpected throw inside the finalisation itself).
     */
    try {
      await flusher.stop();
    } catch (error) {
      logger.warn({ err: describeError(error).message, projectId }, 'event flusher stop failed');
    }
    running.delete(projectId);
  }
}

/**
 * Fire-and-forget entry point used by the API: the HTTP response returns
 * immediately with the new project id while the agent runs in the background.
 */
export function startGeneration(projectId: string, options: RunOptions = {}): void {
  void runGeneration(projectId, options).catch((error) => {
    logger.error({ err: error, projectId }, 'background generation crashed');
  });
}

export { runPipeline } from './pipeline';
export { buildGenerationContext, buildRefreshers, controllerInfo, deriveLinks } from './context';
export { EventFlusher, PersistenceError, persistFailure, persistLlmCall, persistState } from './persistence';
export { appendRevision, createRevision, snapshotOf, summariseChanges } from './revisions';
