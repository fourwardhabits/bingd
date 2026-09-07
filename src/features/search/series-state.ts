import type { LoggedEntry } from '@/features/collection/use-collection';

/**
 * What a reader has done with the seasons of one series.
 *
 * `ranked` is a subset of `watched`: ranking a season logs it, so a season that has a
 * position is also in the collection. The two counts are kept apart anyway, because they
 * are two different sentences a search row can say and only one of them is drawn.
 */
export type SeriesChildState = { watched: number; ranked: number };

/**
 * Season activity, grouped by the series it belongs to.
 *
 * **The bug this exists for** (founder, physical Android, 2026-09-07): a reader who had
 * ranked *Terrace House: Aloha State* S1 searched the show and got a series row with a
 * bare `+` on it — identical to a title they had never heard of. Their collection was
 * right and their search was wrong, about the same fact, at the same moment.
 *
 * The cause is that the fact is recorded against the *season* and the row is about the
 * *series*, and nothing joined the two. Search knew every season the reader had logged
 * and every score they had given; it had no way to ask which series a logged season
 * belonged to, because the logged-collection read carried the parent's title and not the
 * parent's id. It carries `seriesId` now, and this is the grouping that uses it.
 *
 * **A series still has no score and never gets one.** Seasons are the rankable unit
 * (PRD §10) and a mean over a reader's seasons would be a number bingd. does not hold
 * and cannot defend — it would also disagree with the season's own score the moment
 * anybody opened the show. What a series row may honestly say is how much of it the
 * reader has already been through, which is what this counts.
 *
 * Movies and series rows in the collection are ignored: a movie has no parent, and a
 * logged *series* row is a watchlist-shaped fact about the show itself rather than
 * evidence about its seasons.
 */
export function seriesChildState(
  entries: readonly LoggedEntry[],
  isRanked: (mediaItemId: string) => boolean,
): Map<string, SeriesChildState> {
  const bySeries = new Map<string, SeriesChildState>();

  for (const entry of entries) {
    if (entry.kind !== 'season') continue;
    const seriesId = entry.seriesId;
    if (!seriesId) continue;

    const current = bySeries.get(seriesId) ?? { watched: 0, ranked: 0 };
    current.watched += 1;
    if (isRanked(entry.mediaItemId)) current.ranked += 1;
    bySeries.set(seriesId, current);
  }

  return bySeries;
}

/**
 * The compact clause a series row adds about the reader's own history with it.
 *
 * Ranked wins over watched when both are true, because ranked is the stronger statement
 * and stacking them ("2 watched · 1 ranked") would spend a third of the row on
 * arithmetic the reader can do. Null when there is nothing to say, so the caller adds
 * nothing rather than adding an empty segment.
 *
 * Deliberately a count and not a score: see {@link seriesChildState}.
 */
export function seriesStateLabel(state: SeriesChildState | undefined): string | null {
  if (!state) return null;
  if (state.ranked > 0) return `${state.ranked} ranked`;
  if (state.watched > 0) return `${state.watched} watched`;
  return null;
}

/**
 * The whole secondary line for a series search row.
 *
 * Three facts at most, in widening order of what they are about: what kind of thing this
 * is, how big it is, and what the reader has done with it. The season count is omitted
 * when the catalogue has not looked the series up yet — "0 seasons" would be the app
 * stating as fact something it has not fetched — and the reader's own clause is omitted
 * when there is nothing to say.
 */
export function seriesSecondaryLine(
  seasonCount: number | null | undefined,
  state: SeriesChildState | undefined,
): string {
  const parts = ['Series'];
  if (seasonCount) parts.push(`${seasonCount} seasons`);
  const mine = seriesStateLabel(state);
  if (mine) parts.push(mine);
  return parts.join(' · ');
}
