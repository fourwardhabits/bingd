import type { CollectionItem } from './filters';
import { bandSizes, scoreFor, type Bucket } from './score';
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
): CollectionItem[] {
  const sizes = bandSizes(ranked);
  const byId = new Map(logged.map((entry) => [entry.mediaItemId, entry]));

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
    bucket: entry.bucket,
    // A ranked title's watch date and collection timestamp live on `user_media`, which
    // the logged query holds — so they are read across from there. See the note above
    // for what happens when the caller hands over a list this cannot find them in.
    watchedOn: byId.get(entry.mediaItemId)?.watchedOn ?? null,
    addedAt: byId.get(entry.mediaItemId)?.addedAt ?? null,
  }));

  const seen = new Set(items.map((item) => item.mediaItemId));

  for (const entry of filterByMedium(logged, medium)) {
    if (seen.has(entry.mediaItemId)) continue;
    items.push({ ...toItem(entry), score: null, bucket: null });
  }

  return items;
}

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
