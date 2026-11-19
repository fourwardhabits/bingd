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
import type { PlannedPromotion, TvPlan } from './tv-wall';
import type { RankedEntry } from './use-collection';
import {
  newOperationId,
  promoteShow,
  reorderRanking,
  unpromoteShow,
  type PromoteResult,
  type ReorderResult,
} from './writes';

type Move = Extract<PlannedMove, { kind: 'move' }>;

/**
 * Everything this controller sends (#319): a move in one ranking, a TV wall promotion of a
 * show drawn at its seasons' average, and the Undo of a promotion.
 */
type Write =
  | { kind: 'move'; move: Move }
  | { kind: 'promote'; plan: PlannedPromotion; entry: RankedEntry }
  | {
      kind: 'unpromote';
      mediaItemId: string;
      title: string;
      placementId: string;
      position: number;
    };

const titleOf = (write: Write) =>
  write.kind === 'move'
    ? write.move.title
    : write.kind === 'promote'
      ? write.plan.title
      : write.title;
const idOf = (write: Write) =>
  write.kind === 'move'
    ? write.move.mediaItemId
    : write.kind === 'promote'
      ? write.plan.mediaItemId
      : write.mediaItemId;

/** An insertion into a cached pool: the titles at and below the place move down one. */
const insertAt = (entries: readonly RankedEntry[], entry: RankedEntry): RankedEntry[] =>
  [
    ...entries.map((e) =>
      e.position >= entry.position ? { ...e, position: e.position + 1 } : e,
    ),
    entry,
  ].sort((a, b) => a.position - b.position);

