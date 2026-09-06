import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

import { unlockKey, type UnlockTimes } from './featured';

/** One durable row of the ledger: this account crossed this tier, once, at this time. */
export type AwardUnlock = {
  awardKey: string;
  tierKey: string;
  valueAtUnlock: number;
  earnedAt: string;
};

/**
 * The award ledger, for the account holding the phone.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS ALONGSIDE `useAwards`, WHICH DERIVES EVERYTHING
 *
 * The awards *display* is derived: twenty tracks evaluated against canonical data every
 * time the sheet opens, which is why a count can fall when somebody unranks a film and
 * why the feature needed no migration. That is the right model for "where are you now".
 *
 * It cannot answer "when did this happen", because nothing derived can. `award_unlocks`
 * (20260828000100) is the durable half: `(user_id, award_key, tier_key)` primary key,
 * so a tier is recorded at most once ever, with `earned_at` and the metric at the moment
 * of unlock. It is written only by `_maybe_award_unlocks` from triggers, never revoked,
 * and it is what already drives the feed post and the congratulations.
 *
 * So this reads the ledger for exactly the two things the derived model has no way to
 * know: which tier was crossed most recently, and when.
 * ---------------------------------------------------------------------------
 *
 * **Owner only, and the guard is in the caller as well as in the policy.**
 * `award_unlocks_own` is `user_id = auth.uid()`, so asking about somebody else returns
 * zero rows *and no error* — which is exactly the shape that gets misread as "they have
 * earned nothing". `enabled` refuses to ask the question at all rather than leaving a
 * caller to tell an empty answer from an unauthorised one.
 */
export function useAwardUnlocks(userId: string | null, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['award-unlocks', userId],
    enabled: (options.enabled ?? true) && Boolean(userId),
    // The same window `useAwards` uses. The two are read side by side on a profile and
    // a shorter one here would mean the shelf and the sheet disagreeing about a tier
    // for no reason a reader could see.
    staleTime: 60_000,
    queryFn: async (): Promise<AwardUnlock[]> => {
      const { data, error } = await supabase
        .from('award_unlocks')
        .select('award_key, tier_key, value_at_unlock, earned_at')
        .eq('user_id', userId as string)
        .order('earned_at', { ascending: false });
      if (error) throw error;

      return (data ?? []).map((row) => ({
        awardKey: row.award_key as string,
        tierKey: row.tier_key as string,
        valueAtUnlock: Number(row.value_at_unlock ?? 0),
        earnedAt: row.earned_at as string,
      }));
    },
  });
}

/** The ledger as the lookup `featuredAwards` wants: `awardKey:tierKey` → `earned_at`. */
export function unlockTimes(unlocks: AwardUnlock[] | undefined): UnlockTimes | undefined {
  if (!unlocks) return undefined;
  return new Map(unlocks.map((row) => [unlockKey(row.awardKey, row.tierKey), row.earnedAt]));
}
