import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CadProgressEvent } from "@forge/shared";
import { MacClient, macJobConfig } from "../../packages/server/src/cad/macClient";
import { gateMacOutcome } from "../../packages/server/src/cad/qualityGate";
import type { CadConfig as CadServerConfig } from "../../packages/server/src/cad/config";
import { startFakeMacSidecar, type FakeJobScript, type FakeSidecar } from "./fake-mac-sidecar";
import { fixturePath } from "./fixture";

/**
 * Talks to a faithful fake of the sidecar over real HTTP + real SSE frames, so
 * what is under test is Forge's protocol handling: route paths, body shape,
 * NDJSON → progress mapping, artifact + diagnostics fetches, and the hard-stop
 * behaviour when MAC reports a failure.
 */

let sidecar: FakeSidecar;
let dir: string;

async function clientFor(script: FakeJobScript = {}, overrides: Partial<CadServerConfig> = {}): Promise<MacClient> {
  if (sidecar) sidecar.close();
  sidecar = await startFakeMacSidecar(script);
  const config = cadConfig(sidecar.url, overrides);
  return new MacClient(config);
}

function cadConfig(macBaseUrl: string, overrides: Partial<CadServerConfig> = {}): CadServerConfig {
  return {
    enabled: true,
    macBaseUrl,
    requestTimeoutMs: 5_000,
    jobTimeoutMs: 20_000,
    pollIntervalMs: 20,
    attemptBudget: 3,
    artifactDir: dir,
    searchEnabled: false,
    searchMaxResults: 5,
    maxDownloadBytes: 1_048_576,
    downloadTimeoutMs: 5_000,
    cascadeBin: "true",
    cascadeTimeoutMs: 5_000,
    cascadeLinDeflection: 0.25,
    cascadeAngDeflection: 0.35,
    rejectTrivialPrimitive: true,
    llm: { baseUrl: "http://localhost:11434/v1", model: "qwen3-coder:32b", aiderModel: "ollama/qwen3-coder:32b", apiKey: "ollama", provider: "ollama" },
    ...overrides,
  } as CadServerConfig;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-cad-client-"));
});

afterAll(() => {
  sidecar?.close();
});

const collect = async (
  client: MacClient, prompt: string, artifactDir: string, signal?: AbortSignal,
): Promise<{ events: CadProgressEvent[]; outcome: Awaited<ReturnType<MacClient["generate"]>> }> => {
  const iterator = client.generate(prompt, { artifactDir, signal });
  const events: CadProgressEvent[] = [];
  let step = await iterator.next();
  while (!step.done) {
    events.push(step.value);
    step = await iterator.next();
  }
  return { events, outcome: step.value };
};

test("the job body carries the prompt, the LLM endpoint and Forge's attempt budget as MAC's own retry config", async () => {
  const client = await clientFor();
  const { outcome } = await collect(client, "a wristwatch with a 38 mm case", join(dir, "run-a"));
  expect(outcome.ok).toBe(true);
  expect(sidecar.runs).toHaveLength(1);
  const run = sidecar.runs[0]!;
  expect(run.prompt).toBe("a wristwatch with a 38 mm case");
  expect(run.workflow).toBe("original");
  expect(run.api_key).toBe("ollama");
  const config = run.config as Record<string, unknown>;
  // Forge's 3-attempt budget becomes MAC's internal loop size — not a restart.
  expect(config.MAX_RETRIES).toBe(2);
  expect(config.DS_BASE_URL).toBe("http://localhost:11434/v1");
  expect(config.SPEC_PLANNER_MODEL).toBe("qwen3-coder:32b");
  expect(config.AIDER_MODEL).toBe("ollama/qwen3-coder:32b");
  // Ollama has no Qwen `enable_thinking` extra_body flag.
  expect(config.SPEC_PLANNER_KWARGS).toEqual({});
});

