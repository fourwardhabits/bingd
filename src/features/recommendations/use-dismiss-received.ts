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
 * nothing to restore while the dismissal lands behind it. A dismissal whose reply was lost
 * is replayed under its own operation id before the restore, which waits for it on the
 * server (see `undo`).
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
type Placed = { row: SentRecommendation; index: number };

/** A removal an Undo can act on: where the row sat, and the dismissal it has to wait for. */
type Removed = Placed & {
  /** The dismissal's own operation id, kept so an Undo can replay it through the ledger. */
  operationId: string;
  /** How the dismissal ended, once it has. */
  dismissal: Promise<Outcome>;
};

const without = (queryClient: QueryClient, viewerId: string, id: string) =>
  queryClient.setQueryData<SentRecommendation[]>(sentKey(viewerId), (rows) =>
    rows ? rows.filter((row) => row.id !== id) : rows,
  );

const putBack = (queryClient: QueryClient, viewerId: string, { row, index }: Placed) =>
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
    operationId: string = newOperationId(),
  ): Promise<{ outcome: Outcome; code: string | undefined }> => {
    const { error } = await supabase.rpc(fn, {
      p_operation_id: operationId,
      p_recommendation_id: recommendationId,
    });
    const serverError = error as ServerError;
    return { outcome: classifyWrite(serverError), code: serverError?.code ?? undefined };
  };

  const remove = (row: SentRecommendation) => {
    const rows = queryClient.getQueryData<SentRecommendation[]>(sentKey(viewerId)) ?? [];
    const placed: Placed = {
      row,
      index: Math.max(
        0,
        rows.findIndex((r) => r.id === row.id),
      ),
    };
    const operationId = newOperationId();

    // At once, in the press's own event, so the row goes on the frame the reader tapped.
    without(queryClient, viewerId, row.id);

    const dismissal = (async (): Promise<Outcome> => {
      // A read already on its way would land the row back on screen, and cancelling one
      // reverts the cache to what it held before that read began: so cancel, then take the
      // row out again.
      await queryClient.cancelQueries({ queryKey: sentKey(viewerId) });
      without(queryClient, viewerId, row.id);
      const { outcome, code } = await send(
        'dismiss_received_recommendation',
        row.id,
        operationId,
      );
      if (outcome === 'committed') {
        // A read started while the call was out (a pull to refresh) may carry the row from
        // before the commit, whether it has landed or not. Cancel what is still in flight,
        // take the row out of whatever did land, and read the list again now that the server
        // agrees it is gone (Codex, #371).
        await queryClient.cancelQueries({ queryKey: sentKey(viewerId) });
        without(queryClient, viewerId, row.id);
        reconcileAll();
      } else if (outcome === 'refused') {
        // Proof nothing was written (including a backend without the function yet).
        putBack(queryClient, viewerId, placed);
        if (undoable.current?.row.id === row.id || !undoable.current) {
          show(removalNotices.failed(titleOf(row), code === '42501'));
        }
      } else if (mustReconcile(outcome)) {
        reconcileAll();
      }
      return outcome;
    })();

    show(removalNotices.removed(titleOf(row)), { ...placed, operationId, dismissal });
    return dismissal;
  };

  const undo = async () => {
    const target = undoable.current;
    show(null);
    if (!target) return;

    const outcome = await target.dismissal;
    // A refused dismissal already put the row back, and there is nothing to restore.
    if (outcome === 'refused') return;

    /**
     * **A dismissal nobody heard back from may still be running** (Codex, #371). A restore that
     * reaches the server before it commits finds nothing to restore and does not wait
     * (`races/recommendation-dismiss.mjs` D3), and the dismissal then lands behind it. So the
     * dismissal is replayed under its own operation id first: the ledger makes that wait for
     * the original's transaction, then answers `already_applied` (it committed) or applies it
     * now (it never did). Either way it has finished, and the restore that follows is
     * ordered after it. If even that cannot be established, the Undo says so rather than
     * guessing.
     */
    if (outcome === 'unknown') {
      const replay = await send(
        'dismiss_received_recommendation',
        target.row.id,
        target.operationId,
      );
      if (replay.outcome !== 'committed') {
        reconcileAll();
        show(removalNotices.undoFailed(titleOf(target.row), replay.code === '42501'));
        return;
      }
    }

    // The same reason as `remove`: a read in flight (a pull to refresh, or the reconcile of a
    // dismissal whose reply was lost) could answer with the dismissed list after the row is
    // back, so it is cancelled first and the list is reconciled once the restore has landed.
    await queryClient.cancelQueries({ queryKey: sentKey(viewerId) });
    putBack(queryClient, viewerId, target);
    const restored = await send('restore_received_recommendation', target.row.id);
    if (restored.outcome === 'committed') {
      reconcileAll();
    } else if (restored.outcome === 'refused') {
      without(queryClient, viewerId, target.row.id);
      show(removalNotices.undoFailed(titleOf(target.row), restored.code === '42501'));
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
