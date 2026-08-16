/**
 * The 0–10 score, derived from a title's ordinal position inside its bucket band.
 *
 * Source: docs/product/PRD.md §10 and docs/architecture/ranking.md §11.
 *
 * Nothing here writes anything. `rankings.position` stays the ground truth and
 * the score is a projection of it, computed where it is rendered. That is the
 * whole design: a score depends on the *size* of its band, not on anything in
 * its own row, so storing it would mean rewriting every row in a band whenever
 * one title is inserted — and then keeping those rewrites consistent with the
 * position shift that triggered them. A derived value has nothing to keep in
 * step.
 *
 * The one snapshot lives in `feed_events.payload`, written server-side at rank
 * finalize, because a client cannot derive another user's score without that
 * user's band sizes.
 */

export type Bucket = 'loved' | 'fine' | 'not_for_me';

/**
 * Closed, non-overlapping. The gaps matter: 7.0 is the worst *Loved it* and 6.9
 * the best *It was fine*, so a bucket is always recoverable from a score. That
 * is what lets the feed show a friend's number without also shipping their
 * bucket, and what lets the badge tint by bucket without the tint being the
 * only signal (design-system.md §3).
 */
export const BAND_RANGE: Record<Bucket, { high: number; low: number }> = {
  loved: { high: 10, low: 7 },
  fine: { high: 6.9, low: 3.5 },
  not_for_me: { high: 3.4, low: 0 },
};

/** How many ranked titles sit in each band, for one user and one category. */
export type BandSizes = Record<Bucket, number>;

export const emptyBandSizes = (): BandSizes => ({ loved: 0, fine: 0, not_for_me: 0 });

/**
 * Band sizes from a category's ranked rows.
 *
 * `useRankedCollection` already returns `bucket` for every row, so this needs no
 * extra query — the client has everything required to score the whole list the
 * moment the list arrives.
 */
export const bandSizes = (rows: readonly { bucket: Bucket }[]): BandSizes => {
  const sizes = emptyBandSizes();
  for (const row of rows) sizes[row.bucket] += 1;
  return sizes;
};

/**
 * Rank within the band, 1-based.
 *
 * `position` is absolute across the whole category and bands are contiguous in
 * position order — every `loved` title outranks every `fine` one, which is
 * invariant I2 in ranking.md — so a band's offset is just the total size of the
 * bands above it.
 */
export const rankInBand = (bucket: Bucket, position: number, sizes: BandSizes): number => {
  const above = bucket === 'loved' ? 0 : bucket === 'fine' ? sizes.loved : sizes.loved + sizes.fine;
  return position - above;
};

/**
 * Interpolate a rank across its band's range.
 *
 * The `max(size - 1, 1)` denominator does two jobs. It avoids dividing by zero
 * for a band of one, and it makes the last title in a band land exactly on the
 * band's low rather than one step short of it — with `size` as the denominator
 * the bottom of a band would never reach its floor, and the ranges would stop
 * meeting cleanly.
 *
 * A band of one scores the high, not the midpoint. The first title you ever
 * call *Loved it* is, at that moment, genuinely the best thing in your list.
 */
export const scoreFor = (bucket: Bucket, position: number, sizes: BandSizes): number => {
  const { high, low } = BAND_RANGE[bucket];
  const size = sizes[bucket];
  const rank = rankInBand(bucket, position, sizes);

  if (size <= 1 || rank <= 1) return high;
  if (rank >= size) return low;

  const step = (high - low) / (size - 1);
  return round1(high - (rank - 1) * step);
};

/** One decimal, and never `-0`. */
const round1 = (value: number) => {
  const rounded = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded;
};

/**
 * How a score is written. Always one decimal, including whole numbers — `7`
 * next to `8.7` in a column reads as a different kind of value, and the badge
 * is set in tabular figures precisely so the decimal place lines up.
 */
export const formatScore = (score: number): string => score.toFixed(1);

/** Which band a score belongs to. The inverse of the table above. */
export const bucketForScore = (score: number): Bucket => {
  if (score >= BAND_RANGE.loved.low) return 'loved';
  if (score >= BAND_RANGE.fine.low) return 'fine';
  return 'not_for_me';
};

/**
 * Where the reveal's count-up starts (design-system.md §9).
 *
 * The low end of the title's own band, not zero. Counting a *Not for me* title
 * up from 0.0 sprints through the whole scale to land at 1.2, which reads as
 * the app deciding the film was better than it was and then correcting itself.
 * Starting inside the band makes the animation say what actually happened: the
 * user chose a bucket, and this is where the title landed within it.
 */
export const revealFloor = (bucket: Bucket): number => BAND_RANGE[bucket].low;
