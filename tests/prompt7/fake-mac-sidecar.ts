import type { Server } from "bun";

/**
 * A faithful stand-in for the MAC sidecar's HTTP surface, used by Prompt 7's
 * tests. "Faithful" is deliberate: every route, status code, body shape and SSE
 * frame below mirrors `sidecars/multi-agent-cad/multi_agent_cad/web/server.py`
 * together with `multi_agent_cad/web_runner.py`:
 *
 *   POST /api/run                      → {job_id}; 400 when prompt/api_key empty
 *   GET  /api/jobs/{id}/events         → SSE `data: {ndjson}` frames
 *   GET  /api/jobs/{id}/result         → final record or {"status":"running"}
 *   GET  /api/jobs/{id}/files/{name}   → model.step / model.stl / model.glb /
 *                                        source.py / measurements.json / missed.json
 *   POST /api/jobs/{id}/cancel         → {status:"cancelling"}
 *   GET  /api/health                   → {status:"ok"}
 *
 * The NDJSON *content* is web_runner's real record set: stage records
 * `{stage, log, iter}`, live-preview notices `{intermediate, glb}`, `{error}` on
 * a runner crash, and the final `{done, error_type, step, stl, glb, py,
 * measurements, missed, tokens, api_calls}`. File availability is derived from
 * that final record the same way the real `name_map` does it, so a job that
 * produced no STEP answers 404 for `model.step` instead of inventing one.
 */

export interface FakeJobScript {
  /** Stage records emitted before the terminal record. */
  stages?: { stage: string; log?: string; iter?: number }[];
  /** Extra raw NDJSON lines to emit verbatim (intermediate notices, warns). */
  extra?: Record<string, unknown>[];
  /** Fields merged into the final record; `null` clears one (e.g. no STEP). */
  done?: Record<string, unknown> | null;
  /** Emitted instead of a `done` record — the runner-crash path. */
  errorLine?: Record<string, unknown>;
  /** Pause before the terminal record, so a test can cancel mid-run. */
  holdMs?: number;
  /** Override the bytes a file route returns. */
  files?: Partial<Record<string, string>>;
  /** HTTP status for /api/health (500 simulates a half-broken sidecar). */
  healthStatus?: number;
  /** Refuse POST /api/run with this status/detail (MAC does exactly this for a bad form). */
  runReject?: { status: number; detail: string };
}

export interface FakeSidecar {
  url: string;
  close(): void;
  requests: { method: string; path: string; body: unknown }[];
  /** Every accepted run, in order — lets a test assert the retry policy. */
  runs: { prompt: string; config: Record<string, unknown>; api_key?: string; workflow?: string }[];
  cancels: string[];
  jobs: () => string[];
}

const DEFAULT_STAGES = [
  { stage: "planner", log: "node_spec_planner: CADBrief written (3 verification targets)", iter: 0 },
  { stage: "architect", log: "node_geometric_architect: ArchitectPlan with 7 steps", iter: 0 },
  { stage: "coder", log: "node_python_coder: SUCCESS (deterministic)", iter: 0 },
  { stage: "autonomous_skill_loop", log: "QA pass 1: Engine A + Engine B — all_passed=True", iter: 1 },
];

const DEFAULT_FILES: Record<string, string> = {
  "model.step": "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
  "model.stl": "solid part\nendsolid part\n",
  "source.py": "from build123d import *\n",
  "missed.json": "[]",
  "measurements.json": "{}",
};

/** `done` record field → the file name the sidecar serves it under. */
const FIELD_OF_FILE: Record<string, string> = {
  "model.step": "step",
  "model.stl": "stl",
  "model.glb": "glb",
  "source.py": "py",
  "measurements.json": "measurements",
  "missed.json": "missed",
};

