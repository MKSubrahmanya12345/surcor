import type { CadFailure, CadProgressEvent } from "@forge/shared";
import { impliedFeatureCount, validateStepFile, type ModelFingerprint } from "./modelValidate";
import type { MacRunOutcome } from "./macClient";

/**
 * The gate that decides whether a model may be shown at all.
 *
 * It deliberately contains no home-grown quality heuristic: a run passes only
 * when (a) MAC's own routing verdict is `none` — the value its Dual-Engine QA
 * (topology via cadpy/Engine A, mesh via check_mesh/Engine B) ends on — and
 * (b) MAC's own white-box diagnostics (`temp_missed_N.json`, fetched through
 * `GET /api/jobs/{id}/files/missed.json`) contain no unresolved entry. The
 * classification below mirrors `_parse_missed_cuts()` in MAC's nodes.py so the
 * labels Forge shows are MAC's labels, not new ones.
 *
 * Then two integrity checks that exist purely to make sure what you *see* is
 * what MAC actually built — never to grade the geometry:
 *   - the downloaded STEP must still be a valid, untruncated STEP file;
 *   - a run that resolved to a single bare box/cylinder/cone/sphere while the
 *     request named real features is rejected as a placeholder.
 *
 * On a QA failure this is a hard stop: no "best of N attempts", no primitive
 * stand-in, no silently-shrunk model. The only thing that retries is a job that
 * died for infrastructure reasons, and even then within the same attempt budget.
 */

/**
 * Mirrors MAC's `_MISSED_CUTS` prefixes (nodes.py `_parse_missed_cuts()` /
 * `_format_missed_cuts_errors()`) so the words in a Forge failure card are
 * MAC's own labels rather than a translation of them.
 */
export type MissedBucket = "missed_cut" | "fillet" | "chamfer" | "other";

export interface MissedClassification {
  /** Unresolved (blocking) entries, verbatim from MAC's diagnostics file. */
  unresolved: string[];
  /** Advisory only: the feature exists but at a reduced radius/length. */
  degraded: string[];
  /** Blocking counts per bucket — the numbers shown in the failure reason. */
  counts: Record<MissedBucket, number>;
  /** The dominant label, using MAC's own name for it. */
  label: string;
  /** Every entry that blocks, formatted as "<LABEL> on <n> <subject>". */
  summary: string;
}

const BLOCKING_LABEL: RegExp = /^(MISSED_CUT|CUT_ERROR|FILLET_FAILED|CHAMFER_FAILED)\b/;
const PARTIAL = /_PARTIAL\b/;
const DEGRADED = /_DEGRADED\b/;

const bucketOf = (entry: string): MissedBucket => {
  if (entry.startsWith("MISSED_CUT")) return "missed_cut";
  if (entry.startsWith("FILLET")) return "fillet";
  if (entry.startsWith("CHAMFER")) return "chamfer";
  return "other";
};

const SUBJECTS: Record<MissedBucket, string> = {
  missed_cut: "cut(s) that removed no material",
  fillet: "fillet edge group(s)",
  chamfer: "chamfer edge group(s)",
  other: "operation(s) that raised",
};

/**
 * A `*_DEGRADED` entry means the feature was produced at a smaller radius than
 * the Architect asked for — MAC reduces it, retries, and can still finish with
 * `error_type=none`. That is a real geometry compromise, so it is reported, but
 * it is not a *missing* feature and does not block. `*_PARTIAL` means some edge
 * groups never got the operation at all, so it always blocks.
 */
