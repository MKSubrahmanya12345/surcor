/**
 * Catalog demand telemetry.
 *
 * The catalog is an infinite list approached one part at a time, so the only
 * question that matters is *which* part to add next. Guessing produced 26 parts
 * last round with no evidence any of them were wanted.
 *
 * This module records, for every part the model asks for:
 *
 *   - what was requested;
 *   - what it actually resolved to (exact catalog hit, fuzzy substitution,
 *     provisional contract, or nothing at all);
 *   - how confident that resolution was.
 *
 * The ranked report turns "add more parts" into "add these five parts, they
 * were requested 40 times between them and every one was a substitution".
 *
 * Storage is deliberately boring: an append-only JSONL file under
 * `.wireup/demand.jsonl`, outside git. There is no schema migration to do, it
 * survives without MongoDB, and it can be deleted at any time with no effect on
 * the product. If MongoDB is later wanted for this, the shape below maps to a
 * collection one-to-one.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { createLogger } from '@/lib/logging/logger';
import { nowIso } from '@/lib/validation/time';

const logger = createLogger('components:demand');

export type DemandOutcome =
  /** Exact catalog id or alias hit — the ideal case. */
  | 'catalog'
  /** Fuzzy match onto a *different* catalog part; the user did not get what they asked for. */
  | 'substituted'
  /** No catalog part, but the electrical family was recognised. */
  | 'provisional'
  /** Nothing matched; the part was dropped from the build. */
  | 'unmatched';

export interface DemandRecord {
  at: string;
  /** Exactly what the model asked for. */
  requested: string;
  outcome: DemandOutcome;
  /** Catalog or provisional id the request resolved to, when it resolved. */
  resolvedTo?: string;
  /** Match score, so a weak substitution can be told from a strong one. */
  score?: number;
  /** Contract family for provisional resolutions. */
  contract?: string;
  projectId?: string;
}

export interface DemandRow {
  requested: string;
  count: number;
  outcomes: Record<DemandOutcome, number>;
  /** Most common resolution target, for substitutions. */
  topResolution?: string;
  /** Worst (lowest) score seen — a low score on a frequent term is a red flag. */
  minScore?: number;
}

export interface DemandReport {
  total: number;
  byOutcome: Record<DemandOutcome, number>;
  /**
   * Parts worth adding to the catalog next, most valuable first.
   * Ranked by frequency, weighted by how wrong the current answer is.
   */
  gaps: DemandRow[];
  rows: DemandRow[];
}

const DEMAND_DIR = path.join(process.cwd(), '.wireup');
const DEMAND_FILE = path.join(DEMAND_DIR, 'demand.jsonl');

/**
 * Telemetry must never break a build.
 *
 * Every failure here is swallowed to a debug log: a read-only filesystem, a
 * container without a writable cwd or a full disk are all fine reasons for the
 * log to be missing, and none of them are reasons to fail a user's project.
 */
export async function recordDemand(record: DemandRecord): Promise<void> {
  try {
    await mkdir(DEMAND_DIR, { recursive: true });
    await appendFile(DEMAND_FILE, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    logger.debug('demand telemetry unavailable', { error: error instanceof Error ? error.message : String(error) });
  }
}

/** Record a batch in one write, used at the end of the planning stage. */
export async function recordDemandBatch(records: DemandRecord[]): Promise<void> {
  if (records.length === 0) return;
  try {
    await mkdir(DEMAND_DIR, { recursive: true });
    await appendFile(DEMAND_FILE, `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  } catch (error) {
    logger.debug('demand telemetry unavailable', { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function readDemandRecords(): Promise<DemandRecord[]> {
  try {
    const raw = await readFile(DEMAND_FILE, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as DemandRecord];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * How much a request is "costing" the user right now.
 *
 * An unmatched request loses the part entirely; a substitution silently gives
 * the wrong part, which is worse than provisional (honest about its gaps).
 * Ranking by this instead of raw frequency puts the damaging gaps first.
 */
const OUTCOME_WEIGHT: Record<DemandOutcome, number> = {
  unmatched: 3,
  substituted: 2.5,
  provisional: 1,
  catalog: 0,
};

export function summariseDemand(records: DemandRecord[]): DemandReport {
  const byOutcome: Record<DemandOutcome, number> = { catalog: 0, substituted: 0, provisional: 0, unmatched: 0 };
  const grouped = new Map<string, DemandRecord[]>();

  for (const record of records) {
    byOutcome[record.outcome] = (byOutcome[record.outcome] ?? 0) + 1;
    const key = record.requested.toLowerCase().trim();
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }

  const rows: DemandRow[] = [...grouped.entries()].map(([requested, entries]) => {
    const outcomes: Record<DemandOutcome, number> = { catalog: 0, substituted: 0, provisional: 0, unmatched: 0 };
    const resolutions = new Map<string, number>();
    let minScore: number | undefined;

    for (const entry of entries) {
      outcomes[entry.outcome] += 1;
      if (entry.resolvedTo) resolutions.set(entry.resolvedTo, (resolutions.get(entry.resolvedTo) ?? 0) + 1);
      if (typeof entry.score === 'number') minScore = minScore === undefined ? entry.score : Math.min(minScore, entry.score);
    }

    const topResolution = [...resolutions.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

    return {
      requested,
      count: entries.length,
      outcomes,
      ...(topResolution ? { topResolution } : {}),
      ...(minScore !== undefined ? { minScore } : {}),
    };
  });

  const score = (row: DemandRow): number =>
    (Object.entries(row.outcomes) as [DemandOutcome, number][]).reduce(
      (sum, [outcome, count]) => sum + count * OUTCOME_WEIGHT[outcome],
      0,
    );

  const gaps = rows
    .filter((row) => row.outcomes.catalog < row.count)
    .sort((a, b) => score(b) - score(a) || b.count - a.count)
    .slice(0, 25);

  return {
    total: records.length,
    byOutcome,
    gaps,
    rows: rows.sort((a, b) => b.count - a.count),
  };
}

export async function getDemandReport(): Promise<DemandReport> {
  return summariseDemand(await readDemandRecords());
}

/** Build a record without writing it, so callers can batch. */
export function demandRecord(
  requested: string,
  outcome: DemandOutcome,
  extra: Omit<DemandRecord, 'at' | 'requested' | 'outcome'> = {},
): DemandRecord {
  return { at: nowIso(), requested, outcome, ...extra };
}
