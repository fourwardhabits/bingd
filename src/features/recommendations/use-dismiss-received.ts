import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { NOTICE_MS } from '@/features/collection/use-rerank';
import type { RerankNotice } from '@/features/collection/rerank';
import { newOperationId } from '@/features/collection/writes';
import { supabase } from '@/lib/supabase';
import { compactName } from '@/lib/titles';
import { classifyWrite, mustReconcile, type ServerError } from '@/lib/write-outcome';

import type { SentRecommendation } from './use-sent-to-you';

/**
 * **Remove from Sent to You, and Undo** (founder request, 2026-11-22; 20261130001200).
 *
 * The recipient's own, reversible decision about their own list: one delivered
 * recommendation, from one sender, leaves Sent to You and the title page's "Recommended by"
 * card. It is stored on the server (`dismissed_at`), so it holds after a restart and on
 * every other device, including builds that predate this one.
 *
 * WHAT IT IS NOT
 *
 *   - Not `dismiss_recommendation`, which throws away a *pending request*
 *     (`use-recommendation-requests`), and not For You's "not interested"
 *     (`use-dismissed`), which is a signal about the algorithmic slate.
 *   - Not seen or opened. Neither is written here, and neither ever removes anything.
 *   - Not the watchlist. A saved title stays saved; saving never removes a recommendation.
 *   - Not anything the sender sees: no notification, and their row is unchanged.
 *
 * OPTIMISTIC, UNLIKE THE REQUEST ACTIONS
 *
 * `useRequestActions` is deliberately not optimistic, because Add and Dismiss there are
 * decisions about somebody else's suggestion. This one is a tidy-up of the reader's own
 * list with an Undo beside it, so the row goes at once and the confirmation is the
 * undo affordance. A refusal puts the row back where it was and says so; an outcome nobody
 * established (a dropped reply, `08007`) refetches, so the list ends up showing what the
 * server holds.
 *
 * ONE OPERATION ID PER ACT
 *
 * Each dismissal and each Undo gets a fresh id. The server's ledger is what makes the order
 * safe: a dismissal whose reply was lost and is replayed after the Undo answers
 * `already_applied` rather than removing the row again.
 *
 * UNDO WAITS FOR THE DISMISSAL
 *
 * Two requests in flight can arrive in either order. An Undo pressed before the dismissal
 * has answered waits for it, so the restore never reaches the server first and finds
 * nothing to restore while the dismissal lands behind it.
 */

type Outcome = 'committed' | 'refused' | 'unknown';

export const sentKey = (viewerId: string) => ['sent-to-you', viewerId] as const;

const quoted = (title: string) => `“${title}”`;

/** The confirmation and failure lines, in the shape `RerankNoticeBar` draws. */
export const removalNotices = {
  removed: (title: string): RerankNotice => ({
    message: `Removed ${quoted(title)} from Sent to You`,
    action: { kind: 'undo', label: 'Undo' },
    tone: 'info',
  }),
  failed: (title: string, suspended: boolean): RerankNotice => ({
    message: suspended
      ? 'Your account cannot make changes right now.'
      : `Couldn’t remove ${quoted(title)}. Try again.`,
    tone: 'error',
  }),
  undoFailed: (title: string, suspended: boolean): RerankNotice => ({
    message: suspended
      ? 'Your account cannot make changes right now.'
      : `Couldn’t put ${quoted(title)} back. Try again.`,
    tone: 'error',
  }),
};

/** The row and where it sat, so a refusal or an Undo puts it back in the same place. */
type Removed = { row: SentRecommendation; index: number };

const without = (queryClient: QueryClient, viewerId: string, id: string) =>
  queryClient.setQueryData<SentRecommendation[]>(sentKey(viewerId), (rows) =>
    rows ? rows.filter((row) => row.id !== id) : rows,
  );

const putBack = (queryClient: QueryClient, viewerId: string, { row, index }: Removed) =>
  queryClient.setQueryData<SentRecommendation[]>(sentKey(viewerId), (rows) => {
    if (!rows || rows.some((other) => other.id === row.id)) return rows;
    const next = [...rows];
    next.splice(Math.min(index, next.length), 0, row);
    return next;
  });

