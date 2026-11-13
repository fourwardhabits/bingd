import type { CollectionItem } from './filters';
import { rankingStateOf } from './ranking-state';
import { bandSizes, scoreFor, type Bucket } from './score';
import { projectShows, type ShowProjection } from './show-projection';
import type { LoggedEntry, RankedEntry, RankingCategory } from './use-collection';

export type WatchedRow = {
  mediaItemId: string;
  title: string;
  seriesTitle: string | null;
  year: number | null;
  posterPath: string | null;
  genres: string[];
  runtimeMinutes: number | null;
  score: number | null;
  bucket: Bucket | null;
};

/** Movies, or the TV side — a series and its seasons both belong to the latter. */
export function filterByMedium<T extends { kind: 'movie' | 'season' | 'series' }>(
  entries: readonly T[],
  medium: RankingCategory,
): T[] {
  return entries.filter((entry) =>
    medium === 'movies' ? entry.kind === 'movie' : entry.kind === 'season' || entry.kind === 'series',
  );
}


/**
 * Ranked titles by score, then everything watched but not yet ranked.
 *
 * **Why this deduplicates.** The two halves come from two independent queries —
 * `rankings` for the scored ones, `user_media` minus `rankings` for the rest — and
 * they are only *eventually* consistent. Ranking a title invalidates both, and
 * whichever refetch lands first is served fresh while the other is still stale. In
 * the window between them the title is in the ranked list *and* still in the stale
 * unranked list, so it renders twice and React reports two children with the same
 * key. That is the warning the founder saw, and it appeared right after ranking
 * because that is precisely when the two queries disagree.
 *
 * The key was not the bug and renaming it would have hidden the bug. The invariant
 * this list owes is one row per media item, and the merge is where that belongs:
 * whichever query is stale, a title appears once.
 *
 * The ranked entry wins, because it is the more advanced state. A title that has just
 * been given a position should show its score immediately rather than sitting at the
 * bottom with a dashed badge until the second query catches up.
 */
export function mergeWatched(
  ranked: readonly RankedEntry[],
  unranked: readonly LoggedEntry[],
  medium: RankingCategory,
): WatchedRow[] {
  // Band sizes come from the whole ranked category, before any filtering: a score is
  // only meaningful against every title in its band.
  const sizes = bandSizes(ranked);

  const rows: WatchedRow[] = ranked.map((entry) => ({
    mediaItemId: entry.mediaItemId,
    title: entry.title,
    seriesTitle: entry.seriesTitle,
    year: entry.year,
    posterPath: entry.posterPath,
    genres: entry.genres,
    runtimeMinutes: entry.runtimeMinutes,
    score: scoreFor(entry.bucket, entry.position, sizes),
    bucket: entry.bucket,
  }));

  const ranking = new Set(rows.map((row) => row.mediaItemId));

  for (const entry of filterByMedium(unranked, medium)) {
    if (ranking.has(entry.mediaItemId)) continue;
    rows.push({
      mediaItemId: entry.mediaItemId,
      title: entry.title,
      seriesTitle: null,
      year: entry.year,
      posterPath: entry.posterPath,
      genres: entry.genres,
      runtimeMinutes: entry.runtimeMinutes,
      score: null,
      bucket: null,
    });
  }

  // Already in position order from the query, which is score order. Sorting again
  // would only introduce a way for the two to disagree.
  return rows;
}

/**
 * The Watched list, as the shared shape every collection surface filters and sorts.
 *
 * `WatchedRow` predates the filter model and carries what a list row draws;
 * `CollectionItem` is what List, Wall and the filter sheet all agree on. Rather than
 * widen one into the other and have two names for one thing, the merge stays as it is
 * and this converts — which also keeps the language, the watch date and the collection
 * timestamp, which the rows never needed and the filters do.
 *
 * ---------------------------------------------------------------------------
 * THE SECOND ARGUMENT IS THE WHOLE LOGGED COLLECTION, NOT THE UNRANKED PART OF IT
 *
 * **This is the founder's photograph.** The chip said *Recently watched* and the wall
 * was plainly in rating order, and the cause was here: this function looked up a ranked
 * title's collection facts in a map built from its second argument, and the only caller
 * passed `logged.data.unranked` — a list from which every ranked title is, by
 * definition, absent. So the lookup missed on every ranked row, `watchedOn` came back
 * null for all of them, the recency comparator returned 0 for every pair, and
 * `Array.prototype.sort` left the rows in the order they arrived in. Which is score
 * order, because {@link mergeWatched}'s ranked half comes from the position query.
 *
 * A truthful label would not have fixed it and a working comparator would not have
 * fixed it: the rows genuinely had no date on them. So the argument is now the whole
 * logged collection and the name says so. The ranked/unranked split it used to carry is
 * recovered here for free — `seen` already skips anything the ranked half supplied — so
 * the appended rows are the same ones as before.
 */
