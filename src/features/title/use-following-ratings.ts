import { useQuery } from '@tanstack/react-query';

import { avatarUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

/**
 * The people behind the Following score (founder tranche 2026-08-27 §13).
 *
 * One call to `following_ratings` (20260827000800), which returns the rows the
 * aggregate averages under the aggregate's own predicate — so this list and the
 * number it explains cannot disagree — with `taste_match`'s verdict per row. A null
 * `matchScore` is the below-threshold answer, and the sheet's word for it is
 * "Match TBD": the same no-invented-number rule the profile's match label follows,
 * said in the two words that fit a row.
 */

export type FollowingRating = {
  userId: string;
  username: string;
  name: string;
  avatarUri: string | null;
  /** Their live derived 0–10 score for this title. */
  score: number;
  /** taste_match's verdict, or null below `taste.min_common` shared titles. */
  matchScore: number | null;
  /** How many exact titles they share with the viewer — the evidence behind it. */
  commonCount: number;
};

type Row = {
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_path: string | null;
  score: string | number;
  match_score: number | null;
  common_count: number | null;
};

export function useFollowingRatings(mediaItemId: string | null, viewerId: string) {
  return useQuery({
    // Viewer-keyed like every visibility-dependent read: who you follow and who
    // taste_match will answer about are both facts about the viewer.
    queryKey: ['following-ratings', viewerId, mediaItemId],
    enabled: Boolean(mediaItemId) && Boolean(viewerId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<FollowingRating[]> => {
      const { data, error } = await supabase.rpc('following_ratings', {
        p_media_item_id: mediaItemId,
      });
      if (error) throw error;

      return ((data ?? []) as Row[]).map((row) => ({
        userId: row.user_id,
        username: row.username,
        name: row.display_name?.trim() || row.username,
        avatarUri: avatarUri(row.avatar_path),
        // `numeric` crosses PostgREST as a string; null cannot happen — a member
        // without a ranking for this title is not a member.
        score: Number(row.score),
        matchScore: row.match_score,
        commonCount: row.common_count ?? 0,
      }));
    },
  });
}
