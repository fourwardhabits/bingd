import { useQuery } from '@tanstack/react-query';

import { bandSizes, scoreFor } from '@/features/collection/score';
import {
  readRankedCollection,
  type RankedEntry,
  type RankingCategory,
} from '@/features/collection/use-collection';

import type { RankedSummaryTitle } from './RankedSummary';

/**
 * **Where a sitting's titles stand now, not where each one landed** (QA corrections,
 * 2026-11-06).
 *
 * Phone QA ended a backlog sitting on two rows that both said `#9 in Movies · 8.9`:
 * Pitch Black and Allied. Positions are unique per user and category (the deferrable
 * `rankings_position_unique`), so the two could never both be ninth. Each row was the
 * `placed` step its own placement returned, kept as it was: Pitch Black finished at #9,
 * then Allied was placed at #9, the server shifted Pitch Black to #10, and the
 * summary still showed the earlier answer.
 *
 * The score was stale for the same reason. A score is not stored; `score_for` derives it
 * from the title's rank *within its band* and the band's *size*, so every insertion
 * re-scores the whole band. Both 8.9s were true when they were returned (rank 9 of 22
 * and rank 9 of 23 in *I liked it* both round to 8.9). After Allied, Pitch Black
 * (rank 10 of 23) is 8.8.
 *
 * So the summary no longer shows snapshots. It reads the ranking afresh, under a key
 * that names this sitting and how many placements it has made, and derives each
 * title's position and score from that read with the same `scoreFor` the Collection
 * uses. Nothing about how titles are placed or scored changes. A position the read
 * cannot vouch for is left out rather than guessed: the row component already omits a
 * position or score it is not given.
 */

/** Each title's place and score, from one read of the whole category. Pure. */
export function settleStanding(
  titles: readonly RankedSummaryTitle[],
  rows: readonly Pick<RankedEntry, 'mediaItemId' | 'bucket' | 'position'>[],
): RankedSummaryTitle[] {
  const sizes = bandSizes(rows);
  const byId = new Map(rows.map((row) => [row.mediaItemId, row]));
  return titles.map((title) => {
    const row = byId.get(title.mediaItemId);
    // No longer ranked, which another device can do mid-sitting: no number at all is
    // better than the one this sitting last saw.
    if (!row) return { ...title, position: null, score: null };
    return {
      ...title,
      position: row.position,
      score: scoreFor(row.bucket, row.position, sizes),
      bucket: row.bucket,
    };
  });
}

/** The same titles with their numbers withheld, while a read is out or after it failed. */
const withheld = (titles: readonly RankedSummaryTitle[]): RankedSummaryTitle[] =>
  titles.map((title) => ({ ...title, position: null, score: null }));

export type SettledStanding = {
  titles: RankedSummaryTitle[];
  /** `settling` while the read is out, `failed` once it has given up, else `settled`. */
  state: 'settling' | 'settled' | 'failed';
  retry: () => void;
};

/**
 * The summary's rows, settled against a read made after the sitting's last placement.
 *
 * **Why a key of its own.** The shared `rankings` cache is invalidated after every
 * placement, but invalidated data is still served while it refetches, and a summary
 * that rendered it would show the snapshot problem one step removed. A key that names
 * the sitting and its placement count has no earlier entry to serve: the first data it
 * holds is a read issued after that placement. A sitting that places more and returns
 * to the summary asks under a new count, so a second summary is never the first one's
 * copy. `gcTime: 0` keeps these one-off copies out of the cache once the summary goes.
 */
export function useSettledStanding({
  userId,
  medium,
  sitting,
  titles,
  enabled,
}: {
  userId: string;
  medium: RankingCategory;
  /** The sitting's id, so another sitting's read is never this one's. */
  sitting: string;
  titles: readonly RankedSummaryTitle[];
  /** True while the summary is on screen. */
  enabled: boolean;
}): SettledStanding {
  const query = useQuery({
    queryKey: ['ranked-summary', userId, medium, sitting, titles.length] as const,
    queryFn: () => readRankedCollection(userId, medium),
    enabled: enabled && titles.length > 0,
    staleTime: Infinity,
    gcTime: 0,
  });
  const retry = () => void query.refetch();
  // Nothing to settle: there is no read to wait for, so nothing to hold back.
  if (titles.length === 0) return { titles: [], state: 'settled', retry };
  if (query.data)
    return { titles: settleStanding(titles, query.data), state: 'settled', retry };
  return {
    titles: withheld(titles),
    state: query.isError ? 'failed' : 'settling',
    retry,
  };
}
