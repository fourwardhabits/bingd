import { BAND_RANGE, bucketForScore, scoreFor, type Bucket } from '@/features/collection/score';

import {
  displayScore,
  insertionTruth,
  libraryView,
  overallOf,
  placeOverall,
  projectScore,
} from './geometry';
import type { SnapshotRanking } from './snapshot';

const row = (m: string, b: Bucket, p: number): SnapshotRanking => ({
  u: 'u',
  m,
  c: 'movies',
  b,
  p,
  t: p,
  cmp_window: 1,
  cmp_earlier: 0,
  cmp_later: 0,
  cmp_first: null,
  imported: false,
});

/** A list of `loved` liked, `fine` fine and `nfm` disliked titles, in position order. */
const list = (loved: number, fine: number, nfm: number): SnapshotRanking[] => {
  const rows: SnapshotRanking[] = [];
  let p = 1;
  for (let i = 0; i < loved; i += 1) rows.push(row(`L${i}`, 'loved', p++));
  for (let i = 0; i < fine; i += 1) rows.push(row(`F${i}`, 'fine', p++));
  for (let i = 0; i < nfm; i += 1) rows.push(row(`N${i}`, 'not_for_me', p++));
  return rows;
};

describe('insertion quantile arithmetic', () => {
  it('ranks the held-out title among the same-band titles left in the list', () => {
    const rows = list(5, 3, 2);
    // Hold out the third liked title: two liked titles sit above it, two below.
    const target = rows[2]!;
    const view = libraryView(rows.filter((r) => r !== target));
    const truth = insertionTruth(target, view);
    expect(truth.bucket).toBe('loved');
    expect(truth.bandSize).toBe(4);
    expect(truth.rank).toBe(3);
    expect(truth.q).toBe(2 / 4);
    expect(truth.score).toBeCloseTo(10 - 0.5 * 3, 12);
    expect(truth.overall).toBe(2 / 9);
  });

  it('equals scoreFor at the post-insert band size for every achievable quantile', () => {
    for (const bucket of ['loved', 'fine', 'not_for_me'] as const) {
      for (let n = 0; n <= 12; n += 1) {
        for (let r = 1; r <= n + 1; r += 1) {
          const q = n === 0 ? 0 : (r - 1) / n;
          const sizes = { loved: 3, fine: 4, not_for_me: 2, [bucket]: n + 1 };
          const above =
            bucket === 'loved' ? 0 : bucket === 'fine' ? sizes.loved : sizes.loved + sizes.fine;
          expect(displayScore(bucket, q)).toBe(scoreFor(bucket, above + r, sizes));
          expect(
            Math.abs(projectScore(bucket, q) - scoreFor(bucket, above + r, sizes)),
          ).toBeLessThanOrEqual(0.05 + 1e-9);
        }
      }
    }
  });

  it('agrees with scoreFor when the truth is computed from a real hold-out', () => {
    const rows = list(7, 5, 4);
    for (const target of rows) {
      const view = libraryView(rows.filter((r) => r !== target));
      // Put the target back: the app's score for it in the full list is what the truth says.
      const full = libraryView(rows);
      expect(insertionTruth(target, view).display).toBe(full.opinions.get(target.m)!.score);
    }
  });

  it('refuses a view that still holds the target', () => {
    const rows = list(2, 1, 0);
    expect(() => insertionTruth(rows[0]!, libraryView(rows))).toThrow('still holds the target');
  });
});