export async function startFakeMacSidecar(script: FakeJobScript = {}): Promise<FakeSidecar> {
  const explicit = script.files ?? {};
  const requests: FakeSidecar["requests"] = [];
  const runs: FakeSidecar["runs"] = [];
  const cancels: string[] = [];
  const jobs = new Map<string, { result: Record<string, unknown> | null }>();
  let sequence = 0;

  const serveFile = (name: string, jobResult: Record<string, unknown> | null): string | undefined => {
    if (explicit[name] !== undefined) return explicit[name];
    const field = FIELD_OF_FILE[name];
    // The real server falls back to a tempdir glob; the fake keeps it simpler
    // and equally strict: nothing is served unless the record points at it.
    if (field && typeof jobResult?.[field] === "string") return DEFAULT_FILES[name];
    return undefined;
  };

  const server: Server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      const body = request.method === "POST" && request.headers.get("content-type")?.includes("json")
        ? await request.clone().json().catch(() => ({}))
        : undefined;
      requests.push({ method: request.method, path, body });

      if (path === "/api/health") {
        if ((script.healthStatus ?? 200) !== 200) return new Response("sidecar unhappy", { status: script.healthStatus ?? 500 });
        return Response.json({ status: "ok" });
      }

      if (path === "/api/run" && request.method === "POST") {
        const payload = (body ?? {}) as { prompt?: string; config?: Record<string, unknown>; api_key?: string; workflow?: string };
        const prompt = (payload.prompt ?? (payload.config?.USER_REQUEST as string) ?? "").trim();
        if (!prompt) return Response.json({ detail: "prompt is required" }, { status: 400 });
        if (!payload.api_key) return Response.json({ detail: "api_key is required (fill it in the form)" }, { status: 400 });
        if (script.runReject) {
          return Response.json({ detail: script.runReject.detail }, { status: script.runReject.status });
        }
        const jobId = `job${(++sequence).toString().padStart(9, "0")}`;
        jobs.set(jobId, { result: null });
        runs.push({
          prompt,
          config: payload.config ?? {},
          ...(payload.api_key ? { api_key: payload.api_key } : {}),
          ...(payload.workflow ? { workflow: payload.workflow } : {}),
        });
        return Response.json({ job_id: jobId });
      }

      const events = path.match(/^\/api\/jobs\/([^/]+)\/events$/);
      if (events) {
        const jobId = events[1]!;
        if (!jobs.has(jobId)) return Response.json({ detail: "job not found" }, { status: 404 });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const push = (payload: unknown): void => {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
            };
            void (async () => {
              for (const stage of script.stages ?? DEFAULT_STAGES) push(stage);
              for (const extra of script.extra ?? []) push(extra);
              if (script.holdMs) await new Promise((resolve) => setTimeout(resolve, script.holdMs));
              if (script.errorLine) {
                push(script.errorLine);
              } else if (script.done !== null) {
                const record = {
                  done: true,
                  error_type: "none",
                  step: `/tmp/fake-mac/${jobId}/temp_output_0.step`,
                  stl: `/tmp/fake-mac/${jobId}/temp_output_0.stl`,
                  glb: null,
                  py: `/tmp/fake-mac/${jobId}/temp_design_0.py`,
                  measurements: `/tmp/fake-mac/${jobId}/temp_measurements_0.json`,
                  missed: null,
                  tokens: 1234,
                  api_calls: 5,
                  ...(script.done ?? {}),
                } as Record<string, unknown>;
                // A `null` field means "the run produced none of that" — the
                // real runner emits None too, and the file route then 404s.
                for (const [key, value] of Object.entries(record)) if (value === null) delete record[key];
                jobs.get(jobId)!.result = record;
                push(record);
              } else {
                push({ error: "runner exited (rc=1) without 'done'", rc: 1 });
              }
              controller.close();
            })();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" },
        });
      }

      const result = path.match(/^\/api\/jobs\/([^/]+)\/result$/);
      if (result) {
        const job = jobs.get(result[1]!);
        if (!job) return Response.json({ detail: "job not found" }, { status: 404 });
        return Response.json(job.result ?? { status: "running" });
      }

      const cancel = path.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (cancel && request.method === "POST") {
        cancels.push(cancel[1]!);
        return Response.json({ status: "cancelling" });
      }

      const file = path.match(/^\/api\/jobs\/([^/]+)\/files\/([^/]+)$/);
      if (file) {
        const jobId = file[1]!;
        const name = file[2]!;
        const job = jobs.get(jobId);
        if (!job) return Response.json({ detail: "job not found" }, { status: 404 });
        const content = serveFile(name, job.result);
        if (content === undefined) return Response.json({ detail: `file '${name}' not available (yet)` }, { status: 404 });
        return new Response(content, { headers: { "content-type": "application/octet-stream", "cache-control": "no-cache, must-revalidate" } });
      }

      return Response.json({ detail: "Not Found" }, { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    close: () => server.stop(true),
    requests,
    runs,
    cancels,
    jobs: () => [...jobs.keys()],
  };
}