export function watchedItems(
  ranked: readonly RankedEntry[],
  logged: readonly LoggedEntry[],
  medium: RankingCategory,
  /**
   * The TV side's second ranking, `tv_shows` (20261114000100): the whole shows the reader
   * ranked explicitly. Empty for Movies, and for a backend or a cache that has none.
   */
  shows: readonly RankedEntry[] = [],
): CollectionItem[] {
  const byId = new Map(logged.map((entry) => [entry.mediaItemId, entry]));

  // **TV is one poster per series** (WS-TVC, founder spec t168u §2): see `seriesItems`.
  if (medium === 'tv_seasons') return seriesItems(ranked, shows, logged);

  const sizes = bandSizes(ranked);
  const items: CollectionItem[] = ranked.map((entry) => ({
    mediaItemId: entry.mediaItemId,
    title: entry.title,
    seriesTitle: entry.seriesTitle,
    seasonNumber: entry.seasonNumber,
    kind: entry.kind,
    year: entry.year,
    posterPath: entry.posterPath,
    genres: entry.genres,
    language: entry.language,
    runtimeMinutes: entry.runtimeMinutes,
    score: scoreFor(entry.bucket, entry.position, sizes),
    // What the Rating order breaks an equal score on. See `CollectionItem.position`.
    position: entry.position,
    category: entry.category,
    bucket: entry.bucket,
    // A ranked title's watch date and collection timestamp live on `user_media`, which
    // the logged query holds — so they are read across from there.
    watchedOn: byId.get(entry.mediaItemId)?.watchedOn ?? null,
    addedAt: byId.get(entry.mediaItemId)?.addedAt ?? null,
  }));
  const seen = new Set(items.map((item) => item.mediaItemId));

  for (const entry of filterByMedium(logged, medium)) {
    if (seen.has(entry.mediaItemId)) continue;
    items.push({
      ...toItem(entry),
      score: null,
      bucket: null,
      unfinished: rankingStateOf({ ranked: false, bucket: entry.bucket }) === 'unfinished',
    });
  }

  return items;
}

/** The latest of two ISO dates or timestamps, either of which may be missing. */
const latest = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

/**
 * **The TV Collection: one poster per parent series** (WS-TVC, founder spec t168u §2,
 * replacing Candidate A's `standsAloneBeside`).
 *
 * Ranked: every series the reader ranked a season or the show of, once, carrying its
 * effective score (`projectShows`: the explicit show score, else the mean of the ranked
 * seasons). `mediaItemId` is the series, so a tap opens the show page. Seasons are never
 * posters here; both ladders are read and never reordered.
 *
 * Unranked (logged, never ranked): one poster per series as well, and a logged season or
 * show whose series already has a ranked poster is absorbed into it rather than shown
 * twice. A series' own logged row is used when there is one; otherwise the series is
 * drawn from its first logged season (the logged read carries no series artwork, so the
 * season's poster stands in). Only the series' own row can make a poster "unfinished":
 * a season's unfinished placement is resumed from that season's page, not from here.
 *
 * Recently watched and Recently added read the latest date among every logged row of the
 * series; Runtime stays hidden on Watched TV, as before (`offersRuntime` skips every
 * series poster made here, which all carry `showScore`).
 */
