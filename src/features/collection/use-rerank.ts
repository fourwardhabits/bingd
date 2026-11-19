import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { queryKeys } from '@/lib/query';
import { hapticDecision } from '@/ui/haptics';

import { invalidateAfterCollectionChange } from './invalidate';
import {
  applyMove,
  crosses,
  notices,
  planMove,
  undoOf,
  type Ladder,
  type PlannedMove,
  type RerankNotice,
} from './rerank';
import { bandSizes, scoreFor, type Bucket } from './score';
import type { RankedEntry } from './use-collection';
import { newOperationId, reorderRanking } from './writes';

type Move = Extract<PlannedMove, { kind: 'move' }>;

/** How long a confirmation stays before it fades. Errors stay until acted on. */
export const NOTICE_MS = 6000;

/**
 * **One move path for every Collection drag, accessibility action and Undo** (#318).
 *
 * A drop is planned (`rerank.ts`), applied to the cached pool at once so the order and
 * every reflowed score appear before the server answers, and then sent as one guarded
 * `rank_reorder`. The server's answer decides what stays:
 *
 *   moved    keep the prediction, reconcile every cache a ranking touches, offer Undo;
 *   stale    roll back, refetch, say the ranking changed elsewhere;
 *   outside  roll back, refetch: the server refused the place (the client checks the same
 *            rule first, so the list it checked had changed);
 *   failed   roll back, reconcile if the outcome is unknown, offer Retry with the SAME
 *            operation id, so a move that did land is answered from the ledger.
 *
 * One move is in flight at a time: `busy` is true from the drop to the answer, and a drag
 * started meanwhile is refused by its caller. Undo is a second ordinary move with a new
 * operation id and the same guards, so it can never undo the wrong thing.
 */
export function useRerank(userId: string) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [notice, setNoticeState] = useState<RerankNotice | null>(null);
  /** The move a confirmation's Undo reverses. Cleared by any other notice. */
  const undoable = useRef<Move | null>(null);
  /** The move a failure's Retry resends, with the operation id it was first sent under. */
  const retryable = useRef<{ move: Move; operationId: string } | null>(null);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const show = (next: RerankNotice | null) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setNoticeState(next);
    if (!next) return;
    AccessibilityInfo.announceForAccessibility(next.message);
    if (next.tone === 'info') {
      timer.current = setTimeout(() => {
        undoable.current = null;
        setNoticeState(null);
      }, NOTICE_MS);
    }
  };

  const keyOf = (move: Move) => queryKeys.rankings(userId, move.category);

  /**
   * Draws a move in the cache now, before the server answers, and returns what the cache
   * held before it. Synchronous, in the drop's own event; `revert: false` keeps the
   * prediction if a refetch was in flight.
   */
  const predict = (move: Move) => {
    const key = keyOf(move);
    const before = queryClient.getQueryData<RankedEntry[]>(key);
    // Across a category the cached row takes its new category too, so every score in both
    // categories reflows from the recounted band sizes before the server answers.
    const predicted = before
      ? applyMove(before, move.mediaItemId, move.toPosition, move.toBucket)
      : null;
    void queryClient.cancelQueries({ queryKey: key }, { revert: false });
    if (predicted) queryClient.setQueryData<RankedEntry[]>(key, predicted);
    return { before, predicted };
  };

  /**
   * **A second drop while the first is saving is queued, not refused** (Android QA,
   * 2026-11-20). Refusing it made a quick second long-press do nothing at all, which read
   * as the titles "not responding". It is drawn at once and sent the moment the first is
   * answered, from the order the first produced, which is the order the reader dragged on.
   * If the first fails, the rollback takes both back and the second is not sent. One at a
   * time: a third drop while one is queued springs back.
   */
  const queued = useRef<{
    move: Move;
    operationId: string;
    snapshot: ReturnType<typeof predict>;
  } | null>(null);

  const send = async (
    move: Move,
    operationId: string,
    isUndo: boolean,
    prepared?: ReturnType<typeof predict>,
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    undoable.current = null;
    retryable.current = null;

    const key = keyOf(move);
    const { before, predicted } = prepared ?? predict(move);
    // A prediction drawn earlier (a queued move) is still the cache's; keep it so.
    if (prepared) void queryClient.cancelQueries({ queryKey: key }, { revert: false });
    hapticDecision();

    const result = await reorderRanking({
      operationId,
      mediaItemId: move.mediaItemId,
      toPosition: move.toPosition,
      expectedPosition: move.fromPosition,
      anchorId: move.anchorId,
      toBucket: crosses(move) ? move.toBucket : undefined,
      expectedBucket: move.bucket,
    });

    const rollBack = () => {
      if (before) queryClient.setQueryData<RankedEntry[]>(key, before);
    };

    switch (result.outcome) {
      case 'moved': {
        const after = predicted ?? before ?? [];
        const score =
          result.reply.score ?? scoreFor(move.toBucket, move.toPosition, bandSizes(after));
        const into = crosses(move) ? move.toBucket : undefined;
        if (isUndo) {
          show(notices.undone(move.title, move.toPosition, into));
        } else {
          undoable.current = undoOf(after, move);
          show(notices.moved(move.title, move.toPosition, score, into));
        }
        invalidateAfterCollectionChange(queryClient, userId, move.mediaItemId, {
          category: move.category,
        });
        break;
      }
      case 'stale':
        rollBack();
        void queryClient.invalidateQueries({ queryKey: key });
        show(notices.stale());
        break;
      case 'outside':
        rollBack();
        void queryClient.invalidateQueries({ queryKey: key });
        show(notices.outside(move.title));
        break;
      case 'failed':
      default:
        rollBack();
        // A lost reply may have committed. The refetch is the truth either way.
        if (result.outcome === 'failed' && result.changed) {
          invalidateAfterCollectionChange(queryClient, userId, move.mediaItemId, {
            category: move.category,
          });
        }
        retryable.current = { move, operationId };
        show(notices.failed(move.title));
        break;
    }

    inFlight.current = false;
    const next = queued.current;
    queued.current = null;
    if (next && result.outcome === 'moved') {
      void send(next.move, next.operationId, false, next.snapshot);
      return;
    }
    setBusy(false);
  };

  /**
   * A drop or an accessibility action: `from` and `to` are indices on `ladder`, and
   * `toBucket` the category an accessibility action names (a drag lands in the category of
   * the title it displaces). Returns what was planned, so the gesture can spring back from
   * a drop that is not a place.
   */
  const move = (
    ladder: Ladder,
    from: number,
    to: number,
    toBucket?: Bucket,
  ): PlannedMove | null => {
    const plan = planMove(ladder, from, to, toBucket);
    if (!plan || plan.kind === 'noop') return plan;
    if (inFlight.current) {
      if (queued.current) return null;
      queued.current = { move: plan, operationId: newOperationId(), snapshot: predict(plan) };
      return plan;
    }
    void send(plan, newOperationId(), false);
    return plan;
  };

  const undo = () => {
    const back = undoable.current;
    if (!back || inFlight.current) return;
    void send(back, newOperationId(), true);
  };

  /** Resends the failed move under its first operation id (I5 makes this safe). */
  const retry = () => {
    const last = retryable.current;
    if (!last || inFlight.current) return;
    void send(last.move, last.operationId, false);
  };

  const dismiss = () => {
    undoable.current = null;
    retryable.current = null;
    show(null);
  };

  return { busy, notice, move, undo, retry, dismiss, explain: (n: RerankNotice | null) => show(n) };
}

export type RerankController = ReturnType<typeof useRerank>;
