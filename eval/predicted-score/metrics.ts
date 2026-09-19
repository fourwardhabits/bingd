/**
 * Every metric the study names, computed over gated predictions.
 *
 * Each "vs M0" figure pairs the model with M0 **on the same rows**. A model that abstains on
 * hard titles would otherwise look better than the baseline simply by choosing easier
 * questions.
 *
 * Nothing returned from here carries a person or a title. Per-user quantities (Spearman, the
 * share of users beating M0) are reduced to aggregates before they leave.
 */

import type { Bucket } from '@/features/collection/score';

import { BOOTSTRAP, CONFIDENCE_BAND_EDGES, THRESHOLDS } from './config';
import type { Gated } from './confidence';
import { BUCKET_ORDER } from './geometry';
import { mulberry32 } from './random';

const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;

export const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export const percentile = (xs: readonly number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const index = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
  return s[index]!;
};

/** Average ranks, ties shared. */
export function averageRanks(values: readonly number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j += 1;
    for (let k = i; k <= j; k += 1) ranks[order[k]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return ranks;
}

/** Spearman's rho, or null when either side is constant or there are fewer than three. */
export function spearman(a: readonly number[], b: readonly number[]): number | null {
  if (a.length < 3) return null;
  const ra = averageRanks(a);
  const rb = averageRanks(b);
  const n = a.length;
  const ma = ra.reduce((s, x) => s + x, 0) / n;
  const mb = rb.reduce((s, x) => s + x, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i += 1) {
    sab += (ra[i]! - ma) * (rb[i]! - mb);
    saa += (ra[i]! - ma) ** 2;
    sbb += (rb[i]! - mb) ** 2;
  }
  return saa === 0 || sbb === 0 ? null : sab / Math.sqrt(saa * sbb);
}

const severe = (predicted: Bucket, truth: Bucket) =>
  (predicted === 'loved' && truth === 'not_for_me') ||
  (predicted === 'not_for_me' && truth === 'loved');

export type Confusion = Record<Bucket, Record<Bucket, number>>;

export type BootstrapInterval = { low: number; high: number } | null;

export type Metrics = {
  n: number;
  users: number;
  mae: number | null;
  maeDisplay: number | null;
  baselineMae: number | null;
  relativeImprovement: number | null;
  /** 95% CI of (model MAE − M0 MAE), resampling users. Below zero is better. */
  maeDiffCi: BootstrapInterval;
  relativeImprovementCi: BootstrapInterval;
  quantileError: number | null;
  bucketAccuracy: number | null;
  baselineBucketAccuracy: number | null;
  bucketAccuracyGainCi: BootstrapInterval;
  confusion: Confusion;
  severeMissRate: number | null;
  largeErrorRate: number | null;
  qErrorWhenBucketRight: number | null;
  medianSpearman: number | null;
  spearmanGroups: number;
  pairwiseAccuracy: number | null;
  pairs: number;
  precisionAt3: number | null;
  precisionAt3Base: number | null;
  precisionGroups: number;
  ece: number | null;
  intervalCoverage: number | null;
  intervalN: number;
  usersBeatingBaseline: number | null;
  usersCompared: number;
};

const emptyConfusion = (): Confusion => ({
  loved: { loved: 0, fine: 0, not_for_me: 0 },
  fine: { loved: 0, fine: 0, not_for_me: 0 },
  not_for_me: { loved: 0, fine: 0, not_for_me: 0 },
});

/** Group rows by a key, preserving order. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

/**
 * The user-clustered bootstrap. A person's predictions are not independent of each other, so
 * people are resampled, never rows. Seeded, so the same rows always give the same interval.
 */
export function bootstrapByUser(
  rows: readonly Gated[],
  statistic: (sample: readonly Gated[]) => number | null,
  resamples: number = BOOTSTRAP.resamples,
  seed: number = BOOTSTRAP.seed,
): BootstrapInterval {
  const byUser = [...groupBy(rows, (r) => r.task.u).values()];
  if (byUser.length < 2) return null;
  const random = mulberry32(seed);
  const values: number[] = [];
  for (let b = 0; b < resamples; b += 1) {
    const sample: Gated[] = [];
    for (let i = 0; i < byUser.length; i += 1) {
      sample.push(...byUser[Math.floor(random() * byUser.length)]!);
    }
    const value = statistic(sample);
    if (value !== null && Number.isFinite(value)) values.push(value);
  }
  if (values.length === 0) return null;
  return { low: percentile(values, 0.025)!, high: percentile(values, 0.975)! };
}

const maeOf = (rows: readonly Gated[], pick: 'prediction' | 'baseline') =>
  mean(rows.map((r) => Math.abs(r[pick]!.score - r.task.truth.score)));

const accuracyOf = (rows: readonly Gated[], pick: 'prediction' | 'baseline') =>
  mean(rows.map((r) => (r[pick]!.bucket === r.task.truth.bucket ? 1 : 0)));

/**
 * Metrics over `rows`, which must all carry a prediction and a baseline.
 *
 * `rankRows` is the population the ranking metrics (Spearman, pairwise, Precision@3) are read
 * over. It is usually the same rows. For M0, and for any whole-population view, it is every
 * row that passed the user gate. `rankGroup` names the set a ranking is compared within: one
 * P2 fold, or one list in P1.
 */
export function computeMetrics(
  rows: readonly Gated[],
  options: {
    rankRows?: readonly Gated[];
    rankGroup?: (row: Gated) => string;
    /** Off for segment tables, where a thousand resamples per cell buys nothing. */
    bootstrap?: boolean;
  } = {},
): Metrics {
  const usable = rows.filter((r) => r.prediction && r.baseline);
  const rankRows = (options.rankRows ?? usable).filter((r) => r.prediction && r.baseline);
  const rankGroup = options.rankGroup ?? ((r: Gated) => r.task.group);
  const confusion = emptyConfusion();
  for (const r of usable) confusion[r.task.truth.bucket][r.prediction!.bucket] += 1;

  const boot = options.bootstrap === false ? () => null : bootstrapByUser;
  const mae = maeOf(usable, 'prediction');
  const baselineMae = maeOf(usable, 'baseline');

  // Per-list Spearman, over each (user, category) with at least five predictions.
  const spearmans: number[] = [];
  for (const group of groupBy(rankRows, (r) => `${r.task.u}|${r.task.c}`).values()) {
    if (group.length < 5) continue;
    const rho = spearman(
      group.map((r) => r.prediction!.score),
      group.map((r) => r.task.truth.score),
    );
    if (rho !== null) spearmans.push(rho);
  }

  // Pairwise ordering within a ranking group, over pairs the reader separated by >= 1.0.
  let pairs = 0;
  let correct = 0;
  for (const group of groupBy(rankRows, rankGroup).values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i]!;
        const b = group[j]!;
        const truthGap = a.task.truth.score - b.task.truth.score;
        if (Math.abs(truthGap) < THRESHOLDS.pairwiseMinGap) continue;
        const predictedGap = a.prediction!.score - b.prediction!.score;
        pairs += 1;
        if (predictedGap === 0) correct += 0.5;
        else if (Math.sign(predictedGap) === Math.sign(truthGap)) correct += 1;
      }
    }
  }

  // Precision@3 of "truly liked", per ranking group with at least six predictions.
  const precisions: number[] = [];
  const bases: number[] = [];
  for (const group of groupBy(rankRows, rankGroup).values()) {
    if (group.length < 6) continue;
    const top = [...group]
      .sort(
        (a, b) =>
          b.prediction!.score - a.prediction!.score ||
          b.prediction!.probs.loved - a.prediction!.probs.loved ||
          (a.task.target.m < b.task.target.m ? -1 : 1),
      )
      .slice(0, 3);
    precisions.push(top.filter((r) => r.task.truth.bucket === 'loved').length / 3);
    bases.push(group.filter((r) => r.task.truth.bucket === 'loved').length / group.length);
  }

  // Expected calibration error of the bucket probabilities, in tenths.
  let eceSum = 0;
  let eceCount = 0;
  const bins = new Map<number, { p: number; hit: number; n: number }>();
  for (const r of usable) {
    for (const b of BUCKET_ORDER) {
      const p = r.prediction!.probs[b];
      const bin = Math.min(9, Math.floor(p * 10));
      const cell = bins.get(bin) ?? { p: 0, hit: 0, n: 0 };
      cell.p += p;
      cell.hit += r.task.truth.bucket === b ? 1 : 0;
      cell.n += 1;
      bins.set(bin, cell);
      eceCount += 1;
    }
  }
  for (const cell of bins.values())
    eceSum += Math.abs(cell.p / cell.n - cell.hit / cell.n) * cell.n;

  const withInterval = usable.filter(
    (r) => r.interval && Number.isFinite(r.width) && r.width < 10,
  );
  const covered = withInterval.filter(
    (r) =>
      r.task.truth.score >= r.interval![0] - 1e-9 &&
      r.task.truth.score <= r.interval![1] + 1e-9,
  ).length;

  const perUser = [...groupBy(usable, (r) => r.task.u).values()].filter((g) => g.length >= 3);
  const beating = perUser.filter((g) => maeOf(g, 'prediction')! < maeOf(g, 'baseline')!).length;

  const bucketRight = usable.filter((r) => r.prediction!.bucket === r.task.truth.bucket);

  return {
    n: usable.length,
    users: new Set(usable.map((r) => r.task.u)).size,
    mae,
    maeDisplay: mean(usable.map((r) => Math.abs(r.prediction!.display - r.task.truth.display))),
    baselineMae,
    relativeImprovement: mae !== null && baselineMae ? 1 - mae / baselineMae : null,
    maeDiffCi: boot(usable, (s) => {
      const a = maeOf(s, 'prediction');
      const b = maeOf(s, 'baseline');
      return a === null || b === null ? null : a - b;
    }),
    relativeImprovementCi: boot(usable, (s) => {
      const a = maeOf(s, 'prediction');
      const b = maeOf(s, 'baseline');
      return a === null || !b ? null : 1 - a / b;
    }),
    quantileError: mean(
      usable.map((r) => Math.abs(r.prediction!.overall - r.task.truth.overall)),
    ),
    bucketAccuracy: accuracyOf(usable, 'prediction'),
    baselineBucketAccuracy: accuracyOf(usable, 'baseline'),
    bucketAccuracyGainCi: boot(usable, (s) => {
      const a = accuracyOf(s, 'prediction');
      const b = accuracyOf(s, 'baseline');
      return a === null || b === null ? null : a - b;
    }),
    confusion,
    severeMissRate: mean(
      usable.map((r) => (severe(r.prediction!.bucket, r.task.truth.bucket) ? 1 : 0)),
    ),
    largeErrorRate: mean(
      usable.map((r) =>
        Math.abs(r.prediction!.score - r.task.truth.score) >= THRESHOLDS.largeError ? 1 : 0,
      ),
    ),
    qErrorWhenBucketRight: mean(
      bucketRight.map((r) => Math.abs(r.prediction!.q - r.task.truth.q)),
    ),
    medianSpearman: median(spearmans),
    spearmanGroups: spearmans.length,
    pairwiseAccuracy: pairs === 0 ? null : correct / pairs,
    pairs,
    precisionAt3: mean(precisions),
    precisionAt3Base: mean(bases),
    precisionGroups: precisions.length,
    ece: eceCount === 0 ? null : eceSum / eceCount,
    intervalCoverage: withInterval.length === 0 ? null : covered / withInterval.length,
    intervalN: withInterval.length,
    usersBeatingBaseline: perUser.length === 0 ? null : beating / perUser.length,
    usersCompared: perUser.length,
  };
}

/** MAE by confidence band, over every eligible prediction, to show whether confidence means anything. */
export function maeByConfidence(
  rows: readonly Gated[],
): { from: number; n: number; mae: number | null }[] {
  const starts = [0, ...CONFIDENCE_BAND_EDGES];
  return starts.map((from, i) => {
    const to = starts[i + 1] ?? Infinity;
    const band = rows.filter(
      (r) => r.prediction && r.prediction.maxProb >= from && r.prediction.maxProb < to,
    );
    return { from, n: band.length, mae: maeOf(band, 'prediction') };
  });
}

/** Non-increasing across the bands that hold at least `minN` rows. Null when fewer than two do. */
export function monotoneNonIncreasing(
  bands: readonly { n: number; mae: number | null }[],
  minN = 20,
): boolean | null {
  const usable = bands.filter((b) => b.n >= minN && b.mae !== null).map((b) => b.mae!);
  if (usable.length < 2) return null;
  return usable.every((v, i) => i === 0 || v <= usable[i - 1]! + 1e-9);
}
