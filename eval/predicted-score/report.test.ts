/**
 * End to end: a snapshot in, an aggregate-only report and a verdict out.
 *
 * The last test is the report writer. It runs only with `BINGD_REPORTS=1` (see
 * `run-report.mjs`), reads the snapshot at `PREDICTED_SCORE_SNAPSHOT` or falls back to the
 * rich synthetic cohort, and writes into the gitignored `.agent-workflow/eval/`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { P1_CAN_GATE, THRESHOLDS } from './config';
import { renderReport } from './report';
import {
  finalVerdict,
  runEvaluation,
  verdictFor,
  type CategoryResult,
  type EvaluationResult,
  type ModeVerdict,
} from './run';
import { indexSnapshot, parseSnapshotText, type Snapshot } from './snapshot';
import { productionLikeOptions, richOptions, syntheticSnapshot } from './synthetic';

describe('a cohort shaped like the documented production aggregate', () => {
  let snapshot: Snapshot;
  let result: EvaluationResult;
  let report: string;

  beforeAll(() => {
    snapshot = syntheticSnapshot(productionLikeOptions());
    result = runEvaluation(indexSnapshot(snapshot));
    report = renderReport(result, { kind: 'synthetic', name: 'production-like' }, '2026-09-19');
  }, 120_000);

  it('is INSUFFICIENT, which is the expected answer and not a failure of the harness', () => {
    expect(result.final).toBe('INSUFFICIENT');
    expect(result.verdicts.P2.sampleSufficient).toBe(false);
  });

  it('never lets P1 pass while its labels are contaminated', () => {
    expect(P1_CAN_GATE).toBe(false);
    expect(['INSUFFICIENT', 'CONSISTENT', 'INCONSISTENT']).toContain(
      result.verdicts.P1.outcome,
    );
  });

  it('reports the two modes separately and says what a user-facing build still waits for', () => {
    expect(report).toContain('## P1 TEMPORAL — NOISY CURRENTLY');
    expect(report).toContain('## P2 HOLDOUT — MODEL COMPARISON');
    expect(report).toContain('It cannot produce a pass');
    expect(report).toContain('still waits for');
    expect(report).toContain('clean placement-history labels');
    expect(report).toContain('Label quality');
    expect(report).toContain('## Verdict: INSUFFICIENT');
  });

  it('prints no key, no hash, no title and no per-user row', () => {
    const keys = new Set([
      ...snapshot.users.map((u) => u.u),
      ...snapshot.media.map((m) => m.m),
      ...snapshot.rankings.map((r) => r.m),
    ]);
    for (const key of keys) expect(report).not.toContain(key);
    expect(report).not.toMatch(/\b[0-9a-f]{16,}\b/);
    expect(report).not.toMatch(/undefined|NaN/);
  });

  it('suppresses any segment drawn from fewer than three people', () => {
    for (const mode of [result.P1, result.P2]) {
      for (const c of ['movies', 'tv_seasons'] as const) {
        for (const segment of mode.categories[c].segments) {
          for (const row of segment.rows) {
            if (row.users > 0 && row.users < 3) {
              expect(row.suppressed).toBe(true);
              expect(row.maeShown).toBeNull();
              expect(row.maeGated).toBeNull();
            }
          }
        }
      }
    }
  });

  it('is deterministic', () => {
    const again = runEvaluation(indexSnapshot(syntheticSnapshot(productionLikeOptions())));
    expect(
      renderReport(again, { kind: 'synthetic', name: 'production-like' }, '2026-09-19'),
    ).toBe(report);
  });
});

/** A Movies result on which every pre-registered check passes. */
function passingCategory(): CategoryResult {
  const metrics = {
    n: 500,
    users: 30,
    mae: 0.8,
    maeDisplay: 0.8,
    baselineMae: 1.5,
    relativeImprovement: 1 - 0.8 / 1.5,
    maeDiffCi: { low: -0.9, high: -0.5 },
    relativeImprovementCi: { low: 0.3, high: 0.6 },
    quantileError: 0.1,
    bucketAccuracy: 0.85,
    baselineBucketAccuracy: 0.6,
    bucketAccuracyGainCi: null,
    confusion: {},
    severeMissRate: 0.01,
    largeErrorRate: 0.02,
    qErrorWhenBucketRight: 0.1,
    medianSpearman: 0.5,
    spearmanGroups: 30,
    pairwiseAccuracy: 0.8,
    pairs: 1000,
    precisionAt3: 0.9,
    precisionAt3Base: 0.6,
    precisionGroups: 30,
    ece: 0.02,
    intervalCoverage: 0.8,
    intervalN: 500,
    usersBeatingBaseline: 0.9,
    usersCompared: 30,
  };
  return {
    tasks: 1000,
    users: 30,
    evaluableUsers: THRESHOLDS.minEvaluableUsers,
    segments: [],
    models: { M4: { shown: THRESHOLDS.minShown, coverage: 0.5, monotone: true, metrics } },
  } as unknown as CategoryResult;
}