export function classifyMissed(entries: readonly string[]): MissedClassification {
  const unresolved: string[] = [];
  const degraded: string[] = [];
  const counts: Record<MissedBucket, number> = { missed_cut: 0, fillet: 0, chamfer: 0, other: 0 };
  const labels: Record<string, number> = {};
  for (const raw of entries) {
    const entry = String(raw).replace(/\s+/g, " ").trim();
    if (!entry) continue;
    const blocking = BLOCKING_LABEL.test(entry) || PARTIAL.test(entry);
    if (!blocking) {
      // `*_DEGRADED` (feature exists, smaller) and any other non-blocking prefix
      // are advisory: reported, never a hard stop.
      degraded.push(entry);
      continue;
    }
    unresolved.push(entry);
    const bucket = bucketOf(entry);
    counts[bucket] += 1;
    const label = entry.match(/^(MISSED_CUT|CUT_ERROR|FILLET_FAILED|CHAMFER_FAILED|[A-Z_]+?(?=_PARTIAL))/)?.[1]
      ?? (bucket === "missed_cut" ? "MISSED_CUT" : "CUT_ERROR");
    labels[label] = (labels[label] ?? 0) + 1;
  }
  const ranked = Object.entries(labels).sort((a, b) => b[1] - a[1]);
  const label = ranked[0]?.[0] ?? "none";
  const summary = ranked
    .map(([name, count]) => {
      const bucket: MissedBucket = name.startsWith("MISSED_CUT")
        ? "missed_cut"
        : name.startsWith("FILLET")
          ? "fillet"
          : name.startsWith("CHAMFER")
            ? "chamfer"
            : "other";
      return `${name} on ${count} ${SUBJECTS[bucket]}`;
    })
    .join("; ");
  return { unresolved, degraded, counts, label, summary: summary || "unresolved diagnostics" };
}

/** "FILLET_FAILED on 2 fillet edge group(s)" — the CadFailure card's first clause. */
export function describeMissed(classified: MissedClassification): string {
  return classified.summary;
}

export interface GateInput {
  outcome: MacRunOutcome;
  prompt: string;
  attemptsAllowed: number;
}

export type GateDecision =
  | { passed: true; stepPath: string; detail: string; fingerprint: ModelFingerprint | null; notes: string[] }
  | { passed: false; failure: CadFailure; detail: string; notes: string[]; retriable: boolean };

export interface GateOptions {
  /**
   * The anti-placeholder check. Off only when the operator explicitly turns it
   * off (FORGE_CAD_TRIVIAL_PRIMITIVE_GUARD=false) — e.g. a workflow that really
   * does want a primitive out of MAC. It never approves a model, only rejects.
   */
  rejectTrivialPrimitive?: boolean;
}

/**
 * MAC's QA verdict + diagnostics → a pass/fail decision with a reason that is
 * specific enough for the user to act on.
 */
