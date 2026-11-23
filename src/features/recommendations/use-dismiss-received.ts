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
  /** How the dismissal ended, once it has. */
  dismissal: Promise<Outcome>;
};

type Write = 'dismiss_received_recommendation' | 'restore_received_recommendation';

/** One recommendation's writes, in order, and the last one whose answer was lost. */
type Lane = {
  tail: Promise<unknown>;
  seq: number;
  unsettled: { fn: Write; operationId: string } | null;
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

/**
 * The lanes, for the life of the process and keyed by viewer as well as by recommendation.
 * Module-level rather than a ref because Sent to You unmounts whenever For You is chosen, and
 * a write still in flight from before that must still order the next one.
 */
const lanes = new Map<string, Lane>();

/** For tests: forget the lanes a previous test left behind. */
export function resetDismissLanes() {
  lanes.clear();
}

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

  /**
   * A failure that arrives after the fact, for one row. It must not take away the Undo of a
   * *newer* removal still on offer, of another row or of this one (Codex, #371): that stays,
   * and the failure is spoken instead. The row itself is already right — put back, taken out
   * again or reconciled — so what is lost is only the sentence on screen.
   */
  const fail = (rowId: string, failure: RerankNotice, latest: boolean) => {
    // Another row's Undo, or a newer removal of this same row, is the notice that matters.
    if (undoable.current && (undoable.current.row.id !== rowId || !latest)) {
      AccessibilityInfo.announceForAccessibility?.(failure.message);
      return;
    }
    show(failure);
  };

  /** The title page's card reads the same rows; a stale copy would still name the sender. */
  const reconcileBanner = () =>
    void queryClient.invalidateQueries({ queryKey: ['title-recommendations', viewerId] });
  const reconcileAll = () => {
    void queryClient.invalidateQueries({ queryKey: sentKey(viewerId) });
    reconcileBanner();
  };

  const send = async (
    fn: Write,
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

  /**
   * **One lane per recommendation** (Codex, #371). Every write about one row — a dismissal,
   * its Undo, a second removal after that Undo — runs after the one before it has answered,
   * so the server sees them in the order the reader made them. Two of them in flight at once
   * could otherwise arrive reversed: a dismissal that reaches the server before an
   * uncommitted restore finds the row already dismissed and does nothing, and the restore
   * then lands behind it (the mirror of `races/recommendation-dismiss.mjs` D3).
   *
   * A write whose reply was lost is `unsettled`: it may still be running. The next write in
   * the lane first replays it under its own operation id, which the ledger makes wait for the
   * original's transaction and answer `already_applied` (or apply it now, if it never
   * arrived). Only then is the new write sent. If even that cannot be established, the new
   * write is not sent and the reader is told.
   */
  const laneOf = (id: string) => {
    const key = `${viewerId}:${id}`;
    let lane = lanes.get(key);
    if (!lane) {
      lane = { tail: Promise.resolve(), seq: 0, unsettled: null };
      lanes.set(key, lane);
    }
    return lane;
  };
  /** Runs `task` after every earlier write for this row. `isLatest` is false once another is queued. */
  const enqueue = <T>(
    id: string,
    task: (isLatest: () => boolean) => Promise<T>,
  ): Promise<T> => {
    const lane = laneOf(id);
    const seq = (lane.seq += 1);
    const run = lane.tail.then(() => task(() => lane.seq === seq));
    lane.tail = run.catch(() => undefined);
    return run;
  };
  /**
   * Sends one write with a fresh operation id. If nobody heard the answer it is replayed once
   * at once under the same id, which waits for the original on the server and so usually
   * establishes how it ended; if even that is unheard, the lane remembers it for the next
   * write to settle first.
   */
  const write = async (fn: Write, id: string) => {
    const operationId = newOperationId();
    const result = await send(fn, id, operationId);
    if (result.outcome !== 'unknown') {
      laneOf(id).unsettled = null;
      return result;
    }
    laneOf(id).unsettled = { fn, operationId };
    const settled = await settle(id);
    return settled.ok ? { outcome: 'committed' as const, code: undefined } : result;
  };
  /** Establishes how this row's last unanswered write ended, by replaying it. */
  const settle = async (id: string): Promise<{ ok: boolean; code?: string }> => {
    const lane = laneOf(id);
    if (!lane.unsettled) return { ok: true };
    const replay = await send(lane.unsettled.fn, id, lane.unsettled.operationId);
    if (replay.outcome !== 'committed') return { ok: false, code: replay.code };
    lane.unsettled = null;
    return { ok: true };
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

    // At once, in the press's own event, so the row goes on the frame the reader tapped.
    without(queryClient, viewerId, row.id);

    const dismissal = enqueue(row.id, async (isLatest): Promise<Outcome> => {
      // A read already on its way would land the row back on screen, and cancelling one
      // reverts the cache to what it held before that read began: so cancel, then take the
      // row out again.
      await queryClient.cancelQueries({ queryKey: sentKey(viewerId) });
      without(queryClient, viewerId, row.id);

      // An earlier Undo of this row whose reply was lost has to have finished first.
      const prior = await settle(row.id);
      if (!prior.ok) {
        reconcileAll();
        fail(row.id, removalNotices.failed(titleOf(row), prior.code === '42501'), isLatest());
        return 'refused';
      }

      const { outcome, code } = await write('dismiss_received_recommendation', row.id);
      if (outcome === 'committed') {
        // A read started while the call was out (a pull to refresh) may carry the row from
        // before the commit, whether it has landed or not. Cancel what is still in flight,
        // take the row out of whatever did land, and read the list again now that the server
        // agrees it is gone (Codex, #371). An Undo already queued behind this reconciles
        // for itself.
        await queryClient.cancelQueries({ queryKey: sentKey(viewerId) });
        if (isLatest()) {
          without(queryClient, viewerId, row.id);
          reconcileAll();
        } else {
          reconcileBanner();
        }
      } else if (outcome === 'refused') {
        // Proof nothing was written (including a backend without the function yet).
        if (isLatest()) putBack(queryClient, viewerId, placed);
        fail(row.id, removalNotices.failed(titleOf(row), code === '42501'), isLatest());
      } else if (mustReconcile(outcome)) {
        reconcileAll();
      }
      return outcome;
    });

    show(removalNotices.removed(titleOf(row)), { ...placed, dismissal });
    return dismissal;
  };

  const undo = async () => {
    const target = undoable.current;
    show(null);
    if (!target) return;
    const id = target.row.id;

    await enqueue(id, async (isLatest) => {
      // Already answered: the lane ran it first.
      const outcome = await target.dismissal;
      // A refused dismissal wrote nothing, so there is nothing to restore on the server. Its
      // own put-back stood down because this Undo was queued behind it, so the row goes back
      // here (Codex, #371).
      if (outcome === 'refused') {
        if (isLatest()) putBack(queryClient, viewerId, target);
        return;
      }

      // A dismissal nobody heard back from may still be running (Codex, #371): a restore
      // that reached the server first would find nothing to restore and not wait (D3).
      const prior = await settle(id);
      if (!prior.ok) {
        reconcileAll();
        fail(
          id,
          removalNotices.undoFailed(titleOf(target.row), prior.code === '42501'),
          isLatest(),
        );
        return;
      }

      // The same reason as `remove`: a read in flight (a pull to refresh, or the reconcile
      // of a dismissal whose reply was lost) could answer with the dismissed list after the
      // row is back, so it is cancelled first and the list is reconciled once the restore
      // has landed. A removal queued behind this one owns the screen from here.
      await queryClient.cancelQueries({ queryKey: sentKey(viewerId) });
      if (isLatest()) putBack(queryClient, viewerId, target);
      const restored = await write('restore_received_recommendation', id);
      if (restored.outcome === 'committed') {
        if (isLatest()) reconcileAll();
        else reconcileBanner();
      } else if (restored.outcome === 'refused') {
        if (isLatest()) without(queryClient, viewerId, id);
        fail(
          id,
          removalNotices.undoFailed(titleOf(target.row), restored.code === '42501'),
          isLatest(),
        );
      } else {
        reconcileAll();
      }
    });
  };

  return {
    remove,
    undo,
    notice,
    /** Closes the notice without acting on it. */
    close: () => show(null),
  };
}
