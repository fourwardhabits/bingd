import { useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';
import { classifyWrite } from '@/lib/write-outcome';

/**
 * Watch next: at most three of the reader's own Watchlist titles, drawn above the rest
 * (20260929000200).
 *
 * Private to the owner and silent — no Feed event, no notification. The server holds the
 * cap structurally and removes a pin whenever its Watchlist row goes, whatever removed it
 * (unsaving, logging, ranking, finishing a series, deleting the account), so nothing here
 * has to.
 */

/**
 * Under the collection's key, so every invalidation a log, a rank or a Watchlist change
 * already performs refreshes the pins too — a title that left the Watchlist is a title
 * that left Watch next, and nothing has to remember to say so.
 */
export const watchNextKey = (userId: string) =>
  [...queryKeys.collection(userId), 'watch-next'] as const;

/**
 * The pinned media item ids, in slot order.
 *
 * Its own small read rather than an embed in `useWatchlist`, so a failure here — including
 * a backend one migration behind, which has no such table — leaves the Watchlist exactly
 * as it was, with no header. It is never a failure of the list.
 */
export function useWatchNext(userId: string) {
  return useQuery({
    queryKey: watchNextKey(userId),
    retry: false,
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from('watch_next')
        .select('media_item_id, slot')
        .eq('user_id', userId)
        .order('slot', { ascending: true });
      if (error) throw error;
      return ((data ?? []) as { media_item_id: string }[]).map((row) => row.media_item_id);
    },
  });
}

export type WatchNextResult =
  /** `pinned` is the server's list in slot order; null for a replayed id, which carries none. */
  | { outcome: 'ok'; pinned: string[] | null; replaced: boolean }
  /** Three are pinned and nothing was named to replace. Carries the server's pins. */
  | { outcome: 'full'; pinned: string[] }
  /** The title is not (or is no longer) on the Watchlist. */
  | { outcome: 'not_on_watchlist' }
  /** `changed`: the outcome is unknown, so the id is held and the pins are refetched. */
  | { outcome: 'failed'; message: string; changed?: boolean };

/**
 * Pin, unpin, or swap one pin for another in a single call.
 *
 * The operation id is the caller's, held across a retry of the same intent: a lost reply
 * retried under a fresh id is harmless here (the writer is idempotent by state), but it
 * would spend a second rate-limit slot for one tap.
 */
export async function setWatchNext(input: {
  operationId: string;
  mediaItemId: string;
  present: boolean;
  replacing?: string | null;
}): Promise<WatchNextResult> {
  const { data, error } = await supabase.rpc('set_watch_next', {
    p_operation_id: input.operationId,
    p_media_item_id: input.mediaItemId,
    p_present: input.present,
    p_replace_media_item_id: input.replacing ?? null,
  });

  if (error) {
    switch (error.code) {
      case '42501':
        return { outcome: 'failed', message: 'Your account cannot make changes right now.' };
      case '53400':
        return {
          outcome: 'failed',
          message: 'You have changed Watch next a lot today. Try again later.',
        };
      default:
        return {
          outcome: 'failed',
          message: 'Could not update Watch next. Try again.',
          ...(classifyWrite(error) === 'unknown' ? { changed: true as const } : {}),
        };
    }
  }

  const body = (data ?? {}) as {
    status?: string;
    reason?: string;
    pinned?: string[];
    replaced?: boolean;
  };
  if (body.status === 'refused') {
    return body.reason === 'full'
      ? { outcome: 'full', pinned: body.pinned ?? [] }
      : { outcome: 'not_on_watchlist' };
  }
  if (body.status === 'already_applied') {
    return { outcome: 'ok', pinned: null, replaced: false };
  }
  return { outcome: 'ok', pinned: body.pinned ?? [], replaced: Boolean(body.replaced) };
}

/**
 * The cache half of a write. Every `ok` and `full` reply carries the server's own pin
 * list, so the common case costs no second request; anything that does not — a replay,
 * a refusal that says the Watchlist moved, an unknown outcome — refetches.
 */
export function useReconcileWatchNext(userId: string) {
  const queryClient = useQueryClient();
  return (result: WatchNextResult) => {
    if ((result.outcome === 'ok' || result.outcome === 'full') && result.pinned) {
      queryClient.setQueryData(watchNextKey(userId), result.pinned);
      return;
    }
    if (result.outcome === 'failed' && !result.changed) return;
    void queryClient.invalidateQueries({ queryKey: watchNextKey(userId) });
  };
}
