import { useQuery, useQueryClient } from '@tanstack/react-query';

import { newOperationId } from '@/features/collection/writes';
import { classifyWrite } from '@/lib/write-outcome';
import { supabase } from '@/lib/supabase';

/**
 * Titles the viewer has told For You not to suggest (founder tranche 2026-08-27 §12).
 *
 * The X on a For You tile writes `recommendation_feedback` kind `dismiss` through
 * `dismiss_for_you` (20260827000700) — the first writer that dormant table ever had —
 * and this module is the whole client surface of the fact: the set read back, and the
 * write with its optimistic overlay.
 *
 * What a dismissal is NOT: it does not touch the collection, the watchlist or a
 * ranking, and it is not the dismissal of a *person's* recommendation — that is
 * `dismiss_recommendation` over in `use-recommendation-requests`, a different act on a
 * different object. It is also not training data for an engine, because there is no
 * engine; it is stored as the signal it may one day become and consumed today by
 * exactly one line in `useForYou`'s `select`.
 */

export const dismissedKey = (userId: string) => ['dismissed-titles', userId] as const;

/**
 * The dismissed set. RLS scopes the table to the caller, and the explicit filter
 * restates it so the query key and the rows it holds cannot disagree about whose
 * dismissals these are.
 */
export function useDismissedTitles(userId: string) {
  return useQuery({
    queryKey: dismissedKey(userId),
    enabled: Boolean(userId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ReadonlySet<string>> => {
      const { data, error } = await supabase
        .from('recommendation_feedback')
        .select('media_item_id')
        .eq('user_id', userId)
        .eq('kind', 'dismiss');
      if (error) throw error;
      return new Set((data ?? []).map((row) => row.media_item_id as string));
    },
  });
}

/**
 * Dismiss one title, optimistically.
 *
 * The card must disappear on the tap, not on the round trip — so the set in the cache
 * grows first and `useForYou`'s `select` re-derives the wall from data already in
 * hand: no refetch, no key change, no skeleton. The write follows; the two ways it can
 * come back decide what happens to the overlay:
 *
 *   - a **refusal** (a SQLSTATE this app raises on purpose — `lib/write-outcome.ts`)
 *     proves nothing was stored, so the optimistic entry is rolled back and the
 *     message returned for the screen to show;
 *   - an **unknown outcome** may have landed, so the overlay stays and the set is
 *     refetched — the server's answer, whatever it was, becomes the truth on screen.
 *
 * One operation id per tap, minted by the caller of the act itself: a retry of a
 * failed tap is a *new* tap here, because the server's `on conflict do nothing` makes
 * a duplicate dismissal a no-op rather than a defect.
 */
export function useDismissTitle(userId: string) {
  const queryClient = useQueryClient();

  return async (mediaItemId: string): Promise<{ ok: true } | { ok: false; message: string }> => {
    const key = dismissedKey(userId);
    const previous = queryClient.getQueryData<ReadonlySet<string>>(key);
    queryClient.setQueryData<ReadonlySet<string>>(
      key,
      new Set([...(previous ?? []), mediaItemId]),
    );

    const { error } = await supabase.rpc('dismiss_for_you', {
      p_operation_id: newOperationId(),
      p_media_item_id: mediaItemId,
    });

    if (!error) return { ok: true };

    if (classifyWrite(error) === 'unknown') {
      // May have committed. The overlay stands; the refetch decides.
      void queryClient.invalidateQueries({ queryKey: key });
      return { ok: true };
    }

    queryClient.setQueryData(key, previous ?? new Set<string>());
    return { ok: false, message: error.message };
  };
}
