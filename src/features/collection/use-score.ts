import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query';
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
 */
export function useBandSizes(userId: string, category: RankingCategory, enabled = true) {
  return useQuery({
    queryKey: [...queryKeys.rankings(userId, category), 'bands'],
    enabled: enabled && Boolean(userId),
    queryFn: async (): Promise<{ sizes: BandSizes; total: number }> => {
      const { data, error } = await supabase
        .from('rankings')
        .select('bucket')
        .eq('user_id', userId)
        .eq('category', category);
      if (error) throw error;

      const rows = (data ?? []) as { bucket: Bucket }[];
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
