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

/**
 * **Whether one read is one ranking** (independent review, QA corrections). The category is
 * read in pages of up to a thousand rows, each its own request, so a placement on another
 * device between two pages can assemble a list in which two titles share a position — the
 * very defect this module exists to remove, recreated from mixed snapshots. A ranking the
 * database can hold has positions 1…n exactly once each, and its bands in order: every
 * I liked it above every It was fine above every I didn't like it.
 */
export function isOneRanking(rows: readonly Pick<RankedEntry, 'bucket' | 'position'>[]) {
  const ORDER = { loved: 0, fine: 1, not_for_me: 2 } as const;
  const byPosition = [...rows].sort((a, b) => a.position - b.position);
  return byPosition.every(
    (row, i) =>
      row.position === i + 1 &&
      ORDER[row.bucket] !== undefined &&
      (i === 0 || ORDER[byPosition[i - 1]!.bucket] <= ORDER[row.bucket]),
  );
}

/** How many times a torn read is asked again before the summary gives up on its numbers. */
const CONSISTENT_ATTEMPTS = 3;

/** Reads until one read is one ranking; throws, so the summary withholds, if none is. */
export async function readOneRanking(
  read: () => Promise<RankedEntry[]>,
  attempts = CONSISTENT_ATTEMPTS,
): Promise<RankedEntry[]> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const rows = await read();
    if (isOneRanking(rows)) return rows;
  }
  throw new Error('The ranking changed while it was being read');
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
 *
 * **`sitting` must change whenever the count can repeat.** The backlog's count only ever
 * grows, so its sitting id is enough. Refine's count starts again at every round, so
 * Refine passes an id with the round in it: otherwise a second round finishing on the
 * same count could be handed a first-round read that is still in flight (independent
 * review, QA corrections).
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
    queryFn: () => readOneRanking(() => readRankedCollection(userId, medium)),
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
