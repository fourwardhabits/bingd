import type { RankingCategory } from '@/features/collection/use-collection';

/**
 * What a yearly goal counts, and what it refuses to count.
 *
 * Founder decision, 2026-08-16. The target lives in `watch_goals` (20260816000800);
 * nothing in the database counts against it, deliberately — the migration stores a
 * number and leaves the product rule to be stated where it can be read and tested.
 * This is that statement.
 *
 * Four rules, and each one is a way of not inflating a number the user will compare
 * against their own memory:
 *
 *   1. **The watch date is the only clock.** `watched_on` decides the year. Never
 *      `created_at` — the date a row entered Bingd is a fact about the app, and a
 *      backfill or an import would otherwise credit a decade of watching to the
 *      afternoon somebody signed up.
 *   2. **An unknown watch date counts for nothing.** A logged title with no
 *      `watched_on` is a title the user has not told us when they watched. Guessing
 *      "this year" is the same mistake as (1) in a smaller costume, and onboarding
 *      (which logs historical favourites with no date) makes it a live one.
 *   3. **A series is not a season.** `rankable_category` returns null for a series
 *      because a season is the rankable unit (PRD §10), and the TV goal counts
 *      seasons. A show with nine seasons must not be one tick, and must not be nine.
 *   4. **Distinct entities.** Counting is over media item ids, so a rewatch is one.
 *      `user_media` is keyed `(user_id, media_item_id)` and so cannot physically hold
 *      a second row for a rewatch today — which makes the set here look redundant. It
 *      is not: it is where the rule is *written down*, so that a later watch-history
 *      table cannot quietly turn a goal of 52 into a goal of 52 viewings.
 *
 * **What this cannot do, and knows it.** One `watched_on` per title means a film
 * watched in 2025 and rewatched in 2026 counts in 2026 and stops counting in 2025 —
 * the rewatch moved the only date there is. Independent review raised it on
 * 2026-08-16 and it is accepted rather than fixed: the alternative is a watch-history
 * table, which the decision specifying goals ruled out ("intentionally simple"). No
 * screen shows a past year, so nothing displays the loss today; the year-in-review
 * surface that would must not ship until this is resolved. See data-model.md.
 */

export type GoalCategory = RankingCategory;

export const GOAL_CATEGORIES: readonly GoalCategory[] = ['movies', 'tv_seasons'];

/** The label a goal is given on screen. `tv_seasons` is a schema word, not a noun. */
export const GOAL_LABEL: Record<GoalCategory, string> = {
  movies: 'Movies',
  tv_seasons: 'TV seasons',
};

/** The unit, for the sentence under a bar: "12 of 52 movies". */
export const GOAL_UNIT: Record<GoalCategory, { one: string; many: string }> = {
  movies: { one: 'movie', many: 'movies' },
  tv_seasons: { one: 'season', many: 'seasons' },
};

/** One row of the viewer's own collection, reduced to what a goal looks at. */
export type CountableWatch = {
  mediaItemId: string;
  kind: 'movie' | 'season' | 'series';
  watchedOn: string | null;
};

export type GoalCounts = Record<GoalCategory, number>;

/**
 * The client mirror of `rankable_category(media_kind)` (20260813000400).
 *
 * Null for a series, for the reason stated there: a series has no position and,
 * here, no place in either goal. Rule 3 is this function returning null and the
 * caller respecting it, rather than a special case further down.
 */
export function goalCategoryOf(kind: CountableWatch['kind']): GoalCategory | null {
  if (kind === 'movie') return 'movies';
  if (kind === 'season') return 'tv_seasons';
  return null;
}

/**
 * The half-open calendar year as the database stores dates.
 *
 * `watched_on` is a `date`, not a timestamp, and this is a lexical range over
 * `YYYY-MM-DD` — no `Date` object is constructed anywhere in this file. A `Date`
 * would introduce the device's timezone into a comparison that has none: `new
 * Date('2026-01-01')` is midnight UTC, which is the 31st of December in Los
 * Angeles, and a January 1st watch would fall out of its own year for half the
 * planet.
 */
export function yearRange(year: number): { from: string; to: string } {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/** `YYYY-MM-DD…`, the only shape a year can be read off. */
const DATE = /^(\d{4})-\d{2}-\d{2}/;

/**
 * Whether a watch date falls in a goal year.
 *
 * A value that is not a date is not in any year. That is stricter than parsing
 * leniently and it is the right direction: an unrecognised date counting toward the
 * current year would be rule 2 broken by accident.
 */
export function watchedInYear(watchedOn: string | null, year: number): boolean {
  if (!watchedOn) return false;
  const match = DATE.exec(watchedOn);
  return match ? match[1] === String(year) : false;
}

/**
 * Exactly which watches counted, per medium.
 *
 * **This is the function, and `countWatched` is now a `.length` of it.** The founder's
 * correction is that a progress row should open into the titles behind it, and the
 * failure mode of adding that as a second query is a list that disagrees with the
 * number above it — four rules applied twice, in two places, drifting apart at the
 * first edit. One traversal, one set of rules, and the count is derived from the list
 * rather than computed beside it.
 *
 * Generic over the row so a caller carrying artwork and a title gets those back: the
 * rules only look at `kind` and `watchedOn`, and nothing here needs to know what else
 * is on the row.
 *
 * Rule 4 lives here as the `seen` set — a media item counts once however many rows
 * name it, and the *first* row for an id is the one kept, so the list is stable under
 * a re-fetch that returns the same rows in the same order.
 */
export function qualifyingWatches<T extends CountableWatch>(
  rows: readonly T[],
  year: number,
): Record<GoalCategory, T[]> {
  const out: Record<GoalCategory, T[]> = { movies: [], tv_seasons: [] };
  const seen = new Set<string>();

  for (const row of rows) {
    if (!watchedInYear(row.watchedOn, year)) continue;
    const category = goalCategoryOf(row.kind);
    if (!category) continue;
    if (seen.has(row.mediaItemId)) continue;
    seen.add(row.mediaItemId);
    out[category].push(row);
  }

  return out;
}

/**
 * How many distinct things the viewer watched in `year`, per medium.
 *
 * Always returns both keys, including zeroes: a medium with a goal and no watches
 * yet has to render `0 of 52`, and an absent key would render nothing at all.
 */
export function countWatched(rows: readonly CountableWatch[], year: number): GoalCounts {
  const qualifying = qualifyingWatches(rows, year);
  return { movies: qualifying.movies.length, tv_seasons: qualifying.tv_seasons.length };
}

export type GoalStatus = {
  category: GoalCategory;
  target: number;
  count: number;
  /** Never negative. Someone past their goal has none remaining, not "-3 left". */
  remaining: number;
  /** 0..1, clamped, for the bar. A goal beaten is a full bar, not an overflowing one. */
  fraction: number;
  complete: boolean;
};

export function goalStatus(category: GoalCategory, target: number, count: number): GoalStatus {
  return {
    category,
    target,
    count,
    remaining: Math.max(0, target - count),
    // `target` cannot be zero — the check constraint starts at 1 — but a client that
    // divided by a number it had not proved non-zero would be one schema change away
    // from rendering NaN%.
    fraction: target > 0 ? Math.min(1, count / target) : 0,
    complete: count >= target,
  };
}

/** "12 of 52 movies", the line under a bar. */
export function goalSentence(status: GoalStatus): string {
  const unit = GOAL_UNIT[status.category];
  return `${status.count} of ${status.target} ${status.target === 1 ? unit.one : unit.many}`;
}
