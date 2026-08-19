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
