/**
 * Where a lifted Collection title is over, and where the others move to make room (#318).
 *
 * Pure, so it is tested with plain rectangles rather than a simulated finger. The rectangles
 * are the list's own item layouts (`FlashListRef.getLayout`), which describe a three-across
 * poster grid and a column of rows alike: one function serves both views.
 */

export type Rect = { x: number; y: number; width: number; height: number };
export type LayoutOf = (index: number) => Rect | undefined;

/**
 * The index under `point`, among the first `count` items.
 *
 * Items are laid out in reading order, so `y` never decreases with the index. The row is
 * found by binary search on `y`, then the column inside it by `x`. A point above the first
 * item is the first item, and one below the last item's row is the last item, whatever the
 * column. -1 only when nothing is laid out.
 */
export function hitIndex(point: { x: number; y: number }, count: number, layoutOf: LayoutOf): number {
  const first = layoutOf(0);
  if (count <= 0 || !first) return -1;
  // Past either end of the ladder is that end: above the first rung is the top, and below the
  // last one -- over the unranked titles, which are never targets -- is the bottom.
  if (point.y < first.y) return 0;
  const last = layoutOf(count - 1);
  if (last && point.y >= last.y + last.height) return count - 1;

  // The last item whose top is at or above the point.
  let lo = 0;
  let hi = count - 1;
  let found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rect = layoutOf(mid);
    if (!rect) {
      hi = mid - 1;
      continue;
    }
    if (rect.y <= point.y) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  const rowY = layoutOf(found)?.y ?? 0;
  let start = found;
  while (start > 0 && layoutOf(start - 1)?.y === rowY) start -= 1;
  let end = found;
  while (end < count - 1 && layoutOf(end + 1)?.y === rowY) end += 1;

  // Inside the row: the item whose horizontal span holds the point, else the nearest end.
  for (let i = start; i <= end; i += 1) {
    const rect = layoutOf(i);
    if (rect && point.x < rect.x + rect.width) return i;
  }
  return end;
}

/**
 * Which slot the item at `index` is drawn in while the item at `from` is held over `to`:
 * the items between close up by one towards `from`, which opens the gap at `to`. Null when
 * it stays where it is (outside the range, or the lifted item itself).
 */
export function slotOf(index: number, from: number, to: number): number | null {
  if (index === from) return null;
  if (from < to && index > from && index <= to) return index - 1;
  if (from > to && index >= to && index < from) return index + 1;
  return null;
}

/** How far the item at `index` is translated to reach {@link slotOf}'s slot. */
export function displacement(
  index: number,
  from: number,
  to: number,
  layoutOf: LayoutOf,
): { x: number; y: number } | null {
  const slot = slotOf(index, from, to);
  if (slot === null) return null;
  const here = layoutOf(index);
  const there = layoutOf(slot);
  if (!here || !there) return null;
  return { x: there.x - here.x, y: there.y - here.y };
}

/** The edge band, in points, inside which a held item scrolls the list. */
export const AUTO_SCROLL_EDGE = 64;
/** The fastest auto-scroll, in points per frame, reached at the very edge. */
export const AUTO_SCROLL_MAX = 18;

/**
 * Points per frame to scroll while the held item's centre is at `centreY` in a viewport
 * `height` tall: negative near the top, positive near the bottom, zero in between, and
 * proportional to how far into the edge band it is.
 */
export function autoScrollSpeed(centreY: number, height: number): number {
  if (height <= AUTO_SCROLL_EDGE * 2) return 0;
  if (centreY < AUTO_SCROLL_EDGE) {
    const depth = Math.min(1, (AUTO_SCROLL_EDGE - centreY) / AUTO_SCROLL_EDGE);
    return -Math.round(depth * AUTO_SCROLL_MAX);
  }
  if (centreY > height - AUTO_SCROLL_EDGE) {
    const depth = Math.min(1, (centreY - (height - AUTO_SCROLL_EDGE)) / AUTO_SCROLL_EDGE);
    return Math.round(depth * AUTO_SCROLL_MAX);
  }
  return 0;
}

/**
 * **Where an item is on screen, from the list's own numbers** (Android QA, 2026-11-20).
 *
 * `FlashListRef.getLayout` is in the items container's coordinates, which start below the
 * header (`getFirstItemOffset`). The list's viewport is that content scrolled by `scrollTop`
 * (`getAbsoluteLastScrollOffset`, the raw content offset). So an item's top inside the
 * viewport is `firstItemOffset + layoutY - scrollTop`.
 *
 * This replaces `measureLayout` for the vertical position of a lifted copy. On the new
 * architecture that measurement is computed from the shadow tree, whose idea of a scroll
 * view's offset can lag the native one after a scroll on Android: the founder's "scroll down
 * slightly, then lift Iron Man" put the copy a scroll's distance from the finger.
 */
export function itemTopInViewport(layoutY: number, firstItemOffset: number, scrollTop: number) {
  return firstItemOffset + layoutY - scrollTop;
}

/**
 * The inverse: the item-layout `y` under a viewport `y`. Hit-testing goes through this from
 * what is on screen (the copy under the finger), so a header that changes height, an
 * auto-scroll, or an item re-measured mid-gesture cannot move the target away from the finger.
 */
export function layoutYAtViewport(viewportY: number, firstItemOffset: number, scrollTop: number) {
  return viewportY + scrollTop - firstItemOffset;
}
