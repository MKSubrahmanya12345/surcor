import { mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CadFailure, CadModelResult, CadProgressEvent, ServerMessage } from "@forge/shared";
import type { CadConfig } from "./config";
import { createMacClient, type MacClient, type MacRunOutcome } from "./macClient";
import { gateMacOutcome, shouldStartNewJob, type GateDecision } from "./qualityGate";
import { findExistingModel, type SearchOptions } from "./searchExisting";
import { convertStepToGlb, looksLikeGlb } from "./convertToGlb";

/**
 * The whole CAD request, in one place:
 *
 *   search for a real file ──found & OpenCASCADE-readable──▶ convert → show
 *            │
 *            └─nothing usable─▶ MAC generate ──▶ quality gate ──clean──▶ convert → show
 *                                        ▲                    │
 *                                        └── its own 10s ─────┤ QA fail ⇒ HARD STOP
 *                                            iteration        ▼
 *                                            checkpoint   "couldn't do it to spec"
 *
 * Two rules hold across every branch:
 *   1. A model is only shown after it was read by a geometry kernel (the shared
 *      STEP→GLB conversion) — and, on the generated path, after MAC's own QA
 *      verdict came back clean with zero unresolved diagnostics.
 *   2. Anything that fails those checks produces a specific failure, never a
 *      fallback: not the best of N attempts, not a box, not an empty viewer.
 */

/** Only infrastructure deaths get a fresh job; a QA verdict is final. */
const MAX_JOBS_PER_REQUEST = 2;

export interface CadPipelineOptions {
  prompt: string;
  config: CadConfig;
  /** Receives every `cad_progress` / `cad_model_ready` / `cad_generation_failed`. */
  emit: (message: ServerMessage) => void;
  signal?: AbortSignal;
  /** Test seams. */
  client?: MacClient;
  fetchImpl?: typeof fetch;
  /** Folder name under `config.artifactDir`; a uuid when omitted. */
  requestId?: string;
  /** Raw MAC stream events, for logs/tests. */
  onRawEvent?: (event: Record<string, unknown>) => void;
  /** Search backend seam (defaults to Prompt 5's `web_search` implementation). */
  searchImpl?: SearchOptions["searchImpl"];
}

export interface CadPipelineOutcome {
  requestId: string;
  result?: CadModelResult;
  failure?: CadFailure;
  notes: string[];
  /** MAC's diagnostics, kept for the failure card and the log. */
  diagnostics?: { errorType: string; iterations: number; missed: string[] };
  cancelled: boolean;
}

