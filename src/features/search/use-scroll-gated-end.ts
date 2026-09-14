import { useCallback, useRef } from 'react';

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
 */
export function useScrollGatedEnd(onEnd: (() => boolean) | undefined) {
  const dragged = useRef(false);

  const onScrollBeginDrag = useCallback(() => {
    dragged.current = true;
  }, []);

  const onEndReached = useCallback(() => {
    if (!onEnd || !dragged.current) return;
    if (onEnd()) dragged.current = false;
  }, [onEnd]);

  return { onScrollBeginDrag, onEndReached };
}
