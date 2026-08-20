/**
 * One shelf out of two provider lists.
 *
 * Founder decision, 2026-08-16: the Feed gets **one mixed** Trending Now shelf, not a
 * movie row and a TV row. TV entries are series-level discovery — TMDB has no notion
 * of a trending *season*, and the cache key says `series` for that reason
 * (20260816000900).
 *
 * WHY POPULARITY IS THE MERGE KEY
 *
 * The two lists arrive ordered by trend rank *within their kind*, and rank is not
 * comparable across them: the third-most-trending series and the third-most-trending
 * film are both "3" and are not equally trending. Merging on rank would therefore
 * alternate film, show, film, show — a 50/50 shelf produced by the merge rather than
 * by the data, which is the artificial quota the decision asked not to build.
 *
 * `popularity` is the one figure TMDB publishes on the same scale for both, and it is
 * already on `media_items` because the adapter wrote it in the same request that
 * produced these lists. Sorting the union by it is the whole rule. Films tend to
 * dominate the result, which is what the decision expected — but they dominate
 * because of what TMDB reports, and a week where television genuinely leads will show
 * television leading rather than being held to a quota.
 *
 * Trend rank breaks ties and covers the case where popularity is missing, so a row
 * seeded from Wikidata and never enriched sinks to the bottom of its own list instead
 * of to a random place in the shelf.
 */

export type TrendingCandidate = {
  mediaItemId: string;
  kind: 'movie' | 'series';
  /** 0-based position in its own provider list. Lower is more trending. */
  rank: number;
  popularity: number | null;
};

/** Enough to fill a shelf twice over without the Feed becoming a discovery page.
 *  The social feed is the screen; this is the strip above it. */
export const TRENDING_SHELF_SIZE = 12;

export function mixTrending<T extends TrendingCandidate>(
  candidates: readonly T[],
  limit: number = TRENDING_SHELF_SIZE,
): T[] {
  return [...candidates]
    .sort((a, b) => {
      // Missing popularity sorts last rather than as zero-and-therefore-tied. Zero
      // would place an unenriched row *above* nothing and below everything, which is
      // where it belongs — but it would also tie two unenriched rows and leave them
      // ordered against each other by a rank that means different things on each
      // side. Sorting them together at the end keeps that comparison from happening.
      if (a.popularity == null && b.popularity == null) return a.rank - b.rank;
      if (a.popularity == null) return 1;
      if (b.popularity == null) return -1;
      if (a.popularity !== b.popularity) return b.popularity - a.popularity;
      return a.rank - b.rank;
    })
    .slice(0, limit);
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
