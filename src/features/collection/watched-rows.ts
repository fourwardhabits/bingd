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