export async function gateMacOutcome(input: GateInput, options: GateOptions = {}): Promise<GateDecision> {
  const { outcome, prompt, attemptsAllowed } = input;
  const notes: string[] = [];
  const fail = (reason: string, stage: CadProgressEvent["stage"], retriable = false): GateDecision => ({
    passed: false,
    retriable,
    detail: reason,
    notes,
    failure: { reason, stage },
  });

  if (!outcome.ok || !outcome.stepPath) {
    const stage: CadProgressEvent["stage"] = outcome.iterations > 0 ? "qa_pass" : "spec_planning";
    return fail(outcome.failure ?? "MAC reported no completion record and produced no STEP file.", stage, outcome.retriable);
  }

  const classified = classifyMissed(outcome.missedEntries);
  if (classified.unresolved.length > 0) {
    const sample = classified.unresolved[0]!.slice(0, 240);
    return fail(
      `${describeMissed(classified)} after ${attemptsAllowed} QA attempt${attemptsAllowed === 1 ? "" : "s"} `
      + `(MAC error_type=${outcome.errorType || "unknown"}; ${classified.unresolved.length} unresolved diagnostic${classified.unresolved.length === 1 ? "" : "s"}). `
      + `First entry: "${sample}". Forge will not show a model whose fillets, chamfers or cuts failed.`,
      "qa_pass",
    );
  }
  if (classified.degraded.length > 0) {
    notes.push(`MAC accepted ${classified.degraded.length} reduced-radius entr${classified.degraded.length === 1 ? "y" : "ies"}: ${classified.degraded[0]!.slice(0, 160)}`);
  }

  if (outcome.errorType !== "none" && outcome.errorType !== "") {
    const verdictMeaning: Record<string, string> = {
      dimension: "QA found a dimension/feature error the repair loop could not fix",
      topology: "QA found a topology error (wrong boolean/missing feature) the repair loop could not fix",
      fatal: "the pipeline hit an unrecoverable error",
      CANCELLED_BY_USER: "the run was stopped at an iteration checkpoint before finishing",
    };
    const why = verdictMeaning[outcome.errorType] ?? `MAC reported error_type=${outcome.errorType}`;
    return fail(
      `MAC's own QA did not pass: ${why} after ${attemptsAllowed} attempt${attemptsAllowed === 1 ? "" : "s"}`
      + (outcome.missedEntries.length ? `; diagnostics: ${describeMissed(classified)}` : "")
      + `${outcome.logTail.length ? `. Last runner output: ${outcome.logTail[outcome.logTail.length - 1]!.slice(0, 200)}` : ""}.`,
      "qa_pass",
    );
  }

  if (measurementsReportFailure(outcome.measurements)) {
    return fail(
      "MAC's white-box measurement file (temp_measurements_N.json) reports a failed verification target, while the run claimed a pass — the two disagree, so nothing is shown.",
      "qa_pass",
    );
  }

  // The bytes we are about to render must still be a valid STEP file: a
  // truncated download is a failure, not a partial preview.
  const validation = await validateStepFile(outcome.stepPath, "generated STEP");
  if (!validation.ok) {
    return fail(`MAC passed QA but the delivered model failed STEP validation: ${validation.reason}`, "converting", true);
  }
  const fingerprint = validation.fingerprint;
  notes.push(fingerprint.summary);

  const guard = options.rejectTrivialPrimitive ?? true;
  if (guard && fingerprint.singleTrivialPrimitive) {
    const demand = impliedFeatureCount(prompt);
    if (demand >= 2) {
      return fail(
        `The generated model is a single bare primitive (${fingerprint.summary}) while the request implies ${demand} feature-bearing aspect(s) — `
        + "this is exactly the placeholder Forge refuses to show.",
        "qa_pass",
      );
    }
  }

  return {
    passed: true,
    stepPath: outcome.stepPath,
    detail: `MAC QA clean (${outcome.errorType || "none"}; ${outcome.iterations} iteration(s)) — ${fingerprint.summary}`,
    fingerprint,
    notes,
  };
}

/**
 * Defensive read of `temp_measurements_N.json`: only an explicit `false` on a
 * top-level pass flag blocks. Missing/unknown shapes never block, because the
 * authoritative verdict is MAC's own `error_type` plus `temp_missed_N.json`.
 */
export function measurementsReportFailure(measurements: unknown): boolean {
  if (!measurements || typeof measurements !== "object") return false;
  const record = measurements as Record<string, unknown>;
  for (const key of ["all_passed", "allPassed", "passed"]) {
    if (record[key] === false) return true;
  }
  return false;
}

/**
 * Forge's outer retry policy. MAC's autonomous loop already spent the QA
 * budget internally (its 10s iteration checkpoints auto-iterate); the only
 * thing worth starting over for is a job that died for infrastructure reasons.
 */
export function shouldStartNewJob(args: {
  decision: GateDecision;
  jobsStarted: number;
  maxJobs: number;
}): { retry: boolean; reason: string } {
  if (args.decision.passed) return { retry: false, reason: "gate passed" };
  if (args.jobsStarted >= args.maxJobs) {
    return { retry: false, reason: `hard stop after ${args.jobsStarted} job(s); the attempt budget is ${args.maxJobs}` };
  }
  if (!args.decision.retriable) {
    return { retry: false, reason: "QA failure is terminal — re-running the same prompt would only re-derive the same model" };
  }
  return { retry: true, reason: "infrastructure failure (not a QA verdict), so one fresh job is allowed" };
}
