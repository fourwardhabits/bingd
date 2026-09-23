/**
 * The arithmetic of drag-to-reorder on a list's own page (founder QA, 2026-09-21), with
 * no React and no gesture in it, so the part that decides where a title lands is tested
 * directly rather than through a simulated finger.
 *
 * The gesture itself is core React Native — the responder system and `Animated` — rather than
 * the installed gesture-handler/reanimated pair: neither is mounted anywhere in this app
 * yet, and a first use of a native gesture system is a device-risk this pass does not
 * take. Nothing here needs a new binary.
 */

/** `items` with the entry at `from` moved to `to`. A no-op move returns a copy. */
export function reorder<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from < 0 || from >= next.length) return next;
  const clamped = Math.max(0, Math.min(to, next.length - 1));
  const [moved] = next.splice(from, 1);
  next.splice(clamped, 0, moved as T);
  return next;
}

/**
 * Where a row dragged `dy` points from `from` would land.
 *
 * A neighbour is passed once the dragged row has travelled past half of it, which is the
 * threshold a reader expects: the rows swap as the lifted one crosses their middle, not
 * their far edge. `heights` are the measured row heights; a row not measured yet counts
 * as `fallback`.
 */
export function targetIndex(
  heights: readonly (number | undefined)[],
  count: number,
  from: number,
  dy: number,
  fallback: number,
): number {
  let to = from;
  let travelled = 0;
  if (dy > 0) {
    while (to < count - 1) {
      const next = heights[to + 1] ?? fallback;
      if (dy > travelled + next / 2) {
        travelled += next;
        to += 1;
      } else break;
    }
  } else if (dy < 0) {
    while (to > 0) {
      const previous = heights[to - 1] ?? fallback;
      if (-dy > travelled + previous / 2) {
        travelled += previous;
        to -= 1;
      } else break;
    }
  }
  return to;
}

/**
 * How far a row that is *not* being dragged moves out of the way: up by the lifted row's
 * height if the lifted row passed below it, down if it passed above, otherwise nowhere.
 */
export function shiftFor(index: number, from: number, to: number, liftedHeight: number): number {
  if (from < to && index > from && index <= to) return -liftedHeight;
  if (from > to && index >= to && index < from) return liftedHeight;
  return 0;
}
