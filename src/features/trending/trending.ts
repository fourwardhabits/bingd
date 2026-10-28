/**
 * One shelf out of two provider lists.
 *
 * Founder decision, 2026-08-16: the Feed gets **one mixed** Trending Now shelf, not a
 * movie row and a TV row. TV entries are series-level discovery — TMDB has no notion
 * of a trending *season*, and the cache key says `series` for that reason
 * (20260816000900).
 *
 * TREND RANK DECIDES WHO IS ON THE SHELF; POPULARITY ONLY ORDERS THEM
 *
 * Founder decision, 2026-10-28, replacing the 2026-08-16 merge rule. That rule sorted
 * all forty rows of both lists by `popularity` and kept twelve. `popularity` is a
 * slow-moving figure that accumulates over weeks, so a blockbuster at daily trend rank
 * 17 outranked whatever was #1 today — the shelf showed the same big titles for weeks
 * and left out what was actually trending now.
 *
 * Now the daily trend rank decides who gets on the shelf: the top six usable films and
 * the top six usable series. If one kind has fewer than six, the other fills the gap in
 * its own trend order, so a short list still gives a full shelf. Nothing below
 * that cut can displace a title above it, however popular it is.
 *
 * `popularity` then orders those twelve for presentation. It is the one figure TMDB
 * publishes on the same scale for both kinds, and it is already on `media_items`
 * because the adapter wrote it in the same request that produced these lists.
 *
 * Trend rank breaks ties and covers the case where popularity is missing, so a row
 * seeded from Wikidata and never enriched sinks to the bottom of the shelf instead of
 * to a random place in it. Kind and then id break whatever is left, so equal inputs
 * always render in the same order.
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

/** How many of each kind the trend rank admits before the other kind backfills. */
export const TRENDING_PER_KIND = TRENDING_SHELF_SIZE / 2;

/** Trend rank, then film before series, then id — so equal inputs render identically
 *  whatever order the two lists happened to arrive in. */
function tieBreak(a: TrendingCandidate, b: TrendingCandidate) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.kind !== b.kind) return a.kind === 'movie' ? -1 : 1;
  return a.mediaItemId < b.mediaItemId ? -1 : a.mediaItemId > b.mediaItemId ? 1 : 0;
}

export function mixTrending<T extends TrendingCandidate>(
  candidates: readonly T[],
  limit: number = TRENDING_SHELF_SIZE,
): T[] {
  const perKind = Math.min(TRENDING_PER_KIND, limit);
  const films = candidates.filter((item) => item.kind === 'movie').sort(tieBreak);
  const series = candidates.filter((item) => item.kind === 'series').sort(tieBreak);

  // Each kind's quota by trend rank, then whatever is left over fills the remaining
  // slots, still in trend order. Only a kind with more than its quota has anything left
  // over, so the backfill comes from the other kind whenever one falls short.
  const chosen = [...films.slice(0, perKind), ...series.slice(0, perKind)];
  const spare = [...films.slice(perKind), ...series.slice(perKind)];
  chosen.push(...spare.slice(0, Math.max(0, limit - chosen.length)));

  return chosen
    .sort((a, b) => {
      // Missing popularity sorts last rather than as zero-and-therefore-tied. Zero
      // would place an unenriched row *above* nothing and below everything, which is
      // where it belongs — but it would also tie two unenriched rows and leave them
      // ordered against each other by a rank that means different things on each
      // side. Sorting them together at the end keeps that comparison from happening.
      if (a.popularity == null && b.popularity == null) return tieBreak(a, b);
      if (a.popularity == null) return 1;
      if (b.popularity == null) return -1;
      if (a.popularity !== b.popularity) return b.popularity - a.popularity;
      return tieBreak(a, b);
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
