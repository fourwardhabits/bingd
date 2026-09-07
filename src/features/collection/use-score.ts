import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query';
import { after, readAllByKey } from '@/lib/read-all';
import { supabase } from '@/lib/supabase';

import { bandSizes, emptyBandSizes, scoreFor, type BandSizes, type Bucket } from './score';
import type { RankingCategory } from './use-collection';

/**
 * Band sizes for one user and one ranking category.
 *
 * A score needs the size of the band it sits in, which is a property of the
 * whole category rather than of the row being displayed — so a screen showing a
 * single title still has to know how many titles are in that title's band. This
 * is the cheapest form of that question: bucket alone, no joins, no metadata.
 *
 * Scoped to the signed-in user by design. `rankings` is not readable across
 * users, which is exactly why a friend's score has to be snapshotted into the
 * feed event instead of derived (ranking.md §11).
 *
 * **`total` is a denominator and `sizes` is a divisor, so this read may not be capped.**
 * PostgREST silently truncates an unbounded select at 1,000 rows, and this was the worst
 * place in the app for it to land: 1,001 ranked films gave a band one member short, so
 * `scoreFor` divided by the wrong number and every score in that band was wrong — and the
 * title at position 1,001 rendered "#1,001 of 1,000", which at least had the decency to
 * look impossible. Independent review 21b; the paging is `lib/read-all.ts`.
 *
 * `media_item_id` is selected only because a keyset cursor needs a unique column to page
 * on. The read is otherwise still the cheapest form of this question — two columns, no
 * joins, no metadata — which is why the ranking total does not come from
 * `useRankedCollection` and its posters.
 */
export function useBandSizes(userId: string, category: RankingCategory, enabled = true) {
  return useQuery({
    queryKey: [...queryKeys.rankings(userId, category), 'bands'],
    enabled: enabled && Boolean(userId),
    queryFn: async (): Promise<{ sizes: BandSizes; total: number }> => {
      const { data, error } = await readAllByKey<{ media_item_id: string; bucket: Bucket }>(
        (cursor, limit) =>
          after(
            supabase
              .from('rankings')
              .select('media_item_id, bucket')
              .eq('user_id', userId)
              .eq('category', category),
            'media_item_id',
            cursor,
          )
            .order('media_item_id', { ascending: true })
            .limit(limit),
        (row) => [row.media_item_id],
      );
      if (error) throw error;

      const rows = data ?? [];
      return { sizes: bandSizes(rows), total: rows.length };
    },
  });
}

/**
 * The score for one ranked title, and the ordinal detail that sits beneath it.
 *
 * Returns nulls rather than a placeholder score while the band sizes are still
 * loading. A score that appears and then changes is worse than one that arrives
 * a moment late, because the first reading is the one the user believes.
 */
export function useTitleScore(
  userId: string,
  category: RankingCategory,
  ranked: { position: number; bucket: Bucket } | null | undefined,
) {
  const bands = useBandSizes(userId, category, Boolean(ranked));

  if (!ranked || !bands.data) {
    return { score: null, total: null, isPending: Boolean(ranked) && bands.isPending };
  }

  return {
    score: scoreFor(ranked.bucket, ranked.position, bands.data.sizes ?? emptyBandSizes()),
    total: bands.data.total,
    isPending: false,
  };
}

/** One ranked title of the reader's own, reduced to what a list row needs. */
export type MyScore = {
  score: number;
  category: RankingCategory;
  bucket: Bucket;
  position: number;
};

/**
 * Every score this reader has given, as a lookup by media id.
 *
 * ---------------------------------------------------------------------------
 * WHY A LIST NEEDS ITS OWN READ AND CANNOT LOOP `useTitleScore`
 *
 * A score is not stored. It is `scoreFor(bucket, position, bandSizes)` — a position
 * within a band, divided by the size of that band — so a row showing one title still
 * depends on how many titles are in the whole category. `useTitleScore` answers that for
 * a single title by fetching the band sizes; twenty search results would be twenty
 * copies of the same question, and a hook cannot be called in a loop anyway.
 *
 * So this reads the whole of `rankings` once — four columns, no joins, no metadata — and
 * derives both halves from the same rows: the band sizes per category, then a score per
 * title. One read, one source, and the count a band is divided by is the count the rows
 * actually have.
 *
 * **Deliberately not `useRankedCollection`.** That one carries posters, genres, runtimes
 * and a parent embed per row, because it draws a collection. A search row needs a number.
 *
 * **Paged through `readAllByKey`, and that is load-bearing rather than tidy.** An
 * unbounded PostgREST select silently truncates at 1,000 rows, which here would not error
 * — it would hand a band one member short and quietly make every score in it wrong.
 * `use-read-all.ts` has the whole argument; `useBandSizes` above pays the same cost for
 * the same reason.
 */
export function useMyScores(userId: string, enabled = true) {
  return useQuery({
    queryKey: ['my-scores', userId],
    enabled: enabled && Boolean(userId),
    queryFn: async (): Promise<Map<string, MyScore>> => {
      const { data, error } = await readAllByKey<{
        media_item_id: string;
        bucket: Bucket;
        position: number;
        category: RankingCategory;
      }>(
        (cursor, limit) =>
          after(
            supabase
              .from('rankings')
              .select('media_item_id, bucket, position, category')
              .eq('user_id', userId),
            'media_item_id',
            cursor,
          )
            .order('media_item_id', { ascending: true })
            .limit(limit),
        (row) => [row.media_item_id],
      );
      if (error) throw error;

      const rows = data ?? [];
      // Per category, because a band is a band *within* Movies or within TV seasons —
      // one pooled set of sizes would score a film against the television it shares a
      // bucket name with.
      const sizes = new Map<RankingCategory, BandSizes>();
      for (const category of ['movies', 'tv_seasons'] as const) {
        sizes.set(category, bandSizes(rows.filter((row) => row.category === category)));
      }

      return new Map(
        rows.map((row) => [
          row.media_item_id,
          {
            score: scoreFor(
              row.bucket,
              row.position,
              sizes.get(row.category) ?? emptyBandSizes(),
            ),
            category: row.category,
            bucket: row.bucket,
            position: row.position,
          },
        ]),
      );
    },
  });
}