describe('bands of zero and one', () => {
  it('an empty band gives q = 0 and the band high', () => {
    const rows = list(3, 0, 1);
    const target = row('F-new', 'fine', 4);
    const view = libraryView(rows);
    const truth = insertionTruth(target, view);
    expect(truth.bandSize).toBe(0);
    expect(truth.rank).toBe(1);
    expect(truth.q).toBe(0);
    expect(truth.display).toBe(6.9);
    expect(truth.score).toBe(6.9);
  });

  it('a band of one splits into its top and its bottom', () => {
    const one = [row('L0', 'loved', 1), row('F0', 'fine', 2)];
    const above = insertionTruth({ ...row('L-top', 'loved', 1), p: 0 }, libraryView(one));
    expect(above.q).toBe(0);
    expect(above.display).toBe(10);
    const below = insertionTruth({ ...row('L-bottom', 'loved', 1), p: 1.5 }, libraryView(one));
    expect(below.q).toBe(1);
    expect(below.display).toBe(7);
  });

  it('a member of a band of one sits at the top, as scoreFor says', () => {
    const view = libraryView([row('L0', 'loved', 1)]);
    expect(view.opinions.get('L0')).toEqual({ bucket: 'loved', q: 0, overall: 0, score: 10 });
  });
});

describe('bucket boundaries', () => {
  it('projects each band onto its own closed range and never across', () => {
    expect(projectScore('loved', 0)).toBe(10);
    expect(projectScore('loved', 1)).toBe(7);
    expect(projectScore('fine', 0)).toBe(6.9);
    expect(projectScore('fine', 1)).toBeCloseTo(3.5, 12);
    expect(projectScore('not_for_me', 0)).toBe(3.4);
    expect(projectScore('not_for_me', 1)).toBe(0);
    for (const bucket of ['loved', 'fine', 'not_for_me'] as const) {
      for (let i = 0; i <= 100; i += 1) {
        const d = displayScore(bucket, i / 100);
        expect(bucketForScore(d)).toBe(bucket);
        expect(d).toBeLessThanOrEqual(BAND_RANGE[bucket].high);
        expect(d).toBeGreaterThanOrEqual(BAND_RANGE[bucket].low);
      }
    }
  });

  it('clamps a quantile outside [0, 1] to the band', () => {
    expect(projectScore('fine', -0.3)).toBe(6.9);
    expect(projectScore('fine', 1.7)).toBeCloseTo(3.5, 12);
  });
});

describe('the one-decimal display is separate from the internal prediction', () => {
  it('two different quantiles can print the same number and still be different predictions', () => {
    const a = 0.1;
    const b = 0.11;
    expect(displayScore('loved', a)).toBe(displayScore('loved', b));
    expect(projectScore('loved', a)).not.toBe(projectScore('loved', b));
  });

  it('keeps full precision below one decimal', () => {
    expect(projectScore('loved', 1 / 3)).toBeCloseTo(9, 12);
    expect(projectScore('loved', 0.123456)).toBeCloseTo(10 - 0.123456 * 3, 12);
    expect(displayScore('loved', 0.123456)).toBe(9.6);
  });
});

describe('carrying an overall quantile into a list', () => {
  it('lands in the band that owns that stretch of insertion slots', () => {
    const sizes = { loved: 6, fine: 3, not_for_me: 1 };
    const expectPlace = (overall: number, bucket: Bucket, q: number) => {
      const placed = placeOverall(overall, sizes)!;
      expect(placed.bucket).toBe(bucket);
      expect(placed.q).toBeCloseTo(q, 12);
    };
    expectPlace(0, 'loved', 0);
    expectPlace(0.3, 'loved', 0.5);
    expectPlace(0.6, 'loved', 1);
    expectPlace(0.75, 'fine', 0.5);
    expectPlace(1, 'not_for_me', 1);
  });

  it('never carries anything into a bucket the reader has not used', () => {
    const sizes = { loved: 4, fine: 0, not_for_me: 4 };
    for (let i = 0; i <= 20; i += 1)
      expect(placeOverall(i / 20, sizes)!.bucket).not.toBe('fine');
    expect(placeOverall(0.5, { loved: 0, fine: 0, not_for_me: 0 })).toBeNull();
  });

  it('round-trips through overallOf', () => {
    const sizes = { loved: 5, fine: 4, not_for_me: 3 };
    for (const bucket of ['loved', 'fine', 'not_for_me'] as const) {
      for (const q of [0.1, 0.5, 0.9]) {
        const back = placeOverall(overallOf(bucket, q, sizes), sizes)!;
        expect(back.bucket).toBe(bucket);
        expect(back.q).toBeCloseTo(q, 12);
      }
    }
  });
});
