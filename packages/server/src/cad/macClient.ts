import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CadProgressEvent } from "@forge/shared";
import type { CadConfig } from "./config";

/**
 * HTTP client for the MAC sidecar.
 *
 * The endpoint shapes below are NOT invented: they were read out of the
 * sidecar's own FastAPI routes (`sidecars/multi-agent-cad/multi_agent_cad/web/
 * server.py` — note: `web/server.py`, not the `web.py` the prompt predicted) in
 * Part A step 5:
 *
 *   POST /api/run                        {prompt, config, workflow, api_key} → {job_id}
 *   GET  /api/jobs/{id}/events           SSE of the runner's NDJSON (stage records,
 *                                        live-preview notices, `done`, `error`)
 *   GET  /api/jobs/{id}/result           the final record, or {"status":"running"}
 *   GET  /api/jobs/{id}/files/{name}     model.step | model.stl | model.glb |
 *                                        source.py | measurements.json | missed.json
 *                                        | live.glb
 *   POST /api/jobs/{id}/cancel           SIGTERM the runner, harvest partial artifacts
 *   GET  /api/health                     {"status":"ok"}
 *   GET  /api/config/schema              editable config fields + provider presets
 *
 * The runner (`multi_agent_cad/web_runner.py`) finishes with one `done` record
 * carrying absolute sidecar-side paths for STEP/STL/GLB/source.py/measurements
 * and — critically — `missed` (the `temp_missed_N.json` diagnostics) plus
 * MAC's own `error_type` verdict. Forge never trusts a model without both.
 */

export type MacStage = "planner" | "architect" | "coder" | "autonomous_skill_loop" | "unknown";

export interface MacDiagnostics {
  /** Raw entries of `temp_missed_N.json`: "FILLET_FAILED: …", "MISSED_CUT: …". */
  missedEntries: string[];
  /** `temp_measurements_N.json` — the white-box feature measurements QA used. */
  measurements: unknown | null;
  /** True when the sidecar had no diagnostics file at all (MAC writes one only on trouble). */
  diagnosticsMissing: boolean;
}

export interface MacRunOutcome extends MacDiagnostics {
  jobId: string;
  ok: boolean;
  /** MAC's own routing verdict: none | dimension | topology | fatal | CANCELLED_BY_USER. */
  errorType: string;
  /** QA passes MAC actually ran, from its iteration counter. */
  iterations: number;
  tokens?: number;
  apiCalls?: number;
  /** Sidecar-absolute paths as reported by MAC (informational; local paths are authoritative). */
  remoteStepPath?: string;
  /** Artifacts downloaded into Forge's CAD cache for this request. */
  stepPath?: string;
  stlPath?: string;
  sidecarGlbPath?: string;
  sourcePyPath?: string;
  /** Specific reason the run produced nothing usable. */
  failure?: string;
  /**
   * Infra failure (sidecar crashed / timed out / refused) rather than a QA
   * failure. Only `true` lets a caller start a new job at all; a QA failure is
   * always a hard stop so no unverified model can slip through on a technicality.
   */
  retriable: boolean;
  /** `true` when the user cancelled. */
  cancelled?: boolean;
  /** Last few runner log lines, kept for the failure card. */
  logTail: string[];
}

interface MacDoneRecord {
  done?: boolean;
  cancelled?: boolean;
  error_type?: string;
  step?: string | null;
  stl?: string | null;
  glb?: string | null;
  py?: string | null;
  measurements?: string | null;
  missed?: string | null;
  tokens?: number | null;
  api_calls?: number | null;
  error?: string;
  traceback?: string;
  rc?: number;
}

const STAGE_LABELS: Record<MacStage, string> = {
  planner: "Spec Planner",
  architect: "Geometric Architect",
  coder: "Python Coder",
  autonomous_skill_loop: "Autonomous QA/repair loop",
  unknown: "MAC",
};

const STAGE_TO_EVENT: Record<MacStage, CadProgressEvent["stage"]> = {
  planner: "spec_planning",
  architect: "architecting",
  coder: "coding",
  autonomous_skill_loop: "qa_pass",
  unknown: "spec_planning",
};

