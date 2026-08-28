import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

import { EXPOSURE_TIERS } from './session-seed';

/**
 * What previous sessions have already put in front of this reader.
 *
 * ---------------------------------------------------------------------------
 * THE HALF `session-seed.ts` COULD NOT DO
 *
 * That module's own header names the limit: exposure is module state, so it "resets with
 * the process". Close the app and every title is unseen again — which means the *first*
 * slate after every launch is drawn from an un-penalised pool and is therefore the same
 * first slate, every time. That is exactly the founder's report ("opening For You
 * repeatedly produces substantially the same slate") surviving the fix that was supposed
 * to answer it, and this hook is the durable half.
 *
 * `recommendation_exposure()` (20260828000500) returns the caller's own impressions
 * inside `foryou.impression_window_hours`, aggregated. Rows outside the window are
 * excluded rather than deleted, which is what lets a strong candidate come back by itself
 * instead of being suppressed for ever.
 *
 * ---------------------------------------------------------------------------
 * `staleTime: Infinity`, AND IT IS LOAD-BEARING RATHER THAN THRIFTY
 *
 * This is read **once per app process** and never re-read. Not to save a request — to
 * close a loop that would otherwise be structural:
 *
 *   the wall renders → its ids are recorded as impressions → the exposure moves →
 *   `select` re-derives → a *different* wall renders → its ids are recorded → …
 *
 * `session-seed.ts` solved the same shape by making its writer silent. The equivalent
 * here is to make the reader still: the penalty a session applies is decided from what
 * was true when the app opened, and everything that happens during the session is handled
 * by the session layer, which already knows how to be quiet about it. The next launch
 * picks up everything this one recorded, which is precisely the cross-session behaviour
 * the founder asked for and no more.
 *
 * A failure is not an error the screen shows. Rotation is a preference over ordering, and
 * a wall that is merely less rotated is far better than no wall — so this fails to an
 * empty map and the session layer carries the visit on its own.
 */
export function useRecommendationExposure(userId: string) {
  return useQuery({
    queryKey: ['recommendation-exposure', userId],
    enabled: Boolean(userId),
    staleTime: Infinity,
    // One retry rather than the default three: this is an enhancement, and the slate
    // waits on nothing, so a long back-off spent on it is a long back-off spent on the
    // rotation being slightly better.
    retry: 1,
    queryFn: async (): Promise<ReadonlyMap<string, number>> => {
      const { data, error } = await supabase.rpc('recommendation_exposure');
      if (error) throw error;

      const counts = new Map<string, number>();
      for (const row of (data ?? []) as { media_item_id: string; shown_count: number }[]) {
        // Capped at the same tiers the session uses, so a title shown thirty times last
        // week is not permanently pinned below one shown four. Past the cap everything is
        // equally stale and score decides again, which is the rule `EXPOSURE_TIERS`
        // exists to state — it must mean one thing across both halves of the penalty.
        counts.set(row.media_item_id, Math.min(EXPOSURE_TIERS, row.shown_count));
      }
      return counts;
    },
  });
}

/**
 * The two halves of the penalty, as one map.
 *
 * `Math.max` rather than a sum, and the difference is the whole reason this is a named
 * function with a comment rather than a spread. Tiers are a *staleness band*, not a
 * quantity of boredom: a title shown twice last week and twice today is stale, not
 * four-times-stale, and adding them would push ordinary candidates past the cap where
 * nothing distinguishes them any more. Taking the larger keeps the band meaningful and
 * keeps the two sources from having to be tuned against each other.
 */
export function mergeExposure(
  durable: ReadonlyMap<string, number> | undefined,
  session: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  if (!durable || durable.size === 0) return session;
  if (session.size === 0) return durable;

  const merged = new Map(durable);
  for (const [id, tier] of session) {
    merged.set(id, Math.max(merged.get(id) ?? 0, tier));
  }
  return merged;
}
