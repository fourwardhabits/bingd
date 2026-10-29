/**
 * One shelf out of two provider lists.
 *
 * Founder decision, 2026-08-16: the Feed gets **one mixed** Trending Now shelf, not a
 * movie row and a TV row. TV entries are series-level discovery — TMDB has no notion
 * of a trending *season*, and the cache key says `series` for that reason
 * (20260816000900).
 *
 * DAILY TREND RANK DECIDES WHO IS ON THE SHELF AND THE ORDER THEY APPEAR IN
 *
 * Founder decisions, 2026-10-28, replacing the 2026-08-16 merge rule. That rule sorted
 * all forty rows of both lists by `popularity` and kept twelve. `popularity` is a
 * slow-moving figure that accumulates over weeks, so a blockbuster at daily trend rank
 * 17 outranked whatever was #1 today — the shelf showed the same big titles for weeks
 * and left out what was actually trending now.
 *
 * Who: the top six usable films and the top six usable series by daily trend rank. If
 * one kind has fewer than six, the other fills the gap in its own trend order, so a
 * short list still gives a full shelf. Nothing below that cut can displace a title
 * above it.
 *
 * Order: film #1, series #1, film #2, series #2, and so on, then whatever the backfill
 * added, still in trend order. A first version ordered the twelve by `popularity`, and
 * QA found it made the shelf read as "what has been big for weeks" rather than "what is
 * trending now": today's #1 film sat eighth. A combined movie-and-TV ranking was
 * simulated and rejected the same day, because it tracked the outside world no better
 * and TMDB's combined list leans heavily towards films.
 *
 * "#1" means the first *usable* title of its kind, not the provider's raw position. An
 * id with no `media_items` row is dropped before this runs, leaving a gap in `rank`;
 * counting position within the kind means a missing film does not push every later
 * film a slot behind the series beside it.
 *
 * Popularity has no part in either step, and is not on `TrendingCandidate` so that it
 * cannot quietly come back.
 */

export type TrendingCandidate = {
  mediaItemId: string;
  kind: 'movie' | 'series';
  /** 0-based position in its own provider list. Lower is more trending. */
  rank: number;
};

/** Enough to fill a shelf twice over without the Feed becoming a discovery page.
 *  The social feed is the screen; this is the strip above it. */
export const TRENDING_SHELF_SIZE = 12;

/** How many of each kind the trend rank admits before the other kind backfills. */
export const TRENDING_PER_KIND = TRENDING_SHELF_SIZE / 2;

/** Trend rank, then id — so one kind's titles line up identically whatever order the
 *  list happened to arrive in. */
function byTrendRank(a: TrendingCandidate, b: TrendingCandidate) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.mediaItemId < b.mediaItemId ? -1 : a.mediaItemId > b.mediaItemId ? 1 : 0;
}

export function mixTrending<T extends TrendingCandidate>(
  candidates: readonly T[],
  limit: number = TRENDING_SHELF_SIZE,
): T[] {
  const perKind = Math.min(TRENDING_PER_KIND, limit);
  const films = candidates.filter((item) => item.kind === 'movie').sort(byTrendRank);
  const series = candidates.filter((item) => item.kind === 'series').sort(byTrendRank);

  // Each kind's quota by trend rank, then whatever slots are left go to whichever kind
  // has titles to spare. Only a kind with more than its quota has any, so the backfill
  // comes from the other kind whenever one falls short.
  let filmCount = Math.min(films.length, perKind);
  let seriesCount = Math.min(series.length, perKind);
  let open = Math.max(0, limit - filmCount - seriesCount);
  const extraFilms = Math.min(open, films.length - filmCount);
  filmCount += extraFilms;
  open -= extraFilms;
  seriesCount += Math.min(open, series.length - seriesCount);

  // Film before series at each position. Once the shorter kind runs out, the longer one
  // carries on alone, so backfilled titles follow everything the quota chose.
  const shownFilms = films.slice(0, filmCount);
  const shownSeries = series.slice(0, seriesCount);
  const shelf: T[] = [];
  for (let position = 0; position < Math.max(filmCount, seriesCount); position++) {
    const film = shownFilms[position];
    const show = shownSeries[position];
    if (film) shelf.push(film);
    if (show) shelf.push(show);
  }
  return shelf.slice(0, limit);
}

/**
 * Whether a cached list has passed its expiry.
 *
 * The row is served either way. `provider_list_cache` is written whole on every
 * refresh and nothing deletes it, so an expired payload is the last thing TMDB was
 * featuring rather than nothing at all — and a Feed that shows yesterday's trending
 * films is better than one with a hole in it where the adapter's schedule slipped.
 * The flag exists so a caller can decide *not* to show it, not because this module
 * has an opinion.
 */
export function isExpired(expiresAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!expiresAt) return true;
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) ? true : at <= now;
}

/**
 * How stale is too stale to show.
 *
 * Six hours is the TTL (`app_config.tmdb.cache_ttl_hours -> trending`). A week past
 * that is a list nobody refreshed, and "Trending now" over a fortnight-old list is a
 * claim the screen cannot support — so it is dropped rather than shown with a caveat
 * nobody would read.
 */
export const TRENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function isTooOldToShow(
  fetchedAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!fetchedAt) return true;
  const at = Date.parse(fetchedAt);
  return Number.isNaN(at) ? true : now - at > TRENDING_MAX_AGE_MS;
}
