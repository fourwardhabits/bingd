import {
  BAND_RANGE,
  type BandSizes,
  bandSizes,
  bucketForScore,
  formatScore,
  rankInBand,
  revealFloor,
  scoreFor,
} from './score';

/**
 * The three edges from design-system.md §11, each of which produces a plausible
 * wrong answer rather than an obvious one:
 *
 *   - a band of one must not divide by zero,
 *   - the bottom of a band must land exactly on its low, and
 *   - two adjacent bands must not overlap, or a score stops implying a bucket.
 */

const sizes = (loved: number, fine: number, notForMe: number): BandSizes => ({
  loved,
  fine,
  not_for_me: notForMe,
});

describe('rankInBand', () => {
  it('offsets a band by the total size of the bands above it', () => {
    const s = sizes(3, 4, 2);

    expect(rankInBand('loved', 1, s)).toBe(1);
    expect(rankInBand('loved', 3, s)).toBe(3);
    // Position 4 is the first `fine` title, because all three `loved` ones
    // outrank it — invariant I2.
    expect(rankInBand('fine', 4, s)).toBe(1);
    expect(rankInBand('fine', 7, s)).toBe(4);
    expect(rankInBand('not_for_me', 8, s)).toBe(1);
    expect(rankInBand('not_for_me', 9, s)).toBe(2);
  });
});

describe('band edges', () => {
  it('the first title in a band scores the band high', () => {
    const s = sizes(5, 5, 5);
    expect(scoreFor('loved', 1, s)).toBe(10);
    expect(scoreFor('fine', 6, s)).toBe(6.9);
    expect(scoreFor('not_for_me', 11, s)).toBe(3.4);
  });

  it('the last title in a band scores the band low exactly', () => {
    const s = sizes(5, 5, 5);
    expect(scoreFor('loved', 5, s)).toBe(7);
    expect(scoreFor('fine', 10, s)).toBe(3.5);
    expect(scoreFor('not_for_me', 15, s)).toBe(0);
  });

  it('spreads the middle evenly across the range, rounded to one decimal', () => {
    // Loved spans 10.0–7.0 over five titles, so the exact step is 0.75 and the
    // interior values round to a single decimal: 9.25 shows as 9.3.
    const s = sizes(5, 0, 0);
    expect([1, 2, 3, 4, 5].map((p) => scoreFor('loved', p, s))).toEqual([
      10, 9.3, 8.5, 7.8, 7,
    ]);
  });

  it('rounding never makes two adjacent titles swap order', () => {
    // A long band has steps smaller than the rounding increment, so neighbours
    // can round to the same displayed score. They must never invert.
    const s = sizes(0, 0, 0);
    for (let size = 2; size <= 60; size += 1) {
      const band = { ...s, loved: size };
      for (let rank = 1; rank < size; rank += 1) {
        expect(scoreFor('loved', rank, band)).toBeGreaterThanOrEqual(
          scoreFor('loved', rank + 1, band),
        );
      }
    }
  });

  it('never returns negative zero at the bottom of the scale', () => {
    const s = sizes(0, 0, 4);
    const bottom = scoreFor('not_for_me', 4, s);
    expect(bottom).toBe(0);
    expect(Object.is(bottom, -0)).toBe(false);
    expect(formatScore(bottom)).toBe('0.0');
  });
});

describe('a band of one', () => {
  it('scores the high rather than dividing by zero', () => {
    const s = sizes(1, 1, 1);
    expect(scoreFor('loved', 1, s)).toBe(10);
    expect(scoreFor('fine', 2, s)).toBe(6.9);
    expect(scoreFor('not_for_me', 3, s)).toBe(3.4);
  });

  it('is finite for every band size from 1 to 50', () => {
    for (let size = 1; size <= 50; size += 1) {
      for (let position = 1; position <= size; position += 1) {
        const score = scoreFor('fine', position, sizes(0, size, 0));
        expect(Number.isFinite(score)).toBe(true);
      }
    }
  });
});

