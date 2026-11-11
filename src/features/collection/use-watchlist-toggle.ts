import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';

import { invalidateAfterWatchlistChange } from './invalidate';
import { useWatchlist } from './use-collection';
import { mustReconcile, newOperationId, setWatchlist } from './writes';
import { track, type Surface } from '@/lib/analytics';

/**
 * One-tap Watchlist for a list of compact rows: which ids are saved, which one has a write
 * in flight, and the toggle.
 *
 * The same contract the Search screen's row toggle keeps (`app/(tabs)/log.tsx`), lifted so
 * the series page's season rows (TV show & season ranking, 2026-11-14) can share it rather
 * than copy it: one write at a time, guarded by a ref because two taps inside one tick read
 * the same render's state; `watchlist_added` on additions that answered `ok` only; and a
 * reconcile when the outcome is unknown, because `set_watchlist` can commit and lose its
 * reply.
 */
export function useWatchlistToggle(userId: string, surface: Surface) {
  const queryClient = useQueryClient();
  const watchlist = useWatchlist(userId);
  const saved = useMemo(
    () => new Set((watchlist.data ?? []).map((entry) => entry.mediaItemId)),
    [watchlist.data],
  );
  const inFlight = useRef<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (mediaItemId: string) => {
    if (inFlight.current) return;
    inFlight.current = mediaItemId;
    setBusy(mediaItemId);

    const present = !saved.has(mediaItemId);
    const outcome = await setWatchlist({ operationId: newOperationId(), mediaItemId, present });
    inFlight.current = null;
    setBusy(null);

    if (present && outcome.outcome === 'ok') {
      track({ name: 'watchlist_added', props: { surface } });
    }
    if (mustReconcile(outcome)) {
      invalidateAfterWatchlistChange(queryClient, userId);
    }
    return outcome;
  };

  /** Null while the watchlist has not been read, which hides a row's bookmark. */
  const isSaved = (mediaItemId: string): boolean | null =>
    watchlist.isSuccess ? saved.has(mediaItemId) : null;

  return { isSaved, busy, toggle };
}
