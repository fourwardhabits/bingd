import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { readPref, writePref } from '@/lib/prefs';
import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';

/**
 * Whether this account should be shown the first-run taste flow, and how far it got.
 *
 * **The progress is the data, not a counter.** How many films someone has ranked is a
 * fact about `rankings`, so closing the app halfway through leaves nothing to restore:
 * reopening asks the same question and gets the same answer. A local step counter would
 * be a second copy of that fact, free to disagree with it — and it would disagree the
 * first time somebody ranked a film from the Log tab instead.
 *
 * **An account with anything in it never enters.** The test is any ranking or any logged
 * title at all, not zero rankings alone: somebody who logged four films without ranking
 * them has a collection, and dropping them into "build your taste" would be the app
 * telling an existing user it has never met them.
 */
export const FIRST_FIVE = 5;

/**
 * Which phase of the first-run flow this device believes the account is in.
 *
 * This exists because "is this account new" stops being true the moment the flow does
 * its job. The first film bucketed writes a `user_media` row, so a test of "has nothing
 * in it" answers *no* from film one onward — and independent review found exactly what
 * that costs: the router saw an account that no longer needed onboarding, sitting on the
 * onboarding route, and sent it to the feed at 1 of 5. Closing the app after the first
 * film had the same effect on reopening, which is the resume requirement failing.
 *
 * So the *entry* decision is taken once and then remembered, and only progress is read
 * live afterwards:
 *
 * | phase | meaning |
 * |---|---|
 * | absent | never decided — ask the collection, once |
 * | `active` | in the flow; stay until five are placed or they leave |
 * | `done` | finished |
 * | `skipped` | said not now |
 *
 * Device-local, like the skip it replaces, and with the same trade recorded at
 * `useCompleteTasteOnboarding`: on a second device an account halfway through is read as
 * established and is not offered the rest. That is a worse outcome than a column would
 * give and a much smaller one than a schema change to the account table at this stage.
 */
const PHASE_PREF = 'onboarding.taste.phase';

export type TastePhase = 'active' | 'done' | 'skipped';

export type TasteOnboarding = {
  /** Ranked movies, which is what the flow counts toward `FIRST_FIVE`. */
  ranked: number;
  /** True when this account belongs in the flow — see `PHASE_PREF`. */
  needed: boolean;
};

const phaseKey = (userId: string) => `${userId}.${PHASE_PREF}`;

async function readState(userId: string): Promise<TasteOnboarding> {
  const [{ count: rankedCount, error: rankedError }, { count: loggedCount, error: loggedError }] =
    await Promise.all([
      supabase
        .from('rankings')
        .select('media_item_id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('category', 'movies'),
      supabase
        .from('user_media')
        .select('media_item_id', { count: 'exact', head: true })
        .eq('user_id', userId),
    ]);

  if (rankedError) throw rankedError;
  if (loggedError) throw loggedError;

  const ranked = rankedCount ?? 0;
  const logged = loggedCount ?? 0;
  const phase = await readPref<TastePhase>(phaseKey(userId));

  if (phase === 'done' || phase === 'skipped') return { ranked, needed: false };

  // Already in it: stay until five are placed. Read live, so a film ranked in an
  // earlier session counts and a failed placement does not.
  if (phase === 'active') return { ranked, needed: ranked < FIRST_FIVE };

  // Never decided. This is the only place the collection decides, and it decides once:
  // any ranking or any logged title at all means an account that has been used, and
  // dropping that person into "build your taste" is the app telling somebody with a
  // collection that it has never met them.
  return { ranked, needed: ranked === 0 && logged === 0 };
}

/**
 * Read once and then left alone for the session.
 *
 * `staleTime: Infinity` is doing real work here rather than saving a round trip. The
 * flow's own ranking writes invalidate the collection keys, and if this query followed
 * them it would answer "no longer needed" the moment the first film was placed — which
 * would evict the user from the screen they were halfway through. The decision to be
 * *in* the flow is taken once, on arrival; `ranked` is refetched deliberately by the
 * screen to move the progress bar.
 *
 * A failure resolves to "not needed". Not knowing whether somebody is new is not a
 * reason to put them through a five-step flow, and an account that genuinely is new
 * loses nothing but a suggestion.
 */
export function useTasteOnboarding(userId: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.tasteOnboarding(userId ?? 'none'),
    enabled: Boolean(userId) && enabled,
    staleTime: Infinity,
    retry: false,
    queryFn: () => readState(userId!),
  });
}

/**
 * Ends the flow, from either exit: five films placed, or "not now".
 *
 * The skip is recorded on the device rather than in the database, which is a real
 * limitation and a deliberate one. A column would be the durable answer and would cost a
 * migration, an RLS write path and a review, for a flag whose only job is to stop one
 * screen reappearing. The consequence of getting it wrong on this side is small and
 * recoverable: a user who skipped and then reinstalls is offered the flow once more, and
 * can skip it again. The consequence on the other side — a schema change to the account
 * table this late — is not proportionate to that.
 *
 * A user who *completed* the flow needs no flag at all: they have five rankings, so the
 * ordinary "has anything in it" test already answers for them on every device.
 */
export function useCompleteTasteOnboarding(userId: string) {
  const queryClient = useQueryClient();

  return useCallback(
    async ({ skipped }: { skipped: boolean }) => {
      await writePref<TastePhase>(phaseKey(userId), skipped ? 'skipped' : 'done').catch(() => {});
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasteOnboarding(userId) });
    },
    [queryClient, userId],
  );
}

/**
 * Marks the account as in the flow, on arrival.
 *
 * Written from the screen rather than from `readState`, so the query stays a read. It is
 * what makes the rest of the flow — and a resume after the app is closed — independent
 * of the "has nothing in it" test that the first film invalidates.
 */
export function useBeginTasteOnboarding(userId: string) {
  return useCallback(async () => {
    const phase = await readPref<TastePhase>(phaseKey(userId)).catch(() => null);
    if (phase) return;
    await writePref<TastePhase>(phaseKey(userId), 'active').catch(() => {});
  }, [userId]);
}
