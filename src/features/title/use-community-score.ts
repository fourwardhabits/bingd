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
 *   - it returns null rather than a misleading number when too few people have rated —
 *     which since 2026-09-05 means nobody at all. The threshold is a config value
 *     (`score.community_min_ratings`, now 1) and this hook has never known it: the
 *     server withholds, and the client draws what it is given.
 *
 * All four live in `community_score` (20260816000000, 20260816000100). This hook
 * exists to call it, and deliberately computes nothing.
 */
export function useCommunityScore(mediaItemId: string | null, userId: string) {
  return useQuery({
    /**
     * Keyed by the account, because this number is viewer-relative too.
     *
     * It looks like a fact about the title and is not: `community_score` excludes
     * accounts blocked in either direction (20260816000100), so two people genuinely
     * see different means for the same film. A key on the title alone would let one
     * account on a shared device read the other's aggregate for five minutes.
     *
     * `queryClient.clear()` on sign-out has been covering this in the ordinary flow,
     * which is the same "a lifecycle is doing a key's job" shape review 6 found in
     * `logState` — and the same fix. Independent review found this one at 10, from the
     * inconsistency with `useFollowingScore` beside it.
     */
    queryKey: ['community-score', userId, mediaItemId],
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
