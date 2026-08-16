import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

export type CommunityScore = {
  /** Null below the sample threshold. The count is still reported. */
  score: number | null;
  ratingCount: number;
  /** How many ratings it takes before a number is shown. */
  minRatings: number;
};

/**
 * What everyone else scored this exact title.
 *
 * Beli's comparison of your rating against the room is the thing being answered here,
 * and four properties of the founder's brief are enforced server-side rather than
 * assembled from parts on the client:
 *
 *   - it derives from current rankings, not from the score snapshotted into a feed
 *     event — that one records what a moment was, which is right for an activity item
 *     and wrong for an average;
 *   - it aggregates the exact media item, so a season is never blended into its
 *     parent series, and a series has an aggregate of its own that is always empty
 *     because a series cannot be ranked (PRD §10);
 *   - it counts only public, active accounts the caller could also read one by one,
 *     so it discloses nothing the schema did not already;
 *   - it returns null rather than a misleading number when too few people have rated.
 *
 * All four live in `community_score` (20260816000000, 20260816000100). This hook
 * exists to call it, and deliberately computes nothing.
 */
export function useCommunityScore(mediaItemId: string | null) {
  return useQuery({
    queryKey: ['community-score', mediaItemId],
    enabled: Boolean(mediaItemId),
    // A community average moves when other people rank, not when this user does, so
    // it does not need the freshness the user's own score does.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<CommunityScore | null> => {
      const { data, error } = await supabase.rpc('community_score', {
        p_media_item_id: mediaItemId,
      });
      if (error) throw error;

      // A set-returning function comes back as an array of one.
      const row = (Array.isArray(data) ? data[0] : data) as
        | { score: number | string | null; rating_count: number; min_ratings: number }
        | undefined;
      if (!row) return null;

      return {
        // numeric arrives as a string over PostgREST; a bare Number() on null
        // would silently produce 0, which is a real score and a wrong one.
        score: row.score == null ? null : Number(row.score),
        ratingCount: row.rating_count ?? 0,
        minRatings: row.min_ratings ?? 0,
      };
    },
  });
}
