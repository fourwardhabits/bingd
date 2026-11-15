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
 * and the properties of the founder's brief are enforced server-side rather than
 * assembled from parts on the client:
 *
 *   - it derives from current rankings, not from the score snapshotted into a feed
 *     event — that one records what a moment was, which is right for an activity item
 *     and wrong for an average;
 *   - a season's aggregate is that season's rankings alone, never blended into its
 *     parent series; a whole show's aggregate is one effective score per person (their
 *     show ranking, else the mean of their ranked seasons) since 20261119000100;
 *   - it counts a person only once they have ten rankings in the title's category
 *     (movies, or TV = seasons + shows; `score.contributor_min_rankings`), so the count
 *     is eligible contributors, not everyone who ranked it (20261119000100);
 *   - it counts only public, active accounts the caller could also read one by one,
 *     so it discloses nothing the schema did not already;
 *   - it returns null rather than a misleading number when too few people have rated —
 *     which since 2026-09-05 means nobody at all. The threshold is a config value
 *     (`score.community_min_ratings`, now 1) and this hook has never known it: the
 *     server withholds, and the client draws what it is given.
 *
 * All of them live in `community_score` (20260816000000, 20260816000100,
 * 20261119000100). The reader's own score never comes from here: it is
 * `scoreFor` over their own bands, and shows from their first ranking. This hook
 * exists to call it, and deliberately computes nothing.
 */
/** How long a community score is served without asking again (20261119000100). */
export const COMMUNITY_SCORE_STALE_MS = 60_000;

/**
 * The cache key, account first. `invalidateAfterCollectionChange` invalidates the
 * `['community-score', userId]` prefix, so the shape is part of that contract.
 */
export const communityScoreKey = (userId: string, mediaItemId: string | null) =>
  ['community-score', userId, mediaItemId] as const;

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
    queryKey: communityScoreKey(userId, mediaItemId),
    enabled: Boolean(mediaItemId),
    /**
     * **A minute, and refetched when the app comes back to the foreground**
     * (20261119000100, founder spec t168u §4G and §4K-14).
     *
     * It used to be five minutes on the reasoning that this average moves when other
     * people rank, not when this reader does. Contributor eligibility broke that: a
     * reader's rankings count only from their tenth in the category, so the ranking that
     * crosses nine to ten (or the removal that crosses back) moves this number on every
     * title they ranked in it. On this device `invalidateAfterCollectionChange` handles
     * that by prefix. On the reader's *other* device nothing can tell the cache, and the
     * global `refetchOnWindowFocus` is off, so this query opts in alone: returning to the
     * app refetches it once it is a minute old, through the AppState focus manager wired
     * in `app/_layout.tsx`. The server stores nothing to refresh, so the refetch is the
     * whole fix.
     */
    staleTime: COMMUNITY_SCORE_STALE_MS,
    refetchOnWindowFocus: true,
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