/** MAC names its LangGraph nodes; anything unexpected still has to render. */
function asStage(value: string): MacStage {
  return value === "planner" || value === "architect" || value === "coder" || value === "autonomous_skill_loop"
    ? value
    : "unknown";
}

const clip = (value: string, limit = 320): string => {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
};

export type MacArtifactName = "model.step" | "model.stl" | "model.glb" | "source.py" | "measurements.json" | "missed.json";

export interface GenerateOptions {
  signal?: AbortSignal;
  /** Directory the downloaded artifacts are written to (created if needed). */
  artifactDir: string;
  /** Called on every MAC event, for server logs/tests that want the raw feed. */
  onRawEvent?: (event: Record<string, unknown>) => void;
}

/** The subset of MAC's config Forge overrides per job (MAC applies it via MAC_CONFIG_FILE). */
export function macJobConfig(config: CadConfig): Record<string, unknown> {
  const llm = config.llm;
  const qwenStyle = /aliyuncs\.com|dashscope/i.test(llm.baseUrl);
  const job: Record<string, unknown> = {
    DS_BASE_URL: llm.baseUrl,
    API_KEY_ENV_VAR: "OPENAI_API_KEY",
    API_BASE_ENV_VAR: "OPENAI_API_BASE",
    SPEC_PLANNER_MODEL: llm.model,
    ARCHITECT_MODEL: llm.model,
    CODER_MODEL: llm.model,
    REPAIR_MODEL: llm.model,
    AIDER_MODEL: llm.aiderModel,
    WORKFLOW_ID: "original",
    // Forge's retry budget is MAC's own: the autonomous skill loop re-runs
    // QA → Aider repair → re-execute internally, taking its 10-second
    // iteration checkpoint and auto-iterating (stdin is /dev/null), so a QA
    // failure does NOT restart the Spec Planner/Architect stages.
    MAX_RETRIES: Math.max(0, config.attemptBudget - 1),
  };
  if (!qwenStyle) {
    // `enable_thinking` is a Qwen/DashScope extra_body flag; OpenAI, Gemini's
    // OpenAI-compat endpoint and Ollama reject it, so it must be disabled.
    job.SPEC_PLANNER_KWARGS = {};
    job.ARCHITECT_KWARGS = {};
    job.CODER_KWARGS = {};
    job.REPAIR_KWARGS = {};
  }
  return job;
}

class MacHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class MacClient {
  constructor(private readonly config: CadConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  private url(path: string): string {
    return `${this.config.macBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private async request(path: string, init: RequestInit, timeoutMs = this.config.requestTimeoutMs): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`MAC request timed out after ${timeoutMs} ms.`)), timeoutMs);
    const onAbort = (): void => controller.abort(init.signal?.reason);
    init.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.fetchImpl(this.url(path), { ...init, redirect: "error", signal: controller.signal });
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
    }
  }

  async health(signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await this.request("/api/health", { method: "GET", signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, detail: `sidecar answered HTTP ${response.status} on GET /api/health` };
      }
      const payload = await response.json().catch(() => null) as { status?: string } | null;
      return { ok: true, detail: `MAC sidecar is up at ${this.config.macBaseUrl}${payload?.status ? ` (status: ${payload.status})` : ""}` };
    } catch (error) {
      return {
        ok: false,
        detail: `MAC sidecar is not reachable at ${this.config.macBaseUrl} (${error instanceof Error ? error.message : String(error)}). `
          + `Start it with: bash sidecars/start-mac.sh  (that runs python -m multi_agent_cad.web).`,
      };
    }
  }

  private async submit(prompt: string, apiKey: string, signal?: AbortSignal): Promise<string> {
    const response = await this.request("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        config: macJobConfig(this.config),
        workflow: "original",
        // MAC requires a non-empty key field in the POST body (it forwards it to
        // the runner as DASHSCOPE_API_KEY); Ollama gets a harmless placeholder.
        api_key: apiKey,
      }),
      signal,
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      let detail = clip(text, 400);
      try {
        const parsed = JSON.parse(text) as { detail?: unknown };
        if (typeof parsed.detail === "string") detail = parsed.detail;
      } catch {
        /* keep the raw text */
      }
      throw new MacHttpError(response.status, `MAC rejected the job (POST /api/run → HTTP ${response.status}${detail ? `: ${detail}` : ""}).`);
    }
    const parsed = JSON.parse(text || "{}") as { job_id?: string };
    if (!parsed.job_id) throw new MacHttpError(response.status, "MAC accepted the job but returned no job_id.");
    return parsed.job_id;
  }

  private async fetchText(path: string, signal?: AbortSignal): Promise<string | null> {
    const response = await this.request(path, { method: "GET", signal }).catch(() => null);
    if (!response) return null;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    return await response.text().catch(() => null);
  }

  /** Download one job artifact into Forge's cache dir; null when the sidecar has none. */
  private async download(
    jobId: string, name: MacArtifactName, artifactDir: string, target: string, signal?: AbortSignal,
  ): Promise<string | null> {
    const response = await this.request(
      `/api/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(name)}`,
      { method: "GET", signal }, this.config.requestTimeoutMs * 4,
    ).catch(() => null);
    if (!response || !response.ok) {
      await response?.body?.cancel().catch(() => undefined);
      return null;
    }
    const bytes = await response.arrayBuffer().catch(() => null);
    if (!bytes || bytes.byteLength === 0) return null;
    await mkdir(artifactDir, { recursive: true });
    const path = join(artifactDir, target);
    await writeFile(path, Buffer.from(bytes));
    return path;
  }

  private async result(jobId: string, signal?: AbortSignal): Promise<MacDoneRecord | null> {
    const text = await this.fetchText(`/api/jobs/${encodeURIComponent(jobId)}/result`, signal);
    if (!text) return null;
    try {
      const parsed = JSON.parse(text) as MacDoneRecord & { status?: string };
      if (parsed && parsed.status === "running" && parsed.done === undefined) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Run `prompt` through MAC, yielding MAC's own stage progress and returning
   * the model plus its QA diagnostics.
   *
   * The generator's yield type is `CadProgressEvent` (as the protocol defines
   * it); the terminal result is the generator's return value, because a QA
   * outcome is not a progress event. `pipeline.ts` pumps the events to the
   * socket and takes the returned outcome as its only input to the gate.
   */
  async *generate(prompt: string, options: GenerateOptions): AsyncGenerator<CadProgressEvent, MacRunOutcome, void> {
    const { artifactDir, signal } = options;
    const started = Date.now();
    const logTail: string[] = [];
    // Defaults first, then the caller's fields — a cancelled or partial outcome
    // must not silently lose `cancelled`, `stepPath` or the diagnostics it has.
    const emptyOutcome = (overrides: Partial<MacRunOutcome>): MacRunOutcome => ({
      jobId: "",
      ok: false,
      errorType: "fatal",
      iterations: 0,
      missedEntries: [],
      measurements: null,
      diagnosticsMissing: true,
      retriable: false,
      logTail,
      ...overrides,
    });

    const apiKey = this.config.llm.apiKey?.trim();
    if (!apiKey) {
      yield { stage: "spec_planning", detail: "no OpenAI-compatible provider configured for MAC" };
      return emptyOutcome({
        failure: `No LLM endpoint for the MAC pipeline: ${this.config.llm.provider}. `
          + "Set FORGE_CAD_BASE_URL/FORGE_CAD_MODEL/FORGE_CAD_API_KEY in packages/server/.env, or configure OPENAI_API_KEY / GEMINI_API_KEY / Ollama.",
        retriable: false,
      });
    }

    const health = await this.health(signal);
    if (!health.ok) {
      yield { stage: "spec_planning", detail: health.detail };
      return emptyOutcome({ failure: health.detail, retriable: false });
    }
    yield { stage: "spec_planning", detail: `${health.detail} — submitting job` };

    let jobId: string;
    try {
      jobId = await this.submit(prompt, apiKey, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { stage: "spec_planning", detail: message };
      return emptyOutcome({ failure: message, retriable: !(error instanceof MacHttpError) || error.status >= 500 });
    }
    yield { stage: "spec_planning", detail: `MAC job ${jobId} started — Spec Planner is parsing the request into a CADBrief` };

    let done: MacDoneRecord | null = null;
    let streamError: string | null = null;
    let iterations = 0;
    let lastStage: MacStage | null = null;
    let qaPasses = 0;
    const budget = this.config.attemptBudget;

    const deadline = started + this.config.jobTimeoutMs;
    try {
      const response = await this.request(
        `/api/jobs/${encodeURIComponent(jobId)}/events`,
        {
          method: "GET",
          headers: { accept: "text/event-stream" },
          signal,
          // No timeout of its own here: the stream stays open for the whole job
          // and request() bounds it with jobTimeoutMs, while the deadline check
          // below keeps the reader honest between events.
        },
        Math.max(this.config.requestTimeoutMs, this.config.jobTimeoutMs),
      );
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        streamError = `MAC SSE stream unavailable (GET /api/jobs/${jobId}/events → HTTP ${response.status}).`;
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: false });
        let buffer = "";
        for (;;) {
          if (Date.now() > deadline) {
            streamError = `MAC job ${jobId} exceeded the ${Math.round(this.config.jobTimeoutMs / 1000)}s job timeout.`;
            break;
          }
          const { value, done: streamDone } = await reader.read();
          if (streamDone) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            for (const line of block.split("\n")) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const payload = trimmed.slice(5).trim();
              if (!payload) continue;
              let event: Record<string, unknown>;
              try {
                event = JSON.parse(payload) as Record<string, unknown>;
              } catch {
                continue;
              }
              options.onRawEvent?.(event);
              if (typeof event.log === "string" && event.stage === undefined) logTail.push(event.log);
              if (logTail.length > 12) logTail.shift();

              if (typeof event.stage === "string") {
                const stage = asStage(event.stage);
                const log = typeof event.log === "string" ? event.log : "";
                const iteration = typeof event.iter === "number" ? event.iter : iterations;
                iterations = Math.max(iterations, iteration);
                if (stage === "autonomous_skill_loop") qaPasses += 1;
                lastStage = stage;
                const detail = stage === "autonomous_skill_loop"
                  ? `QA pass ${Math.min(qaPasses || 1, budget)}/${budget}: ${clip(log) || "dual-engine QA (topology + mesh) and Aider repair"}`
                  : `${STAGE_LABELS[stage]}: ${clip(log) || "done"}`;
                yield { stage: STAGE_TO_EVENT[stage], detail };
                continue;
              }
              if (event.done === true) {
                done = event as MacDoneRecord;
                continue;
              }
              if (event.intermediate === true) {
                yield {
                  stage: "qa_pass",
                  detail: `Iteration checkpoint: sidecar published an updated live preview (${String(event.glb ?? "live.glb")}) — MAC auto-iterated instead of restarting`,
                };
                continue;
              }
              if (typeof event.error === "string") {
                const trace = typeof event.traceback === "string" ? clip(event.traceback, 400) : "";
                streamError = `MAC runner reported: ${clip(event.error, 400)}${trace ? ` — traceback: ${trace}` : ""}`;
                continue;
              }
              if (typeof event.warn === "string") {
                yield { stage: lastStage ? STAGE_TO_EVENT[lastStage] : "coding", detail: `Warning: ${clip(event.warn, 300)}` };
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
          if (done) break;
        }
        // The real server closes the stream after `done`, but a proxy or a
        // half-open connection must not keep this job's socket alive forever.
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } catch (error) {
      if (signal?.aborted) {
        await this.request(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }).catch(() => undefined);
        return emptyOutcome({
          jobId, ok: false, errorType: "CANCELLED_BY_USER", iterations, cancelled: true,
          failure: "Cancelled — the MAC job was terminated; no unverified model was returned.", retriable: false,
        });
      }
      streamError = `Lost the MAC event stream: ${error instanceof Error ? error.message : String(error)}`;
    }

    // The SSE stream can end before the record is visible (reconnect case), so
    // fall back to the documented poll endpoint before declaring anything.
    if (!done) {
      while (!done && Date.now() < deadline) {
        const polled = await this.result(jobId, signal).catch(() => null);
        if (polled) {
          done = polled;
          break;
        }
        if (streamError) break;
        await new Promise((resolveSleep) => setTimeout(resolveSleep, this.config.pollIntervalMs));
      }
    }
    if (signal?.aborted) {
      await this.request(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }).catch(() => undefined);
      return emptyOutcome({
        jobId, ok: false, errorType: "CANCELLED_BY_USER", iterations, cancelled: true,
        failure: "Cancelled — the MAC job was terminated; no unverified model was returned.", retriable: false,
      });
    }

    if (!done) {
      return emptyOutcome({
        jobId, iterations,
        failure: streamError
          ?? `MAC job ${jobId} never reported a completion record within ${Math.round(this.config.jobTimeoutMs / 1000)}s `
             + `(GET /api/jobs/${jobId}/result kept answering {"status":"running"}).`,
        retriable: true,
      });
    }
    if (!done.done && done.error) {
      return emptyOutcome({
        jobId, iterations,
        errorType: "fatal",
        failure: `MAC runner failed: ${clip(done.error, 500)}`,
        retriable: /rc=|exited|crash|timeout|ECONN/i.test(done.error),
      });
    }
    if (done.cancelled) {
      return emptyOutcome({
        jobId, iterations, errorType: "CANCELLED_BY_USER", cancelled: true,
        failure: "MAC stopped at an iteration checkpoint before finishing (CANCELLED_BY_USER).", retriable: false,
      });
    }

    // ---- artifacts + diagnostics (both mandatory) ------------------------
    yield { stage: lastStage ? STAGE_TO_EVENT[lastStage] : "qa_pass", detail: `MAC finished (${done.error_type ?? "none"}) — reading QA diagnostics` };

    const missedText = await this.fetchText(`/api/jobs/${encodeURIComponent(jobId)}/files/missed.json`, signal);
    const measurementText = await this.fetchText(`/api/jobs/${encodeURIComponent(jobId)}/files/measurements.json`, signal);
    let missedEntries: string[] = [];
    let diagnosticsMissing = true;
    if (missedText) {
      diagnosticsMissing = false;
      try {
        const parsed: unknown = JSON.parse(missedText);
        if (Array.isArray(parsed)) missedEntries = parsed.map((item) => String(item));
        else if (parsed && typeof parsed === "object") {
          missedEntries = Object.entries(parsed as Record<string, unknown>)
            .flatMap(([key, value]) => Array.isArray(value) ? value.map((item) => `${key}: ${String(item)}`) : [`${key}: ${String(value)}`]);
        }
      } catch {
        missedEntries = missedText.split("\n").map((line) => line.trim()).filter(Boolean);
      }
    }
    let measurements: unknown = null;
    if (measurementText) {
      try { measurements = JSON.parse(measurementText); } catch { measurements = { raw: clip(measurementText, 2_000) }; }
    }

    const stepPath = await this.download(jobId, "model.step", artifactDir, "model.step", signal);
    const stlPath = await this.download(jobId, "model.stl", artifactDir, "model.stl", signal);
    const sidecarGlbPath = await this.download(jobId, "model.glb", artifactDir, "preview.glb", signal);
    const sourcePyPath = await this.download(jobId, "source.py", artifactDir, "design.py", signal);

    if (!stepPath) {
      const why = done.step
        ? `the sidecar reported ${done.step} but GET /api/jobs/${jobId}/files/model.step did not return it`
        : "MAC's completion record carries no STEP path at all";
      return emptyOutcome({
        jobId, iterations, errorType: done.error_type ?? "fatal",
        missedEntries, measurements, diagnosticsMissing,
        failure: `MAC finished without a usable STEP model (${why}). Nothing was shown.`,
        retriable: true,
      });
    }

    return {
      jobId,
      ok: true,
      errorType: String(done.error_type ?? "none"),
      iterations,
      ...(typeof done.tokens === "number" ? { tokens: done.tokens } : {}),
      ...(typeof done.api_calls === "number" ? { apiCalls: done.api_calls } : {}),
      ...(done.step ? { remoteStepPath: done.step } : {}),
      stepPath,
      ...(stlPath ? { stlPath } : {}),
      ...(sidecarGlbPath ? { sidecarGlbPath } : {}),
      ...(sourcePyPath ? { sourcePyPath } : {}),
      missedEntries,
      measurements,
      diagnosticsMissing,
      retriable: false,
      logTail,
    };
  }

  async cancel(jobId: string): Promise<void> {
    await this.request(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }).catch(() => undefined);
  }
}

export function createMacClient(config: CadConfig, fetchImpl?: typeof fetch): MacClient {
  return new MacClient(config, fetchImpl);
}