/** The name the row draws, so the confirmation names what disappeared. */
const titleOf = (row: SentRecommendation) => compactName(row) ?? row.title;

export function useDismissReceived(viewerId: string) {
  const queryClient = useQueryClient();
  const [notice, setNoticeState] = useState<RerankNotice | null>(null);
  /** What the confirmation's Undo restores. Cleared by any other notice. */
  const undoable = useRef<Removed | null>(null);
  /** Each dismissal still in flight, by recommendation id, so an Undo can wait for it. */
  const inFlight = useRef(new Map<string, Promise<Outcome>>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const show = (next: RerankNotice | null, restores: Removed | null = null) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    undoable.current = restores;
    setNoticeState(next);
    if (!next) return;
    AccessibilityInfo.announceForAccessibility?.(next.message);
    if (next.tone === 'info') {
      timer.current = setTimeout(() => {
        undoable.current = null;
        setNoticeState(null);
      }, NOTICE_MS);
    }
  };

  /** The title page's card reads the same rows; a stale copy would still name the sender. */
  const reconcileBanner = () =>
    void queryClient.invalidateQueries({ queryKey: ['title-recommendations', viewerId] });
  const reconcileAll = () => {
    void queryClient.invalidateQueries({ queryKey: sentKey(viewerId) });
    reconcileBanner();
  };

  const send = async (
    fn: 'dismiss_received_recommendation' | 'restore_received_recommendation',
    recommendationId: string,
  ): Promise<{ outcome: Outcome; code: string | undefined }> => {
    const { error } = await supabase.rpc(fn, {
      p_operation_id: newOperationId(),
      p_recommendation_id: recommendationId,
    });
    const serverError = error as ServerError;
    return { outcome: classifyWrite(serverError), code: serverError?.code ?? undefined };
  };

  const remove = (row: SentRecommendation) => {
    const rows = queryClient.getQueryData<SentRecommendation[]>(sentKey(viewerId)) ?? [];
    const removed: Removed = {
      row,
      index: Math.max(
        0,
        rows.findIndex((r) => r.id === row.id),
      ),
    };

    // A fetch already on its way would land the row back on screen.
    void queryClient.cancelQueries({ queryKey: sentKey(viewerId) });
    without(queryClient, viewerId, row.id);
    show(removalNotices.removed(titleOf(row)), removed);

    const pending = (async (): Promise<Outcome> => {
      const { outcome, code } = await send('dismiss_received_recommendation', row.id);
      if (outcome === 'committed') {
        reconcileBanner();
      } else if (outcome === 'refused') {
        // Proof nothing was written (including a backend without the function yet).
        putBack(queryClient, viewerId, removed);
        if (undoable.current?.row.id === row.id || !undoable.current) {
          show(removalNotices.failed(titleOf(row), code === '42501'));
        }
      } else if (mustReconcile(outcome)) {
        reconcileAll();
      }
      return outcome;
    })();

    inFlight.current.set(row.id, pending);
    void pending.finally(() => {
      if (inFlight.current.get(row.id) === pending) inFlight.current.delete(row.id);
    });
    return pending;
  };

  const undo = async () => {
    const target = undoable.current;
    show(null);
    if (!target) return;

    const dismissal = inFlight.current.get(target.row.id);
    // A refused dismissal already put the row back, and there is nothing to restore.
    if (dismissal && (await dismissal) === 'refused') return;

    putBack(queryClient, viewerId, target);
    const { outcome, code } = await send('restore_received_recommendation', target.row.id);
    if (outcome === 'committed') {
      reconcileBanner();
    } else if (outcome === 'refused') {
      without(queryClient, viewerId, target.row.id);
      show(removalNotices.undoFailed(titleOf(target.row), code === '42501'));
    } else {
      reconcileAll();
    }
  };

  return {
    remove,
    undo,
    notice,
    /** Closes the notice without acting on it. */
    close: () => show(null),
  };
}