describe('the verdict rules', () => {
  const grid = Array.from({ length: 12 }, () => ({ improvement: 0.2 })) as never;

  it('P2 passes when every pre-registered check passes', () => {
    expect(verdictFor('P2', passingCategory(), grid).outcome).toBe('PASS');
  });

  it('P1 can at most be CONSISTENT, never PASS, while P1_CAN_GATE is false', () => {
    expect(verdictFor('P1', passingCategory(), null).outcome).toBe('CONSISTENT');
  });

  it('one failed check fails P2; a missing sample makes it INSUFFICIENT, not FAIL', () => {
    const failing = passingCategory();
    (failing.models.M4.metrics as { severeMissRate: number }).severeMissRate = 0.5;
    expect(verdictFor('P2', failing, grid).outcome).toBe('FAIL');
    const small = { ...passingCategory(), evaluableUsers: THRESHOLDS.minEvaluableUsers - 1 };
    expect(verdictFor('P2', small, grid).outcome).toBe('INSUFFICIENT');
  });

  it('a check that cannot be computed is INSUFFICIENT, never a pass', () => {
    const unknown = passingCategory();
    (unknown.models.M4.metrics as { medianSpearman: number | null }).medianSpearman = null;
    expect(verdictFor('P2', unknown, grid).outcome).toBe('INSUFFICIENT');
  });

  it('the grid must mostly beat M0', () => {
    const weak = Array.from({ length: 12 }, (_, i) => ({
      improvement: i < 5 ? 0.1 : -0.1,
    })) as never;
    expect(verdictFor('P2', passingCategory(), weak).outcome).toBe('FAIL');
  });

  it('the final word follows P2 and admits shadow mode only', () => {
    const v = (outcome: ModeVerdict['outcome']): ModeVerdict => ({
      outcome,
      sampleSufficient: true,
      checks: [],
    });
    expect(finalVerdict(v('PASS'), v('INCONSISTENT'))).toBe('PASS FOR SHADOW MODE');
    expect(finalVerdict(v('PASS'), v('INSUFFICIENT'))).toBe('PASS FOR SHADOW MODE');
    expect(finalVerdict(v('INSUFFICIENT'), v('CONSISTENT'))).toBe('INSUFFICIENT');
    expect(finalVerdict(v('FAIL'), v('CONSISTENT'))).toBe('FAIL');
  });
});

const REPORTS = process.env.BINGD_REPORTS === '1';

(REPORTS ? it : it.skip)(
  'writes the report (BINGD_REPORTS=1)',
  () => {
    const path = process.env.PREDICTED_SCORE_SNAPSHOT;
    const preset =
      process.env.PREDICTED_SCORE_SYNTHETIC === 'production-like' ? 'production-like' : 'rich';
    const today = new Date().toISOString().slice(0, 10);
    const snapshot = path
      ? parseSnapshotText(readFileSync(path, 'utf8'))
      : syntheticSnapshot(preset === 'rich' ? richOptions() : productionLikeOptions());
    const result = runEvaluation(indexSnapshot(snapshot));
    const source = path
      ? ({
          kind: 'snapshot',
          exportedDay: new Date(snapshot.exported_at / 1000).toISOString().slice(0, 10),
        } as const)
      : ({ kind: 'synthetic', name: `${preset} synthetic cohort` } as const);
    const report = renderReport(result, source, today);
    const dir = join(__dirname, '..', '..', '.agent-workflow', 'eval');
    mkdirSync(dir, { recursive: true });
    const file = join(
      dir,
      `predicted-score-report-${today}-${path ? 'snapshot' : `synthetic-${preset}`}.md`,
    );
    writeFileSync(file, report, 'utf8');
    console.warn(`report written: ${file}\nverdict: ${result.final}`);
    expect(report).toContain('## Verdict:');
  },
  1_800_000,
);
