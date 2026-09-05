import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

export type FollowingScore = {
  /** Null when nobody the viewer follows has ranked this title. */
  score: number | null;
  ratingCount: number;
  /**
   * How many accounts the viewer follows at all, which is what tells two silences
   * apart: a reader who follows nobody gets no row, and a reader who follows eleven
   * people none of whom have seen the film is told exactly that.
   */
  followingCount: number;
};

/**
 * What the people this viewer follows made of this exact title.
 *
 * The counterpart to `useCommunityScore`, and the more useful of the two for most
 * readers: the population is one they assembled deliberately rather than everybody.
 *
 * **Following, not friends.** `follows` is directional — a row means the follower asked
 * and, for a private account, was approved. Calling that a friendship would assert a
 * mutuality the schema does not record.
 *
 * Everything that matters is enforced in `following_score` (20260816001100) rather than
 * assembled here:
 *
 *   - approved followees only, from the caller's side of the relationship;
 *   - `can_view_profile` from the caller's own perspective, so a block in either
 *     direction, a suspension, or a revoked approval drops out — none of which delete
 *     the follow row;
 *   - the exact media item, so a season is never folded into its series;
 *   - live rankings rather than the score snapshotted into a feed event, which goes
 *     stale the moment the rater ranks anything else in the same band.
 *
 * **A sample of one is shown**, which Community has also done since 2026-09-05 and did
 * not before — see `20260910000100` for why the two thresholds converged. One account you
 * chose to follow is not a weak estimate of a population; it is that person's opinion,
 * and it is also the only case a new account can produce at all. The migration's header
 * sets out why that is safe as well as useful.
 *
 * This hook calls the function and computes nothing. Averaging on the device would mean
 * downloading other people's collections to put one number on one title.
 */
export function useFollowingScore(mediaItemId: string | null, userId: string) {
  return useQuery({
    // Keyed by the account as well as the title. The answer is viewer-relative — two
    // people see different numbers for the same film — so an entry keyed on the title
    // alone would serve one account's followees' average to another on a shared device.
    queryKey: ['following-score', userId, mediaItemId],
    enabled: Boolean(mediaItemId),
    // Moves when a followee ranks something, which is not something this device does.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<FollowingScore | null> => {
      const { data, error } = await supabase.rpc('following_score', {
        p_media_item_id: mediaItemId,
      });
      if (error) throw error;

      // A set-returning function comes back as an array of one.
      const row = (Array.isArray(data) ? data[0] : data) as
        | { score: number | string | null; rating_count: number; following_count: number }
        | undefined;
      if (!row) return null;

      return {
        // numeric arrives as a string over PostgREST, and a bare Number() on null
        // would silently produce 0 — which is a real score and a wrong one.
        score: row.score == null ? null : Number(row.score),
        ratingCount: row.rating_count ?? 0,
        followingCount: row.following_count ?? 0,
      };
    },
  });
}