test("a DashScope-style endpoint keeps MAC's thinking kwargs", () => {
  const config = cadConfig("http://127.0.0.1:8000", {
    llm: {
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.7-max",
      aiderModel: "openai/qwen3.7-max", apiKey: "sk-test", provider: "dashscope",
    },
  });
  const job = macJobConfig(config);
  expect(job.SPEC_PLANNER_KWARGS).toBeUndefined();
  expect(job.ARCHITECT_KWARGS).toBeUndefined();
  expect(job.DS_BASE_URL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
});

test("MAC's stage events become named progress lines, not a spinner", async () => {
  const client = await clientFor();
  const { events, outcome } = await collect(client, "a circular flange with 4 holes", join(dir, "run-b"));
  const stages = events.map((event) => event.stage);
  // submit-time health, job accepted, then MAC's four stages, then diagnostics.
  expect(stages).toEqual([
    "spec_planning", "spec_planning", "spec_planning", "architecting", "coding", "qa_pass", "qa_pass",
  ]);
  expect(events[2]!.detail).toContain("CADBrief");
  expect(events[3]!.detail).toContain("ArchitectPlan");
  expect(events[4]!.detail).toContain("SUCCESS (deterministic)");
  expect(events[5]!.detail).toContain("QA pass 1/3");
  expect(events[6]!.detail).toContain("reading QA diagnostics");
  expect(outcome.iterations).toBe(1);
  expect(outcome.errorType).toBe("none");
});

test("the model AND the QA diagnostics are both fetched — never the model alone", async () => {
  const flange = await Bun.file(fixturePath("flange.step")).text();
  const client = await clientFor({
    files: {
      "model.step": flange,
      "missed.json": JSON.stringify(["CHAMFER_FAILED: rim — all lengths [1.5, 1] failed"]),
    },
    done: { error_type: "dimension" },
  });
  const { outcome } = await collect(client, "a flange with chamfered rims", join(dir, "run-c"));
  expect(outcome.stepPath).toBe(join(dir, "run-c", "model.step"));
  expect(await Bun.file(outcome.stepPath!).text()).toBe(flange);
  expect(outcome.missedEntries).toEqual(["CHAMFER_FAILED: rim — all lengths [1.5, 1] failed"]);
  expect(outcome.diagnosticsMissing).toBe(false);
  expect(outcome.errorType).toBe("dimension");

  const decision = await gateMacOutcome({ outcome, prompt: "a flange with chamfered rims", attemptsAllowed: 3 });
  expect(decision.passed).toBe(false);
  if (decision.passed) return;
  expect(decision.failure.reason).toContain("CHAMFER_FAILED on 1 chamfer edge group(s)");
});

test("no diagnostics file means MAC wrote none (a clean run), not an unknown state", async () => {
  const client = await clientFor();
  const { outcome } = await collect(client, "a stepped shaft", join(dir, "run-d"));
  expect(outcome.diagnosticsMissing).toBe(true);
  expect(outcome.missedEntries).toEqual([]);
  expect(outcome.errorType).toBe("none");
});

test("a job the sidecar refuses is reported verbatim, not as a generic failure", async () => {
  const client = await clientFor({}, { llm: { baseUrl: "http://x/v1", model: "m", aiderModel: "openai/m", apiKey: "", provider: "none" } });
  const { events, outcome } = await collect(client, "a bolt", join(dir, "run-e"));
  // No key at all → Forge never even reaches the sidecar, and says exactly why.
  expect(outcome.ok).toBe(false);
  expect(outcome.failure).toContain("No LLM endpoint for the MAC pipeline");
  expect(outcome.failure).toContain("FORGE_CAD_API_KEY");
  expect(events).toHaveLength(1);
  expect(events[0]?.detail).toContain("no OpenAI-compatible provider configured");
  expect(sidecar.requests.filter((entry) => entry.path === "/api/run")).toHaveLength(0);
});

test("whitespace around a key is trimmed before it is sent (and never sent blank)", async () => {
  const client = await clientFor({}, {
    llm: { baseUrl: "http://x/v1", model: "m", aiderModel: "openai/m", apiKey: "  sk-padded  ", provider: "test" },
  });
  const { outcome } = await collect(client, "a bearing", join(dir, "run-pad"));
  expect(outcome.ok).toBe(true);
  expect(sidecar.runs.at(-1)?.api_key).toBe("sk-padded");
});

test("a blank key is treated as no key before anything is sent", async () => {
  const client = await clientFor({}, {
    llm: { baseUrl: "http://x/v1", model: "m", aiderModel: "openai/m", apiKey: "   ", provider: "x" },
  });
  const { outcome } = await collect(client, "a bolt", join(dir, "run-f"));
  expect(outcome.ok).toBe(false);
  expect(outcome.failure).toContain("No LLM endpoint");
  expect(sidecar.requests.filter((entry) => entry.path === "/api/run")).toHaveLength(0);
});

test("a job the sidecar rejects is quoted verbatim, not flattened into a generic error", async () => {
  const client = await clientFor({ runReject: { status: 422, detail: "USER_REQUEST is too long for the planner context" } });
  const { outcome } = await collect(client, "a bolt", join(dir, "run-f2"));
  expect(outcome.ok).toBe(false);
  expect(outcome.retriable).toBe(false);            // a 4xx is the user's to fix, not ours to retry
  expect(outcome.failure).toContain("HTTP 422");
  expect(outcome.failure).toContain("USER_REQUEST is too long for the planner context");
});

test("a runner crash is a specific failure and is treated as infra, not as a QA verdict", async () => {
  const client = await clientFor({ done: null });
  const { outcome } = await collect(client, "a turbine housing", join(dir, "run-g"));
  expect(outcome.ok).toBe(false);
  expect(outcome.failure).toContain("runner exited (rc=1)");
  expect(outcome.retriable).toBe(true);
});

test("an unreachable sidecar names the command that starts it", async () => {
  const config = cadConfig("http://127.0.0.1:1");   // nothing listens here
  const client = new MacClient(config);
  const { events, outcome } = await collect(client, "a wheel", join(dir, "run-h"));
  expect(outcome.ok).toBe(false);
  expect(outcome.retriable).toBe(false);
  expect(outcome.failure).toContain("not reachable at http://127.0.0.1:1");
  expect(outcome.failure).toContain("bash sidecars/start-mac.sh");
  expect(events.at(-1)?.stage).toBe("spec_planning");
});

test("a cancelled run cancels the MAC job and shows nothing", async () => {
  const client = await clientFor({ holdMs: 400, stages: [{ stage: "autonomous_skill_loop", log: "QA pass 1", iter: 1 }] });
  const controller = new AbortController();
  const collecting = collect(client, "a big assembly", join(dir, "run-i"), controller.signal);
  setTimeout(() => controller.abort(new Error("user cancelled")), 60);
  const { outcome } = await collecting;
  expect(outcome.cancelled).toBe(true);
  expect(sidecar.cancels.length).toBe(1);
  expect(outcome.failure).toContain("no unverified model was returned");
});

test("a model with no STEP behind it is a failure, not an empty viewer", async () => {
  const client = await clientFor({ done: { step: null } });
  const { outcome } = await collect(client, "a small bracket", join(dir, "run-j"));
  expect(outcome.ok).toBe(false);
  expect(outcome.failure).toContain("without a usable STEP model");
  expect(outcome.retriable).toBe(true);
});
