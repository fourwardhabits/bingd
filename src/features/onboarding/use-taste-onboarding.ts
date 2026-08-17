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

/** Set when somebody chooses to get on with it. Device-local, deliberately — see below. */
const SKIPPED_PREF = 'onboarding.taste.skipped';

export type TasteOnboarding = {
  /** Ranked movies, which is what the flow counts toward `FIRST_FIVE`. */
  ranked: number;
  /** True when this account has never ranked or logged anything, and has not skipped. */
  needed: boolean;
};

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
  const skipped = (await readPref<boolean>(`${userId}.${SKIPPED_PREF}`)) === true;

  return { ranked, needed: !skipped && ranked === 0 && logged === 0 };
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
      if (skipped) {
        await writePref(`${userId}.${SKIPPED_PREF}`, true).catch(() => {});
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasteOnboarding(userId) });
    },
    [queryClient, userId],
  );
}
