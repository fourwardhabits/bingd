import { useCallback, useRef, useState } from 'react';

/**
 * `RefreshControl`'s `refreshing` flag, meaning **the reader pulled** and nothing else.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS FOR (founder, physical iOS 1.0.1 build 9, 2026-09-09)
 *
 * Writing a review in the bottom sheet made the title page *behind it* slide down and back
 * up, exposing a blank band above the hero, while the sheet itself stayed perfectly still.
 * It was reported once against build 8 and answered by holding the bottom safe-area inset
 * steady while a keyboard is up (`use-stable-bottom-inset.ts`) — a real defect, correctly
 * fixed, and **not this one**, which is why it came back on build 9 unchanged.
 *
 * The actual chain has nothing to do with insets and everything to do with the word
 * *refreshing*:
 *
 *   1. `LogSheet` autosaves the note while it is being typed — a trailing debounce with a
 *      max-wait cap, so continuous typing writes every few seconds by design;
 *   2. a successful save calls `invalidateAfterCollectionChange`, which invalidates
 *      `queryKeys.title(mediaItemId)`;
 *   3. the title page's `personal` query is keyed under that prefix, so it refetches;
 *   4. `isRefetching` goes true — and it was wired straight to `RefreshControl.refreshing`;
 *   5. iOS reads `refreshing = true` as `beginRefreshing()`, which is a **programmatic
 *      pull**: UIKit grows `contentInset.top` by the control's height and animates the
 *      content down to meet it. That is the blank band. When the refetch settles, the
 *      inset goes back and the page slides up.
 *
 * Every symptom follows from that and none of it needs a keyboard at all: the keyboard is
 * merely what the reader is doing while the autosave fires. The sheet is unaffected
 * because it is in a modal that is not this scroll view.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIX IS THE FLAG AND NOT THE AUTOSAVE
 *
 * The autosave is right: text that is not saved is text that gets lost, and this codebase
 * has already paid for that once. The invalidation is right: the page must show the note
 * that was just written. The refetch is right.
 *
 * What is wrong is that `isRefetching` answers *is this query in flight again*, and
 * `refreshing` asks *is the reader holding this list open*. They coincide for exactly one
 * of the several reasons a query refetches, and every other reason — an invalidation, a
 * window-focus refetch, a mount — becomes a page that jumps under somebody who is not
 * touching it. A control the reader operates should be driven by the reader's own gesture.
 *
 * So `onRefresh` is the only thing that sets it, and the work it started is the only thing
 * that clears it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PROMISES
 *
 * - **Never true unless `onRefresh` fired.** A background refetch cannot move the page.
 * - **Always cleared**, including when every refetch rejects: `allSettled`, not `all`. A
 *   spinner that never stops is the failure mode a naive version has, and on iOS it is
 *   not merely a spinner — it is a page held permanently 60 points down.
 * - **Not cleared by a later unmount**, or by a second pull that started after this one.
 *   `run` is the token: only the pull that is still current is allowed to clear the flag.
 */
export function usePullRefresh(work: () => Promise<unknown>[] | Promise<unknown>) {
  const [refreshing, setRefreshing] = useState(false);
  /**
   * Which pull is current. A second pull while the first is still settling would
   * otherwise be cleared by the first one's completion, leaving a spinner up with nothing
   * behind it — and on iOS, an inset with nothing behind it.
   */
  const run = useRef(0);

  const onRefresh = useCallback(() => {
    const token = (run.current += 1);
    const stop = () => {
      if (run.current === token) setRefreshing(false);
    };

    setRefreshing(true);

    let started: Promise<unknown>[] | Promise<unknown>;
    try {
      started = work();
    } catch {
      /**
       * **A caller that throws before it returns a promise** (independent review, P2).
       *
       * `setRefreshing(true)` is already done by this point, and without this there is
       * nothing left to clear it: no promise was created, so nothing settles. The flag
       * stays true for the life of the screen, which on iOS is the page held down with a
       * band of background above it — the exact symptom this hook exists to remove,
       * reintroduced through the one path that skips its own cleanup.
       *
       * Swallowed rather than rethrown, because this runs inside the reader's gesture: a
       * throw here would surface as an unhandled error over a page they were only
       * refreshing, and the caller's own `catch` — if it has one — has already had its
       * chance. The visible outcome is a pull that ends immediately, which is the truth.
       */
      stop();
      return;
    }

    void Promise.allSettled(Array.isArray(started) ? started : [started]).then(stop);
  }, [work]);

  return { refreshing, onRefresh };
}
