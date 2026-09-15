import { expect, test } from "bun:test";
import { copyFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import {
  classifyMissed,
  describeMissed,
  gateMacOutcome,
  measurementsReportFailure,
  shouldStartNewJob,
} from "../../packages/server/src/cad/qualityGate";
import type { MacRunOutcome } from "../../packages/server/src/cad/macClient";

/**
 * MAC writes `temp_missed_N.json` as a flat list of strings whose prefixes are
 * its own taxonomy (nodes.py `_parse_missed_cuts`). These fixtures use that
 * exact wording so the gate is exercised against the real format, and the
 * geometry assertions run against real OpenCASCADE STEP output.
 */
const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

const outcome = (overrides: Partial<MacRunOutcome>): MacRunOutcome => ({
  jobId: "job1234567890",
  ok: true,
  errorType: "none",
  iterations: 1,
  missedEntries: [],
  measurements: null,
  diagnosticsMissing: true,
  retriable: false,
  logTail: [],
  ...overrides,
});

const withStep = async (fixture: "flange.step" | "plate.step"): Promise<string> => {
  const dir = await mkdtemp("/tmp/forge-cad-gate-");
  const path = join(dir, "model.step");
  await copyFile(`${FIXTURES}${fixture}`, path);
  return path;
};

test("missed entries are classified with MAC's own labels", () => {
  const classified = classifyMissed([
    "MISSED_CUT: bolt_hole — tool had NO effect on body. Position is WRONG.",
    "FILLET_FAILED: base_top_fillet — all radii [2, 1.5, 1] failed (Stage 1 + Stage 2).",
    "CHAMFER_FAILED: head_chamfer — no edges matched filter",
    "CUT_ERROR: slot — exception during cut",
    "FILLET_DEGRADED: edge_7 — original radius 3 failed, succeeded at 1.5",
  ]);
  expect(classified.unresolved).toHaveLength(4);
  expect(classified.degraded).toHaveLength(1);
  expect(classified.counts).toEqual({ missed_cut: 1, fillet: 1, chamfer: 1, other: 1 });
  expect(classified.label).toBe("MISSED_CUT");
  const described = describeMissed(classified);
  expect(described).toContain("MISSED_CUT on 1 cut(s) that removed no material");
  expect(described).toContain("FILLET_FAILED on 1 fillet edge group(s)");
  expect(described).toContain("CHAMFER_FAILED on 1 chamfer edge group(s)");
  expect(described).not.toContain("DEGRADED");     // advisory entries are never counted as failures
});

test("an empty diagnostics list is not a failure — MAC only writes the file on trouble", () => {
  const classified = classifyMissed(["", "   "]);
  expect(classified.unresolved).toHaveLength(0);
  expect(classified.label).toBe("none");
});

test("a clean MAC run with a real featureful STEP passes the gate", async () => {
  const stepPath = await withStep("flange.step");
  const decision = await gateMacOutcome({
    outcome: outcome({ stepPath, iterations: 2, errorType: "none" }),
    prompt: "a circular flange, 80 mm outside diameter, 10 mm thick, with a 30 mm central bore",
    attemptsAllowed: 3,
  });
  expect(decision.passed).toBe(true);
  if (!decision.passed) return;
  expect(decision.stepPath).toBe(stepPath);
  expect(decision.detail).toContain("MAC QA clean");
  expect(decision.detail).toContain("8 faces");
});

test("unresolved FILLET_FAILED entries block a model even when the STEP looks fine", async () => {
  const stepPath = await withStep("flange.step");
  const decision = await gateMacOutcome({
    outcome: outcome({
      stepPath,
      errorType: "dimension",
      missedEntries: [
        "FILLET_FAILED: hub_fillet — all radii [2, 1.5, 1] failed (Stage 1 + Stage 2). Last: fillet radius too large",
        "FILLET_FAILED: rim_fillet — no edges matched filter",
      ],
      diagnosticsMissing: false,
    }),
    prompt: "a flange with 2 mm fillets on both rim edges",
    attemptsAllowed: 3,
  });
  expect(decision.passed).toBe(false);
  if (decision.passed) return;
  expect(decision.failure.stage).toBe("qa_pass");
  expect(decision.failure.reason).toContain("FILLET_FAILED on 2 fillet edge group(s)");
  expect(decision.failure.reason).toContain("2 unresolved diagnostics");
  expect(decision.failure.reason).toContain("after 3 QA attempts");
  expect(decision.failure.reason).toContain("error_type=dimension");
  expect(decision.failure.reason).toContain("Forge will not show a model whose fillets");
});

test("a non-none MAC verdict fails the gate with the verdict explained, not a generic error", async () => {
  const stepPath = await withStep("flange.step");
  const decision = await gateMacOutcome({
    outcome: outcome({ stepPath, errorType: "topology", iterations: 3 }),
    prompt: "an open-top enclosure with 2 mm walls",
    attemptsAllowed: 3,
  });
  expect(decision.passed).toBe(false);
  if (decision.passed) return;
  expect(decision.failure.reason).toContain("MAC's own QA did not pass");
  expect(decision.failure.reason).toContain("topology error");
  expect(decision.retriable).toBe(false);
});

test("a bare box for a featureful request is rejected as a placeholder", async () => {
  const stepPath = await withStep("plate.step");
  const decision = await gateMacOutcome({
    outcome: outcome({ stepPath, errorType: "none" }),
    prompt: "an L-bracket with two 6 mm mounting holes and 3 mm fillets",
    attemptsAllowed: 3,
  });
  expect(decision.passed).toBe(false);
  if (decision.passed) return;
  expect(decision.failure.reason).toContain("single bare primitive");
  expect(decision.failure.reason).toContain("placeholder");
});

test("the guard is the only thing refusing it, and an operator can turn it off", async () => {
  const stepPath = await withStep("plate.step");
  const input = {
    outcome: outcome({ stepPath, errorType: "none" }),
    prompt: "an L-bracket with two 6 mm mounting holes and 3 mm fillets",
    attemptsAllowed: 3,
  };
  expect((await gateMacOutcome(input)).passed).toBe(false);
  expect((await gateMacOutcome(input, { rejectTrivialPrimitive: false })).passed).toBe(true);
});

test("a primitive is allowed when the request really is a primitive", async () => {
  const stepPath = await withStep("plate.step");
  const decision = await gateMacOutcome({
    outcome: outcome({ stepPath, errorType: "none" }),
    prompt: "a 50x50x6 mm base plate",
    attemptsAllowed: 3,
  });
  expect(decision.passed).toBe(true);
});

test("a delivered STEP that no longer parses is a failure, not a partial preview", async () => {
  const dir = await mkdtemp("/tmp/forge-cad-gate-");
  const path = join(dir, "model.step");
  const full = await Bun.file(`${FIXTURES}flange.step`).text();
  await Bun.write(path, full.slice(0, Math.floor(full.length * 0.5)));
  const decision = await gateMacOutcome({
    outcome: outcome({ stepPath: path, errorType: "none" }),
    prompt: "a flange with a bore",
    attemptsAllowed: 3,
  });
  expect(decision.passed).toBe(false);
  if (decision.passed) return;
  expect(decision.failure.stage).toBe("converting");
  expect(decision.failure.reason).toContain("truncated");
  expect(decision.retriable).toBe(true);       // the *download* broke, not the geometry
});

test("a run that never produced a model reports the sidecar's own reason", async () => {
  const decision = await gateMacOutcome({
    outcome: outcome({ ok: false, iterations: 0, stepPath: undefined, failure: "MAC rejected the job (POST /api/run → HTTP 400: api_key is required (fill it in the form))", retriable: false }),
    prompt: "a wristwatch",
    attemptsAllowed: 3,
  });
  expect(decision.passed).toBe(false);
  if (decision.passed) return;
  expect(decision.failure.reason).toContain("api_key is required");
  expect(decision.failure.stage).toBe("spec_planning");
});

test("measurement disagreements block a claimed pass", () => {
  expect(measurementsReportFailure({ all_passed: false })).toBe(true);
  expect(measurementsReportFailure({ all_passed: true, targets: [] })).toBe(false);
  expect(measurementsReportFailure(null)).toBe(false);
  expect(measurementsReportFailure("not json")).toBe(false);
});

test("only infrastructure deaths justify a fresh job", () => {
  const passed = { passed: true, stepPath: "/x", detail: "", fingerprint: null, notes: [] } as const;
  expect(shouldStartNewJob({ decision: passed, jobsStarted: 1, maxJobs: 2 }).retry).toBe(false);

  const qaFailure = {
    passed: false as const, retriable: false, detail: "", notes: [],
    failure: { reason: "FILLET_FAILED on 2 fillet edge group(s)", stage: "qa_pass" as const },
  };
  const first = shouldStartNewJob({ decision: qaFailure, jobsStarted: 1, maxJobs: 2 });
  expect(first.retry).toBe(false);
  expect(first.reason).toContain("terminal");

  const infra = { ...qaFailure, retriable: true };
  expect(shouldStartNewJob({ decision: infra, jobsStarted: 1, maxJobs: 2 }).retry).toBe(true);
  expect(shouldStartNewJob({ decision: infra, jobsStarted: 2, maxJobs: 2 }).retry).toBe(false);
});