function seriesItems(
  seasons: readonly RankedEntry[],
  shows: readonly RankedEntry[],
  logged: readonly LoggedEntry[],
): CollectionItem[] {
  const tvLogged = filterByMedium(logged, 'tv_seasons');
  const seriesOf = (entry: { kind: string; mediaItemId: string; seriesId?: string | null }) =>
    entry.kind === 'series' ? entry.mediaItemId : (entry.seriesId ?? entry.mediaItemId);

  // Every logged row of a series, for its dates: one pass.
  const dates = new Map<string, { watchedOn: string | null; addedAt: string | null }>();
  for (const entry of tvLogged) {
    const key = seriesOf(entry);
    const was = dates.get(key) ?? { watchedOn: null, addedAt: null };
    dates.set(key, {
      watchedOn: latest(was.watchedOn, entry.watchedOn),
      addedAt: latest(was.addedAt, entry.addedAt),
    });
  }

  const ranked = projectShows(seasons, shows);
  const items: CollectionItem[] = ranked.map((p) => rankedSeriesItem(p, dates.get(p.seriesId)));
  const placed = new Set(ranked.map((p) => p.seriesId));
  const rankedIds = new Set([...seasons, ...shows].map((entry) => entry.mediaItemId));

  // Unranked, grouped by series: the series' own row if it is logged, else its first
  // logged season.
  const unranked = new Map<string, { own: LoggedEntry | null; first: LoggedEntry | null }>();
  for (const entry of tvLogged) {
    if (rankedIds.has(entry.mediaItemId)) continue;
    const key = seriesOf(entry);
    if (placed.has(key)) continue;
    const group = unranked.get(key) ?? { own: null, first: null };
    if (entry.kind === 'series') group.own = entry;
    else if (
      !group.first ||
      (entry.seasonNumber ?? Number.MAX_SAFE_INTEGER) <
        (group.first.seasonNumber ?? Number.MAX_SAFE_INTEGER)
    ) {
      group.first = entry;
    }
    unranked.set(key, group);
  }
  for (const [seriesId, { own, first }] of unranked) {
    const date = dates.get(seriesId);
    if (own) {
      items.push({
        ...toItem(own),
        score: null,
        bucket: null,
        watchedOn: date?.watchedOn ?? own.watchedOn,
        addedAt: date?.addedAt ?? own.addedAt,
        unfinished: rankingStateOf({ ranked: false, bucket: own.bucket }) === 'unfinished',
        // A TV Collection poster with no score yet (see `offersRuntime`).
        showScore: null,
      });
    } else if (first) {
      items.push({
        ...toItem(first),
        mediaItemId: seriesId,
        title: first.seriesTitle ?? first.title,
        seriesTitle: null,
        seasonNumber: null,
        kind: 'series',
        score: null,
        bucket: null,
        watchedOn: date?.watchedOn ?? first.watchedOn,
        addedAt: date?.addedAt ?? first.addedAt,
        unfinished: false,
        showScore: null,
      });
    }
  }

  return items;
}

/** One ranked series poster, from its projection. */
const rankedSeriesItem = (
  p: ShowProjection,
  date: { watchedOn: string | null; addedAt: string | null } | undefined,
): CollectionItem => ({
  mediaItemId: p.seriesId,
  title: p.title,
  seriesTitle: null,
  seasonNumber: null,
  kind: 'series',
  year: p.year,
  posterPath: p.posterPath,
  genres: p.genres,
  language: p.language,
  runtimeMinutes: null,
  score: p.display,
  position: p.tiePosition,
  category: 'tv_shows',
  bucket: p.bucket,
  watchedOn: date?.watchedOn ?? null,
  addedAt: date?.addedAt ?? null,
  showScore: {
    sumTenths: p.sumTenths,
    n: p.n,
    source: p.source,
    rankedSeasonCount: p.rankedSeasonCount,
  },
});

/** The Watchlist, in the same shape. Nothing on it is ranked, by construction. */
export const watchlistItems = (
  entries: readonly LoggedEntry[],
  medium: RankingCategory,
): CollectionItem[] => filterByMedium(entries, medium).map(toItem);

const toItem = (entry: LoggedEntry): CollectionItem => ({
  mediaItemId: entry.mediaItemId,
  title: entry.title,
  seriesTitle: entry.seriesTitle,
  seasonNumber: entry.seasonNumber,
  kind: entry.kind,
  year: entry.year,
  posterPath: entry.posterPath,
  genres: entry.genres,
  language: entry.language,
  runtimeMinutes: entry.runtimeMinutes,
  score: null,
  bucket: entry.bucket,
  watchedOn: entry.watchedOn,
  addedAt: entry.addedAt,
});
