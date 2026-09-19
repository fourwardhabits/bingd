/**
 * Band geometry: where a title sits, and where a new one would land.
 *
 * Position and band sizes are the truth (ranking.md §11). A score is only ever a projection of
 * them, and the projection is the app's own: `BAND_RANGE` and `scoreFor` are imported, not
 * restated, so the harness cannot drift from what a reader would see.
 *
 * Two quantiles, and which one means what:
 *
 * - **Member quantile.** A title already in a band of n, at in-band rank r, sits at
 *   (r−1)/(n−1). That is how `scoreFor` interpolates it, and it describes an opinion that
 *   already exists (another rater's, or one of the reader's own titles).
 * - **Insertion quantile.** A title *not yet* in a band of n that would land at rank r sits at
 *   q = (r−1)/n. The band becomes n+1, so this is exactly `scoreFor` after the insert. It is
 *   what "if you ranked it today" means, so it is what every truth and every prediction is
 *   stated in.
 */

import {
  BAND_RANGE,
  emptyBandSizes,
  scoreFor,
  type BandSizes,
  type Bucket,
} from '@/features/collection/score';

import type { SnapshotRanking } from './snapshot';

export const BUCKET_ORDER: readonly Bucket[] = ['loved', 'fine', 'not_for_me'];

/** How many titles sit in the bands above `bucket`. */
export const offsetAbove = (bucket: Bucket, sizes: BandSizes): number =>
  bucket === 'loved' ? 0 : bucket === 'fine' ? sizes.loved : sizes.loved + sizes.fine;

export const totalOf = (sizes: BandSizes): number =>
  sizes.loved + sizes.fine + sizes.not_for_me;

/**
 * A subset of one person's list in one category, ordered by stored position.
 *
 * A subset because every evaluation reads the list *minus* something: the held-out fold in
 * P2, or everything placed after a moment in P1. Removing rows never reorders the rest, so the
 * relative order of what remains is the relative order the person gave it.
 */
export type LibraryView = {
  rows: readonly SnapshotRanking[];
  sizes: BandSizes;
  total: number;
  /** m → the row's opinion inside this view. */
  opinions: Map<string, Opinion>;
};

/** One existing opinion, in the three coordinates the harness uses. */
export type Opinion = {
  bucket: Bucket;
  /** Member quantile within the band: 0 is the top. */
  q: number;
  /** Member quantile over the whole view: 0 is the top. */
  overall: number;
  /** The one-decimal score the app would print for it, in this view. */
  score: number;
};

export function libraryView(rows: readonly SnapshotRanking[]): LibraryView {
  const ordered = [...rows].sort((a, b) => a.p - b.p);
  const sizes = emptyBandSizes();
  for (const r of ordered) sizes[r.b] += 1;
  const total = ordered.length;
  const opinions = new Map<string, Opinion>();
  ordered.forEach((row, index) => {
    const position = index + 1;
    const rank = position - offsetAbove(row.b, sizes);
    const size = sizes[row.b];
    opinions.set(row.m, {
      bucket: row.b,
      q: size <= 1 ? 0 : (rank - 1) / (size - 1),
      overall: total <= 1 ? 0 : (position - 1) / (total - 1),
      score: scoreFor(row.b, position, sizes),
    });
  });
  return { rows: ordered, sizes, total, opinions };
}

/** Where a title really landed, stated against the view it was held out of. */
export type Truth = {
  bucket: Bucket;
  /** Insertion rank in its band, 1-based. */
  rank: number;
  /** The band's size *before* the insert. */
  bandSize: number;
  /** Insertion quantile, (rank − 1) / bandSize, and 0 for an empty band. */
  q: number;
  /** Continuous display-unit score, before rounding. */
  score: number;
  /** What the app would print: `scoreFor` at the post-insert band sizes. */
  display: number;
  /** Insertion quantile over the whole list. */
  overall: number;
};

/**
 * The truth for `target` against `view`, which must not contain it.
 *
 * Its rank is one more than the number of same-band titles in the view that sit above it in
 * the person's current order. Nothing else in the view moves, which is what makes a hold-out
 * of the current list honest about order.
 */
export function insertionTruth(target: SnapshotRanking, view: LibraryView): Truth {
  if (view.opinions.has(target.m))
    throw new Error('insertionTruth: the view still holds the target');
  let above = 0;
  for (const row of view.rows) if (row.b === target.b && row.p < target.p) above += 1;
  const bandSize = view.sizes[target.b];
  const rank = above + 1;
  const q = bandSize === 0 ? 0 : (rank - 1) / bandSize;
  const after: BandSizes = { ...view.sizes, [target.b]: bandSize + 1 };
  const position = offsetAbove(target.b, view.sizes) + rank;
  return {
    bucket: target.b,
    rank,
    bandSize,
    q,
    score: projectScore(target.b, q),
    display: scoreFor(target.b, position, after),
    overall: view.total === 0 ? 0 : (position - 1) / view.total,
  };
}

/**
 * A bucket and an insertion quantile, in display units, **before** rounding.
 *
 * This is where the internal prediction meets the 0–10 scale and nowhere else. It equals
 * `scoreFor` exactly whenever q is an achievable insertion quantile (asserted in the tests),
 * and it is continuous everywhere else, because a prediction's q need not be one.
 */
export function projectScore(bucket: Bucket, q: number): number {
  const { high, low } = BAND_RANGE[bucket];
  const clamped = Math.min(1, Math.max(0, q));
  return high - clamped * (high - low);
}

/**
 * The one-decimal number a reader would be shown.
 *
 * Display only. No metric, interval or threshold in the harness reads it except the rounded
 * MAE, which is reported beside the unrounded one precisely so the two can be told apart.
 */
export function displayScore(bucket: Bucket, q: number): number {
  const rounded = Math.round(projectScore(bucket, q) * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

/** A predicted bucket and q, as an overall insertion quantile of the reader's list. */
export function overallOf(bucket: Bucket, q: number, sizes: BandSizes): number {
  const total = totalOf(sizes);
  if (total === 0) return 0;
  const clamped = Math.min(1, Math.max(0, q));
  return (offsetAbove(bucket, sizes) + clamped * sizes[bucket]) / total;
}

/**
 * Carry an overall quantile into a list's geometry: which band it lands in, and where.
 *
 * The insertion slots of a list of T run from 0 (above everything) to T (below everything),
 * and each band owns a contiguous stretch of them. An empty band owns none, so nothing is
 * carried into a bucket the reader has never used. Returns null for an empty list.
 */
export function placeOverall(
  overall: number,
  sizes: BandSizes,
): { bucket: Bucket; q: number } | null {
  const total = totalOf(sizes);
  if (total === 0) return null;
  const slot = Math.min(1, Math.max(0, overall)) * total;
  let start = 0;
  let last: { bucket: Bucket; q: number } | null = null;
  for (const bucket of BUCKET_ORDER) {
    const size = sizes[bucket];
    if (size === 0) continue;
    if (slot <= start + size) return { bucket, q: (slot - start) / size };
    last = { bucket, q: 1 };
    start += size;
  }
  return last;
}