/** A removal from a cached pool: the titles below close up. */
const removeFrom = (
  entries: readonly RankedEntry[],
  mediaItemId: string,
): RankedEntry[] | null => {
  const gone = entries.find((e) => e.mediaItemId === mediaItemId);
  if (!gone) return null;
  return entries
    .filter((e) => e.mediaItemId !== mediaItemId)
    .map((e) => (e.position > gone.position ? { ...e, position: e.position - 1 } : e));
};

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
 * One write is in flight at a time: `busy` is true from the drop to the answer, and one more
 * drop meanwhile is queued behind it (see `queued`). Undo is a second ordinary write with a
 * new operation id and the same guards, so it can never undo the wrong thing.
 *
 * The TV wall (#319) goes through the same path with `place`: a move among the explicit
 * shows is a `rank_reorder`, and a show drawn at its seasons' average is promoted with
 * `rank_promote_show`, whose Undo is `rank_unpromote_show`.
 */
export function useRerank(userId: string) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [notice, setNoticeState] = useState<RerankNotice | null>(null);
  /** The write a confirmation's Undo sends. Cleared by any other notice. */
  const undoable = useRef<Write | null>(null);
  /** The write a failure's Retry resends, with the operation id it was first sent under. */
  const retryable = useRef<{ write: Write; operationId: string } | null>(null);
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

  const keyOf = (write: Write) =>
    queryKeys.rankings(userId, write.kind === 'move' ? write.move.category : 'tv_shows');

  /**
   * Draws a write in the cache now, before the server answers, and returns what the cache
   * held before it. Synchronous, in the drop's own event; `revert: false` keeps the
   * prediction if a refetch was in flight.
   */
  const predict = (write: Write) => {
    const key = keyOf(write);
    const before = queryClient.getQueryData<RankedEntry[]>(key);
    // Across a category the cached row takes its new category too, so every score in both
    // categories reflows from the recounted band sizes before the server answers. A
    // promotion inserts the show; its Undo takes it out again.
    const predicted = !before
      ? null
      : write.kind === 'move'
        ? applyMove(before, write.move.mediaItemId, write.move.toPosition, write.move.toBucket)
        : write.kind === 'promote'
          ? insertAt(before, write.entry)
          : removeFrom(before, write.mediaItemId);
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
    write: Write;
    operationId: string;
    snapshot: ReturnType<typeof predict>;
  } | null>(null);

  /** The one call a write makes. */
  const call = (write: Write, operationId: string): Promise<ReorderResult | PromoteResult> => {
    if (write.kind === 'promote') {
      return promoteShow({
        operationId,
        mediaItemId: write.plan.mediaItemId,
        toPosition: write.plan.toPosition,
        toBucket: write.plan.toBucket,
        anchorId: write.plan.anchorId,
      });
    }
    if (write.kind === 'unpromote') {
      return unpromoteShow({
        operationId,
        mediaItemId: write.mediaItemId,
        placementId: write.placementId,
        expectedPosition: write.position,
      });
    }
    const { move } = write;
    return reorderRanking({
      operationId,
      mediaItemId: move.mediaItemId,
      toPosition: move.toPosition,
      expectedPosition: move.fromPosition,
      anchorId: move.anchorId,
      toBucket: crosses(move) ? move.toBucket : undefined,
      expectedBucket: move.bucket,
    });
  };

  const send = async (
    write: Write,
    operationId: string,
    isUndo: boolean,
    prepared?: ReturnType<typeof predict>,
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    undoable.current = null;
    retryable.current = null;

    const key = keyOf(write);
    const category = write.kind === 'move' ? write.move.category : 'tv_shows';
    const { before, predicted } = prepared ?? predict(write);
    // A prediction drawn earlier (a queued move) is still the cache's; keep it so.
    if (prepared) void queryClient.cancelQueries({ queryKey: key }, { revert: false });
    hapticDecision();

    const result = await call(write, operationId);

    const rollBack = () => {
      if (before) queryClient.setQueryData<RankedEntry[]>(key, before);
    };

    switch (result.outcome) {
      case 'moved':
      case 'promoted': {
        const after = predicted ?? before ?? [];
        if (write.kind === 'move') {
          const { move } = write;
          const score =
            (result.outcome === 'moved' ? result.reply.score : null) ??
            scoreFor(move.toBucket, move.toPosition, bandSizes(after));
          const into = crosses(move) ? move.toBucket : undefined;
          if (isUndo) {
            show(notices.undone(move.title, move.toPosition, into));
          } else {
            const back = undoOf(after, move);
            undoable.current = back ? { kind: 'move', move: back } : null;
            show(notices.moved(move.title, move.toPosition, score, into));
          }
        } else if (write.kind === 'promote' && result.outcome === 'promoted') {
          const { plan } = write;
          const score =
            result.reply.score ?? scoreFor(plan.toBucket, plan.toPosition, bandSizes(after));
          show(notices.promoted(plan.title, result.reply.position, score));
          undoable.current = result.reply.placementId
            ? {
                kind: 'unpromote',
                mediaItemId: plan.mediaItemId,
                title: plan.title,
                placementId: result.reply.placementId,
                position: result.reply.position,
              }
            : null;
        } else {
          show(notices.unpromoted(titleOf(write)));
        }
        invalidateAfterCollectionChange(queryClient, userId, idOf(write), { category });
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
        show(notices.outside(titleOf(write)));
        break;
      case 'failed':
      default:
        rollBack();
        // A lost reply may have committed. The refetch is the truth either way.
        if (result.outcome === 'failed' && result.changed) {
          invalidateAfterCollectionChange(queryClient, userId, idOf(write), { category });
        }
        retryable.current = { write, operationId };
        show(notices.failed(titleOf(write)));
        break;
    }

    inFlight.current = false;
    const next = queued.current;
    queued.current = null;
    if (next && (result.outcome === 'moved' || result.outcome === 'promoted')) {
      void send(next.write, next.operationId, false, next.snapshot);
      return;
    }
    setBusy(false);
  };

  /** Sends now, or queues one write behind the one in flight (see `queued`). */
  const enqueue = (write: Write): boolean => {
    if (inFlight.current) {
      if (queued.current) return false;
      queued.current = { write, operationId: newOperationId(), snapshot: predict(write) };
      return true;
    }
    void send(write, newOperationId(), false);
    return true;
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
    return enqueue({ kind: 'move', move: plan }) ? plan : null;
  };

  /**
   * A TV wall drop or accessibility action (#319), planned by `tv-wall.ts`: a move among the
   * explicit shows, a promotion of an average poster (`entry` is the show's row as the
   * `tv_shows` cache will hold it), or a drag that passed only averages, which is explained
   * and sends nothing.
   */
  const place = (plan: TvPlan | null, entry?: RankedEntry): boolean => {
    if (!plan || plan.kind === 'noop') return false;
    if (plan.kind === 'passover') {
      show(notices.passover(plan.title));
      return false;
    }
    if (plan.kind === 'promote') {
      if (!entry) return false;
      return enqueue({ kind: 'promote', plan, entry });
    }
    return enqueue({ kind: 'move', move: plan });
  };

  const undo = () => {
    const back = undoable.current;
    if (!back || inFlight.current) return;
    void send(back, newOperationId(), true);
  };

  /** Resends the failed write under its first operation id (I5 makes this safe). */
  const retry = () => {
    const last = retryable.current;
    if (!last || inFlight.current) return;
    void send(last.write, last.operationId, false);
  };

  const dismiss = () => {
    undoable.current = null;
    retryable.current = null;
    show(null);
  };

  return {
    busy,
    notice,
    move,
    place,
    undo,
    retry,
    dismiss,
    explain: (n: RerankNotice | null) => show(n),
  };
}

export type RerankController = ReturnType<typeof useRerank>;
