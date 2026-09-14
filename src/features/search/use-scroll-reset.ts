import { useLayoutEffect, useRef } from 'react';

/** What the hook needs of a list: FlashList's ref, or anything else that scrolls to an offset. */
export type ScrollsToOffset = {
  scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
};

/**
 * A list that starts at the top whenever it becomes a different list (founder, 2026-09-14).
 *
 * `key` names the dataset: on Search, the chip and the normalised query. A chip pressed, a
 * See all followed or a new query typed changes it, and the list goes back to its first row
 * rather than showing the new rows from wherever the old ones had been scrolled to. A page
 * appended, a loading footer, a stale dim lifting or any other render for the same chip and
 * query leaves it alone, so reading down a long list is never interrupted.
 *
 * **In a layout effect, without animation**, so the jump happens before the frame that would
 * have drawn the new rows at the old offset: the reader sees the new list at its top, not
 * the old offset flashing first. A list that is not mounted (an empty state, a skeleton) needs
 * nothing: when it mounts again it starts at the top anyway.
 */
export function useScrollReset<T extends ScrollsToOffset>(key: string) {
  const list = useRef<T>(null);
  const shown = useRef(key);

  useLayoutEffect(() => {
    if (shown.current === key) return;
    shown.current = key;
    list.current?.scrollToOffset({ offset: 0, animated: false });
  }, [key]);

  return list;
}
