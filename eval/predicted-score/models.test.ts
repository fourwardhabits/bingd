import { BAND_RANGE } from '@/features/collection/score';

import { PRIMARY_CONFIG, ABSTENTION } from './config';
import { contentSimilarity, starOpinion, tasteMatchScore } from './evidence';
import { film, listOf, makeSnapshot } from './fixtures';
import { aggregate, predict, type Evidence } from './models';
import { indexSnapshot } from './snapshot';
import { holdoutTasks } from './tasks';

const NONE: Evidence = { communityRaters: 0, neighbours: 0, contentNeighbours: 0 };
const EMPTY_EVIDENCE = { community: [], neighbours: [], content: [], evidence: NONE };

describe('M0 exactness', () => {
  it('is the reader’s own bucket shares, q = ½, projected through the band range', () => {
    const ds = indexSnapshot(makeSnapshot({ rankings: listOf('A', 'LLLLLLLFFFNN', 'a', 1) }));
    for (const task of holdoutTasks(ds, ['movies'])) {
      const p = predict('M0', task, EMPTY_EVIDENCE, PRIMARY_CONFIG, ABSTENTION)!;
      const { loved, fine, not_for_me } = task.train.sizes;
      const total = task.train.total;
      expect(p.probs.loved).toBeCloseTo(loved / total, 12);
      expect(p.probs.fine).toBeCloseTo(fine / total, 12);
      expect(p.probs.not_for_me).toBeCloseTo(not_for_me / total, 12);
      expect(p.q).toBe(0.5);
      const expected =
        loved / total >= 0.5 ? 'loved' : (loved + fine) / total >= 0.5 ? 'fine' : 'not_for_me';
      expect(p.bucket).toBe(expected);
      const { high, low } = BAND_RANGE[p.bucket];
      expect(p.score).toBeCloseTo(high - 0.5 * (high - low), 12);
      expect(p.weight).toBe(0);
    }
  });

  it('ignores evidence entirely, even when evidence is present', () => {
    const ds = indexSnapshot(makeSnapshot({ rankings: listOf('A', 'LLFFFFFFNN', 'a', 1) }));
    const task = holdoutTasks(ds, ['movies'])[0]!;
    const loud = { ...EMPTY_EVIDENCE, community: [{ bucket: 'loved' as const, q: 0, w: 100 }] };
    expect(predict('M0', task, loud, PRIMARY_CONFIG, ABSTENTION)).toEqual(
      predict('M0', task, EMPTY_EVIDENCE, PRIMARY_CONFIG, ABSTENTION),
    );
  });

  it('cannot predict for a reader with no list', () => {
    expect(
      aggregate([], { loved: 0, fine: 0, not_for_me: 0 }, PRIMARY_CONFIG, NONE),
    ).toBeNull();
  });
});

describe('the aggregator', () => {
  const sizes = { loved: 5, fine: 3, not_for_me: 2 };

  it('pools weighted samples over the prior pseudo-counts', () => {
    const p = aggregate(
      [
        { bucket: 'fine', q: 0.2, w: 2 },
        { bucket: 'fine', q: 0.6, w: 1 },
      ],
      sizes,
      { priorStrength: 1, qPriorStrength: 1 },
      NONE,
    )!;
    expect(p.probs.fine).toBeCloseTo((3 + 1 * 0.3) / 4, 12);
    expect(p.probs.loved).toBeCloseTo(0.5 / 4, 12);
    expect(p.qByBucket.fine).toBeCloseTo((2 * 0.2 + 0.6 + 0.5) / (3 + 1), 12);
    expect(p.weight).toBe(3);
  });

  it('predicts the median bucket, not a mean across buckets', () => {
    // Just over half the evidence says the top of liked, the rest the bottom of disliked. The
    // median is a real band. A mean of the two scores would be about 5.2: a "fine" that no
    // evidence proposed.
    const p = aggregate(
      [
        { bucket: 'loved', q: 0, w: 11 },
        { bucket: 'not_for_me', q: 1, w: 10 },
      ],
      { loved: 1, fine: 1, not_for_me: 1 },
      { priorStrength: 0.001, qPriorStrength: 1 },
      NONE,
    )!;
    expect(p.bucket).toBe('loved');
    expect(p.score).toBeGreaterThanOrEqual(7);
    expect(p.probs.fine).toBeLessThan(0.01);
  });

  it('ignores a sample of zero or negative weight', () => {
    const base = aggregate([], sizes, PRIMARY_CONFIG, NONE)!;
    const withZero = aggregate(
      [{ bucket: 'not_for_me', q: 1, w: 0 }],
      sizes,
      PRIMARY_CONFIG,
      NONE,
    )!;
    expect(withZero.probs).toEqual(base.probs);
  });
});

describe('Taste Match, mirrored from taste_match', () => {
  const identical = (n: number) =>
    Array.from({ length: n }, (_, i) => [10 - i * 0.3, 10 - i * 0.3] as const);

  it('reproduces the migration’s own table for identical evaluations', () => {
    // 20260827001000: n = 5 → 75, n = 8 → 81, n = 20 → 90, n = 50 → 95.
    expect(tasteMatchScore(identical(5))).toBe(75);
    expect(tasteMatchScore(identical(8))).toBe(81);
    expect(tasteMatchScore(identical(20))).toBe(90);
    expect(tasteMatchScore(identical(50))).toBe(95);
  });

  it('is null below the minimum overlap', () => {
    expect(tasteMatchScore(identical(4))).toBeNull();
  });

  it('shrinks disagreement toward the stranger baseline too', () => {
    const inverted = Array.from({ length: 5 }, (_, i) => [10 - i, i * 1.0] as const);
    const score = tasteMatchScore(inverted)!;
    expect(score).toBeGreaterThan(20);
    expect(score).toBeLessThan(50);
  });
});

describe('content similarity and stars', () => {
  it('treats two seasons of one show as strong neighbours', () => {
    const ds = indexSnapshot(
      makeSnapshot({
        rankings: listOf('A', 'L', 'x', 1),
        media: [
          film('s1', ['Drama'], { kind: 'season', parent: 'show', season: 1 }),
          film('s2', ['Drama'], { kind: 'season', parent: 'show', season: 2, year: 2001 }),
          film('other', ['Comedy'], { lang: 'fr', year: 1970 }),
        ],
      }),
    );
    expect(contentSimilarity(ds, 's1', 's2')).toBeGreaterThan(0.75);
    expect(contentSimilarity(ds, 's1', 'other')).toBeLessThan(0.1);
  });

  it('places a star inside the bucket the import policy gives it', () => {
    expect(starOpinion(5)).toEqual({ bucket: 'loved', q: 0 });
    expect(starOpinion(3.5)).toEqual({ bucket: 'loved', q: 1 });
    expect(starOpinion(3)).toEqual({ bucket: 'fine', q: 0 });
    expect(starOpinion(2.5)).toEqual({ bucket: 'fine', q: 1 });
    expect(starOpinion(2)).toEqual({ bucket: 'not_for_me', q: 0 });
    expect(starOpinion(0.5)).toEqual({ bucket: 'not_for_me', q: 1 });
  });
});
