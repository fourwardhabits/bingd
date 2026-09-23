import type { QueryClient } from '@tanstack/react-query';

import type { RankedEntry } from '@/features/collection/use-collection';
import { queryKeys } from '@/lib/query';

import type { SessionStep } from './session';

/**
 * The opponent's card, put in the cache before the comparison renders.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHAT IT IS NOT
 *
 * `rank_answer`, `rank_skip` and `rank_back` answer with `pivot_card` (20260922000100), so
 * a comparison reached by answering draws its opponent with no second request. **`rank_start`
 * does not** — `_rank_start_impl` returns `pivot` alone on both its branches, the fresh
 * session and the resumed one — so the *first* comparison of every session, the one the
 * reader waits for immediately after choosing a bucket, still fell through to the
 * `comparison-card` query and a `media_items` read in series with the RPC it just made.
 *
 * Measured 2026-09-23: that RPC is itself the slowest of them (`rank_start` p50 19ms at 50
 * ranked, 45ms at 250, 119ms at 1,000, against 2-4ms for an answer — `ranking-latency.mjs`),
 * so the opening of a session was the one place paying both the longest server call and an
 * extra round trip.
 *
 * The fix needs no backend change, because **the client already has the row**. Every pivot
 * is a title in the subject's own band, and that band is `useRankedCollection`'s cached
 * list — which carries the same four fields the card query reads, from the same columns
 * (`use-collection.ts` maps `media_items.title`, `poster_path` and `kind` verbatim).
 *
 * It is a cache seed and nothing else. The server still chooses every pivot; a title this
 * cannot find simply leaves the query to read it, which is exactly what happens today.
 */

/** What `queryKeys.comparisonCard` caches: the four columns the comparison card draws. */
export type ComparisonCardRow = {
  id: string;
  kind: 'movie' | 'season' | null;
  title: string;
  poster_path: string | null;
};

/**
 * A ranked entry as the card query would have returned it.
 *
 * `series` collapses to null rather than being carried: the card's `kind` is the two
 * things a comparison can be, and a band holding a series row would be a different bug
 * than this function should paper over.
 */
const cardFromEntry = (entry: RankedEntry): ComparisonCardRow => ({
  id: entry.mediaItemId,
  kind: entry.kind === 'movie' || entry.kind === 'season' ? entry.kind : null,
  title: entry.title,
  poster_path: entry.posterPath,
});

/**
 * Seeds the card for whatever `step` put on screen.
 *
 * The answer's own card wins, always: it is the server's copy, read in the same
 * transaction that chose the pivot. The band is consulted only when there is none — which
 * today means `rank_start`, and tomorrow means any surface or backend that omits it.
 *
 * Both categories are searched rather than one derived from the subject, because the
 * caller that knows the subject's kind is not always the caller that has it to hand, and
 * a pivot id is unique across both lists. **Keyed on the viewer**, so a second account
 * signed in on the same device cannot be handed the first one's rows.
 */
export function seedPivotCard(
  queryClient: QueryClient,
  userId: string,
  step: SessionStep,
): void {
  if (step.state !== 'comparing') return;
  const key = queryKeys.comparisonCard(step.pivotId);

  if (step.pivotCard) {
    queryClient.setQueryData(key, step.pivotCard);
    return;
  }
  // Already read, or seeded by an earlier comparison in this session. Re-writing it would
  // reset the query's freshness for a row nobody has re-read.
  if (queryClient.getQueryData(key)) return;

  for (const category of ['movies', 'tv_seasons'] as const) {
    /**
     * Read as unknown and checked, never trusted to a cast.
     *
     * This is another module's cache entry, and a cast would only have said what this
     * file hoped was there: `RankingSheet.test.tsx` seeds these very keys with a string
     * sentinel to watch invalidations, and the cast turned that into `band.find is not a
     * function` — a crash, inside the one path that exists to save a round trip. The
     * shape is `use-collection.ts`'s and can change without this file hearing about it,
     * so a row that is not what it expects leaves the query to do what it always did.
     */
    const band = queryClient.getQueryData(queryKeys.rankings(userId, category));
    if (!Array.isArray(band)) continue;
    const entry = (band as RankedEntry[]).find(
      (row) =>
        row && typeof row === 'object' && row.mediaItemId === step.pivotId && typeof row.title === 'string',
    );
    if (entry) {
      queryClient.setQueryData(key, cardFromEntry(entry));
      return;
    }
  }
}
