import type { Bucket } from '@/features/collection/score';

import type { Gated } from './confidence';
import { displayScore, projectScore } from './geometry';
import { bootstrapByUser, computeMetrics, monotoneNonIncreasing, spearman } from './metrics';
import type { Prediction } from './models';
import type { Task } from './tasks';

let serial = 0;

/** A gated row with a chosen truth and prediction, both in (bucket, q). */
function row(
  u: string,
  truth: [Bucket, number],
  predicted: [Bucket, number],
  baseline: [Bucket, number] = ['loved', 0.5],
  group = u,
): Gated {
  const pred = (b: Bucket, q: number): Prediction => ({
    probs: {
      loved: b === 'loved' ? 0.8 : 0.1,
      fine: b === 'fine' ? 0.8 : 0.1,
      not_for_me: b === 'not_for_me' ? 0.8 : 0.1,
    },
    qByBucket: { loved: q, fine: q, not_for_me: q },
    bucket: b,
    q,
    score: projectScore(b, q),
    display: displayScore(b, q),
    overall: 0,
    maxProb: 0.8,
    weight: 1,
    evidence: { communityRaters: 3, neighbours: 3, contentNeighbours: 5 },
    components: [],
  });
  const task = {
    u,
    c: 'movies',
    group,
    target: { m: `${u}-${(serial += 1)}` },
    truth: {
      bucket: truth[0],
      rank: 1,
      bandSize: 1,
      q: truth[1],
      score: projectScore(truth[0], truth[1]),
      display: displayScore(truth[0], truth[1]),
      overall: 0,
    },
  } as unknown as Task;
  return {
    task,
    model: 'M4',
    prediction: pred(...predicted),
    baseline: pred(...baseline),
    support: 0,
    userGate: true,
    eligible: true,
    tier: 1,
    interval: [
      projectScore(predicted[0], predicted[1]) - 0.5,
      projectScore(predicted[0], predicted[1]) + 0.5,
    ],
    width: 1,
    shown: true,
    reason: null,
  };
}

describe('score MAE is unrounded; the one-decimal MAE sits beside it', () => {
  it('reports both, and they differ when rounding hides an error', () => {
    // Truth q 0.10 → 9.70, prediction q 0.11 → 9.67: both print 9.7.
    const rows = [row('a', ['loved', 0.1], ['loved', 0.11])];
    const m = computeMetrics(rows, { bootstrap: false });
    expect(m.mae).toBeCloseTo(0.03, 12);
    expect(m.maeDisplay).toBe(0);
  });
});

describe('bucket metrics', () => {
  it('counts severe misses only across the liked / didn’t-like divide', () => {
    const rows = [
      row('a', ['loved', 0.5], ['not_for_me', 0.5]),
      row('a', ['fine', 0.5], ['loved', 0.5]),
      row('b', ['not_for_me', 0.5], ['loved', 0.5]),
      row('b', ['loved', 0.5], ['loved', 0.5]),
    ];
    const m = computeMetrics(rows, { bootstrap: false });
    expect(m.severeMissRate).toBe(0.5);
    expect(m.bucketAccuracy).toBe(0.25);
    expect(m.confusion.loved.not_for_me).toBe(1);
    expect(m.confusion.fine.loved).toBe(1);
  });

  it('reads q error only where the bucket was right', () => {
    const rows = [
      row('a', ['loved', 0.2], ['loved', 0.5]),
      row('a', ['fine', 0], ['loved', 1]),
    ];
    expect(computeMetrics(rows, { bootstrap: false }).qErrorWhenBucketRight).toBeCloseTo(
      0.3,
      12,
    );
  });
});

describe('ranking metrics', () => {
  it('pairwise accuracy counts only pairs the reader separated by a full point', () => {
    const rows = [
      row('a', ['loved', 0], ['loved', 0.1]), // 10.0 vs 9.7
      row('a', ['loved', 0.1], ['loved', 0]), // 9.7 vs 10.0 — too close to count as a pair with the first
      row('a', ['fine', 0.5], ['loved', 0.9]), // 5.2 vs 7.3
    ];
    const m = computeMetrics(rows, { bootstrap: false });
    expect(m.pairs).toBe(2);
    expect(m.pairwiseAccuracy).toBe(1);
  });

  it('Spearman is exact on a monotone relation and null on a constant one', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBe(-1);
    expect(spearman([1, 2, 3], [5, 5, 5])).toBeNull();
  });

  it('Precision@3 reads the top three predicted in each group against how many were truly liked', () => {
    const g = 'fold';
    const rows = [
      row('a', ['loved', 0], ['loved', 0], undefined, g),
      row('a', ['loved', 0.5], ['loved', 0.1], undefined, g),
      row('a', ['fine', 0], ['loved', 0.2], undefined, g),
      row('a', ['fine', 0.5], ['fine', 0], undefined, g),
      row('a', ['not_for_me', 0], ['fine', 0.5], undefined, g),
      row('a', ['not_for_me', 1], ['not_for_me', 0], undefined, g),
    ];
    const m = computeMetrics(rows, { bootstrap: false });
    expect(m.precisionAt3).toBeCloseTo(2 / 3, 12);
    expect(m.precisionAt3Base).toBeCloseTo(2 / 6, 12);
  });

  it('confidence monotonicity needs two bands with enough rows to say anything', () => {
    expect(
      monotoneNonIncreasing([
        { n: 30, mae: 2 },
        { n: 30, mae: 1 },
      ]),
    ).toBe(true);
    expect(
      monotoneNonIncreasing([
        { n: 30, mae: 1 },
        { n: 30, mae: 2 },
      ]),
    ).toBe(false);
    expect(
      monotoneNonIncreasing([
        { n: 30, mae: 1 },
        { n: 5, mae: 2 },
      ]),
    ).toBeNull();
  });
});

describe('the user-clustered bootstrap', () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((u, i) =>
    Array.from({ length: 3 + i }, (_, j) =>
      row(u, ['loved', (j % 4) / 4], ['loved', ((j + i) % 5) / 5]),
    ),
  );
  const stat = (s: readonly Gated[]) =>
    s.reduce((sum, r) => sum + Math.abs(r.prediction!.score - r.task.truth.score), 0) /
    s.length;

  it('is deterministic for a seed', () => {
    expect(bootstrapByUser(rows, stat, 500, 42)).toEqual(bootstrapByUser(rows, stat, 500, 42));
  });

  it('moves with the seed', () => {
    expect(bootstrapByUser(rows, stat, 500, 42)).not.toEqual(
      bootstrapByUser(rows, stat, 500, 43),
    );
  });

  it('resamples people, not rows: one person cannot be split', () => {
    const seen: number[] = [];
    bootstrapByUser(
      rows,
      (s) => {
        const byUser = new Map<string, number>();
        for (const r of s) byUser.set(r.task.u, (byUser.get(r.task.u) ?? 0) + 1);
        // Every drawn person arrives with a whole multiple of their own row count.
        for (const [u, n] of byUser) {
          const own = rows.filter((r) => r.task.u === u).length;
          seen.push(n % own);
        }
        return 0;
      },
      50,
      1,
    );
    expect(new Set(seen)).toEqual(new Set([0]));
  });

  it('says nothing with fewer than two people', () => {
    expect(
      bootstrapByUser(
        rows.filter((r) => r.task.u === 'a'),
        stat,
      ),
    ).toBeNull();
  });
});
