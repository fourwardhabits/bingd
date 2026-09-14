import { useCallback, useEffect, useRef } from 'react';

/**
 * The end of a list, counted only for a reader who is scrolling.
 *
 * A list reports reaching its end whenever it is shorter than the screen, too. Under
 * Movies or TV a page of mixed search results can hold two films, so a list that asked for
 * the next page on every such report would fetch page after page with nobody touching the
 * phone, each one a charged provider request. So the end counts only once a drag has begun
 * since the last page was asked for: one gesture, at most one page (2026-09-14).
 *
 * `onEnd` returns whether it actually asked. A refusal (nothing more, or a page already on
 * its way) leaves the gesture unspent, so reaching the end again in the same drag can ask
 * once the earlier page has landed.
 *
 * **The end is remembered, because FlashList reports it once** (independent review).
 * FlashList latches its end event while the list stays near its end, so a short list
 * reports it once, on first paint, before anybody has touched it, and never again however
 * the reader drags. An end that arrived with nobody dragging is therefore kept, and the
 * next drag spends it. Where a list is too short to drag at all (Android does not report a
 * drag on content that cannot scroll), the screen's "Show more results" link is the way on.
 *
 * A remembered end is forgotten when the list's rows change (`rowCount`). Once a page has
 * landed, the reader is no longer at the end it recorded, and a drag back at the top must
 * not spend it; if the longer list is still near its end, FlashList reports that afresh.
 */
export function useScrollGatedEnd(onEnd: (() => boolean) | undefined, rowCount: number) {
  const dragged = useRef(false);
  const endPending = useRef(false);

  useEffect(() => {
    endPending.current = false;
  }, [rowCount]);

  const onScrollBeginDrag = useCallback(() => {
    dragged.current = true;
    if (!endPending.current || !onEnd) return;
    if (onEnd()) {
      endPending.current = false;
      dragged.current = false;
    }
  }, [onEnd]);

  const onEndReached = useCallback(() => {
    if (!onEnd) return;
    if (!dragged.current) {
      endPending.current = true;
      return;
    }
    if (onEnd()) {
      dragged.current = false;
      endPending.current = false;
    } else {
      endPending.current = true;
    }
  }, [onEnd]);

  return { onScrollBeginDrag, onEndReached };
}