export async function runCadPipeline(options: CadPipelineOptions): Promise<CadPipelineOutcome> {
  const { config, prompt, signal } = options;
  const requestId = options.requestId ?? crypto.randomUUID();
  const artifactDir = join(config.artifactDir, requestId);
  const notes: string[] = [];
  await mkdir(artifactDir, { recursive: true });

  const progress = (stage: CadProgressEvent["stage"], detail: string): void => {
    options.emit({ type: "cad_progress", event: { stage, detail } });
  };
  const fail = (reason: string, stage: CadProgressEvent["stage"], extra: Partial<CadPipelineOutcome> = {}): CadPipelineOutcome => {
    const failure: CadFailure = { reason, stage };
    options.emit({ type: "cad_generation_failed", failure });
    return { requestId, failure, notes, cancelled: signal?.aborted === true, ...extra };
  };

  if (!config.enabled) {
    return fail("CAD mode is disabled (FORGE_CAD_ENABLED=false in packages/server/.env).", "searching_existing");
  }

  // ---- 1. search for a real, downloadable, verifiable file --------------
  const search = await findExistingModel(prompt, {
    config, artifactDir, signal, fetchImpl: options.fetchImpl, searchImpl: options.searchImpl,
    emit: (event) => options.emit({ type: "cad_progress", event }),
  });
  notes.push(...search.notes);
  if (search.model) {
    const model = search.model;
    // The search path already had to pass the shared converter to be accepted,
    // so the GLB exists; re-verify it is readable rather than assuming.
    let glbPath = model.glbPath;
    if (!(await looksLikeGlb(glbPath))) {
      progress("converting", "re-running STEP→GLB on the downloaded file");
      const conversion = await convertStepToGlb(model.stepPath, artifactDir, config, { name: "model", signal });
      if (!conversion.ok || !conversion.glbPath) {
        return fail(`An existing model file was found and structurally validated, but could not be triangulated for preview: ${conversion.error ?? "no GLB produced"}`, "converting");
      }
      glbPath = conversion.glbPath;
    }
    const result: CadModelResult = {
      source: "existing_model",
      glbPath,
      stepPath: model.stepPath,
      sourceUrl: model.sourceUrl,
    };
    progress("converting", `verified existing model — ${model.summary}`);
    options.emit({ type: "cad_model_ready", result });
    return { requestId, result, notes, cancelled: false };
  }

  // ---- 2. MAC, through its own iteration loop and Forge's quality gate ----
  const client = options.client ?? createMacClient(config, options.fetchImpl);
  let decision: GateDecision | null = null;
  let lastOutcome: MacRunOutcome | null = null;
  let jobsStarted = 0;

  for (;;) {
    jobsStarted += 1;
    const iterator = client.generate(prompt, {
      artifactDir, signal, onRawEvent: options.onRawEvent,
    });
    let step = await iterator.next();
    while (!step.done) {
      progress(step.value.stage, step.value.detail);
      step = await iterator.next();
    }
    const outcome = step.value;
    lastOutcome = outcome;

    if (outcome.cancelled || signal?.aborted) {
      return fail("Cancelled — the MAC job was stopped at an iteration checkpoint, so no model was shown.", "qa_pass", {
        diagnostics: { errorType: outcome.errorType, iterations: outcome.iterations, missed: outcome.missedEntries },
      });
    }

    decision = await gateMacOutcome(
      { outcome, prompt, attemptsAllowed: config.attemptBudget },
      { rejectTrivialPrimitive: config.rejectTrivialPrimitive },
    );
    if (decision.passed) {
      notes.push(...decision.notes);
      break;
    }
    notes.push(...decision.notes);
    const retry = shouldStartNewJob({ decision, jobsStarted, maxJobs: MAX_JOBS_PER_REQUEST });
    if (!retry.retry) {
      return fail(decision.failure.reason, decision.failure.stage, {
        diagnostics: { errorType: outcome.errorType, iterations: outcome.iterations, missed: outcome.missedEntries },
      });
    }
    progress("qa_pass", `${decision.failure.reason} — ${retry.reason} (job ${jobsStarted + 1}/${MAX_JOBS_PER_REQUEST})`);
  }

  const gate = decision;
  if (!gate || !gate.passed || !lastOutcome?.stepPath) {
    return fail("Internal error: the gate reported a pass without a model.", "qa_pass");
  }

  // ---- 3. one conversion path, whichever branch produced the STEP --------
  progress("converting", `converting the verified STEP to GLB for preview${lastOutcome.sidecarGlbPath ? " (sidecar render held in reserve)" : ""}`);
  const stepPath = await normalizeStepName(lastOutcome.stepPath, artifactDir);
  const conversion = await convertStepToGlb(stepPath, artifactDir, config, {
    name: "model", signal, fallbackGlbPath: lastOutcome.sidecarGlbPath ?? null,
  });
  if (!conversion.ok || !conversion.glbPath) {
    return fail(`MAC's QA passed but the model could not be prepared for preview: ${conversion.error ?? "no GLB produced"}`, "converting", {
      diagnostics: { errorType: lastOutcome.errorType, iterations: lastOutcome.iterations, missed: lastOutcome.missedEntries },
    });
  }
  if (conversion.method === "sidecar-glb") notes.push(conversion.detail);

  const result: CadModelResult = {
    source: "generated",
    glbPath: conversion.glbPath,
    stepPath,
    ...(lastOutcome.stlPath ? { stlPath: lastOutcome.stlPath } : {}),
  };
  progress("converting", `${conversion.detail} · ${gate.detail}`);
  options.emit({ type: "cad_model_ready", result });
  return {
    requestId,
    result,
    notes,
    cancelled: false,
    diagnostics: { errorType: lastOutcome.errorType, iterations: lastOutcome.iterations, missed: lastOutcome.missedEntries },
  };
}

/**
 * The sidecar writes `temp_output_N.step`; Forge keeps one canonical name per
 * request so the artifact route, the Download buttons and a later re-open all
 * agree on where the model is.
 */
async function normalizeStepName(stepPath: string, artifactDir: string): Promise<string> {
  const target = join(artifactDir, "model.step");
  if (stepPath === target) return target;
  const info = await stat(stepPath).catch(() => null);
  if (!info) return stepPath;
  try {
    await rename(stepPath, target);
    return target;
  } catch {
    return stepPath;
  }
}