describe('the ranges do not overlap', () => {
  it('every score stays inside its own band, for every band size', () => {
    for (const bucket of ['loved', 'fine', 'not_for_me'] as const) {
      const { high, low } = BAND_RANGE[bucket];

      for (let size = 1; size <= 40; size += 1) {
        const s = { ...sizes(0, 0, 0), [bucket]: size };

        for (let rank = 1; rank <= size; rank += 1) {
          const score = scoreFor(bucket, rank, s);
          expect(score).toBeLessThanOrEqual(high);
          expect(score).toBeGreaterThanOrEqual(low);
        }
      }
    }
  });

  it('a score always implies exactly one bucket', () => {
    expect(bucketForScore(10)).toBe('loved');
    expect(bucketForScore(7)).toBe('loved');
    expect(bucketForScore(6.9)).toBe('fine');
    expect(bucketForScore(3.5)).toBe('fine');
    expect(bucketForScore(3.4)).toBe('not_for_me');
    expect(bucketForScore(0)).toBe('not_for_me');
  });

  it('round-trips: any derived score maps back to the bucket it came from', () => {
    for (const bucket of ['loved', 'fine', 'not_for_me'] as const) {
      for (let size = 1; size <= 30; size += 1) {
        const s = { ...sizes(0, 0, 0), [bucket]: size };
        for (let rank = 1; rank <= size; rank += 1) {
          expect(bucketForScore(scoreFor(bucket, rank, s))).toBe(bucket);
        }
      }
    }
  });
});

describe('order is preserved', () => {
  it('a better position always scores at least as high as a worse one', () => {
    const s = sizes(0, 23, 0);
    for (let rank = 1; rank < 23; rank += 1) {
      expect(scoreFor('fine', rank, s)).toBeGreaterThanOrEqual(scoreFor('fine', rank + 1, s));
    }
  });

  it('every loved title outscores every fine title, and fine outscores not for me', () => {
    const s = sizes(12, 12, 12);
    const loved = Array.from({ length: 12 }, (_, i) => scoreFor('loved', i + 1, s));
    const fine = Array.from({ length: 12 }, (_, i) => scoreFor('fine', 13 + i, s));
    const notForMe = Array.from({ length: 12 }, (_, i) => scoreFor('not_for_me', 25 + i, s));

    expect(Math.min(...loved)).toBeGreaterThan(Math.max(...fine));
    expect(Math.min(...fine)).toBeGreaterThan(Math.max(...notForMe));
  });
});

describe('scores reflow as the list grows', () => {
  // This is correct behaviour, not a bug, and it is asserted so nobody "fixes"
  // it later: the score was always a statement about relative position.
  it('adding a title below shifts the ones above it down the range', () => {
    expect(scoreFor('loved', 1, sizes(1, 0, 0))).toBe(10);
    expect(scoreFor('loved', 2, sizes(2, 0, 0))).toBe(7);
    expect(scoreFor('loved', 2, sizes(3, 0, 0))).toBe(8.5);
  });
});

describe('bandSizes', () => {
  it('counts rows per bucket', () => {
    expect(
      bandSizes([
        { bucket: 'loved' },
        { bucket: 'loved' },
        { bucket: 'fine' },
        { bucket: 'not_for_me' },
      ]),
    ).toEqual({ loved: 2, fine: 1, not_for_me: 1 });
  });

  it('is all zeroes for an empty collection', () => {
    expect(bandSizes([])).toEqual({ loved: 0, fine: 0, not_for_me: 0 });
  });
});

describe('formatting', () => {
  it('always shows one decimal, including for whole numbers', () => {
    expect(formatScore(10)).toBe('10.0');
    expect(formatScore(7)).toBe('7.0');
    expect(formatScore(8.7)).toBe('8.7');
  });
});

describe('revealFloor', () => {
  it('starts the count-up inside the band, not at zero', () => {
    expect(revealFloor('loved')).toBe(7);
    expect(revealFloor('fine')).toBe(3.5);
    expect(revealFloor('not_for_me')).toBe(0);
  });
});
