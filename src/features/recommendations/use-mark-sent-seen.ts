import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useNavigation } from 'expo-router';
import { useEffect, useRef, useState } from 'react';

import { newOperationId } from '@/features/collection/writes';
import { supabase } from '@/lib/supabase';

import { isUnread, type SentRecommendation } from './use-sent-to-you';

/**
 * **Seeing Sent to you clears what is new on it** (FU1113-E, 20261121000100).
 *
 * Unread used to mean "not opened", and only opening a title opens it — so a list the reader
 * had plainly looked at kept its dot for ever. Now, when the list is **actually on screen**,
 * the unread rows on it are marked seen on the server, and the dot and tint go.
 *
 * WHAT COUNTS AS ON SCREEN
 *
 *   - `shown`, the caller's: Sent to you is the selected view and its query has loaded
 *     successfully (never while loading, never on a failed load, never on For You or Top
 *     Rated). The caller passes the rows it is drawing, so a row a filter hides is not
 *     marked — it has not been seen.
 *   - this screen is the focused route (the tab is selected and nothing is pushed over it).
 *
 * WHAT IS SENT
 *
 * Only the ids of unread rows in hand — never "everything delivered to me" — so a
 * recommendation that arrives after the list loaded stays unread until it is on screen.
 * One call in flight per account; a fresh operation id per attempt.
 *
 * OPTIMISTIC, AND HONEST ABOUT FAILURE
 *
 * The rows' `seenAt` is set in that account's own cache (`['sent-to-you', viewerId]`) before
 * the call, so the dot goes at once. If the call fails, exactly those rows are put back to
 * unread, and no retry happens until the screen is next focused — a server that is down
 * must not become a loop.
 *
 * WHAT IT NEVER DOES
 *
 * Open (that is still `useMarkRecommendationOpened`, and still the only emitter of
 * `recommendation_opened`), dismiss, add, rank, touch the watchlist, or remove a row from the
 * list. A read row stays exactly where the server orders it.
 */
export function useMarkSentSeen(
  viewerId: string,
  rows: readonly SentRecommendation[],
  shown: boolean,
): void {
  const queryClient = useQueryClient();
  const focused = useScreenFocused();
  const active = shown && focused;

  /** A failure during this visit. Cleared when the visit ends, so the next focus retries. */
  const failed = useRef(false);
  /**
   * Which visit this is, bumped as each one ends (Codex review, #290). A call outlives the
   * visit that sent it: leave while it is pending and it can fail after the reset above,
   * which used to set `failed` for the *next* visit and block its retry. A failure now
   * counts only for the visit that sent the call.
   */
  const visit = useRef(0);
  /** Bumped when a call settles, so anything that arrived meanwhile is considered. */
  const [settled, setSettled] = useState(0);

  useEffect(() => {
    if (!active) {
      failed.current = false;
      visit.current += 1;
    }
  }, [active]);

  const unreadIds = active ? rows.filter(isUnread).map((row) => row.id) : [];
  const pending = unreadIds.join(',');

  useEffect(() => {
    if (!active || pending === '' || failed.current || inFlight.has(viewerId)) return;
    const ids = pending.split(',');
    const sentIn = visit.current;

    inFlight.add(viewerId);
    void markSentSeen(queryClient, viewerId, ids)
      .then((ok) => {
        if (!ok && visit.current === sentIn) failed.current = true;
      })
      .finally(() => {
        inFlight.delete(viewerId);
        setSettled((n) => n + 1);
      });
    // `settled` is a dependency only to re-run this once a call has finished.
  }, [active, pending, viewerId, queryClient, settled]);
}

/** One mark in flight per account, across every mounted caller. */
const inFlight = new Set<string>();

/** For tests: forget calls a previous test left in flight. */
export function resetMarkSentSeen() {
  inFlight.clear();
}

/**
 * Marks `ids` seen for `viewerId`: optimistically in that account's cache, then on the
 * server. Resolves false (after rolling the rows back to unread) when the server refused or
 * could not be reached.
 */
export async function markSentSeen(
  queryClient: QueryClient,
  viewerId: string,
  ids: readonly string[],
): Promise<boolean> {
  const key = ['sent-to-you', viewerId];
  const marked = new Set(ids);
  const stamp = new Date().toISOString();

  queryClient.setQueryData<SentRecommendation[]>(key, (rows) =>
    rows?.map((row) => (marked.has(row.id) && isUnread(row) ? { ...row, seenAt: stamp } : row)),
  );

  let ok = false;
  try {
    const { error } = await supabase.rpc('mark_recommendations_seen', {
      p_operation_id: newOperationId(),
      p_ids: [...ids],
    });
    ok = !error;
  } catch {
    ok = false;
  }

  if (!ok) {
    // Only the rows this attempt stamped: a refetch that landed meanwhile is the server's
    // word and is left alone.
    queryClient.setQueryData<SentRecommendation[]>(key, (rows) =>
      rows?.map((row) => (marked.has(row.id) && row.seenAt === stamp ? { ...row, seenAt: null } : row)),
    );
  }
  return ok;
}

/**
 * Whether this screen is the focused route, from the navigator the screen already uses.
 *
 * `useIsFocused` would do, but it is `useNavigation` that every test of this screen stands
 * in for (`useTabReset` reads it), so this asks the same object. A navigator that cannot
 * report focus — a unit test's stand-in — reads as focused, as `useTabReset` assumes.
 */
function useScreenFocused(): boolean {
  const navigation = useNavigation();
  const [focused, setFocused] = useState(() => navigation.isFocused?.() ?? true);

  useEffect(() => {
    // The initial value is read in `useState` above; from here on the navigator says.
    const offFocus = navigation.addListener?.('focus' as never, (() => setFocused(true)) as never);
    const offBlur = navigation.addListener?.('blur' as never, (() => setFocused(false)) as never);
    return () => {
      offFocus?.();
      offBlur?.();
    };
  }, [navigation]);

  return focused;
}
