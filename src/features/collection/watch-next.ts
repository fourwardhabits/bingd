/**
 * Watch next, the pure half (20260929000200): the cap, the label, and how pinned titles
 * are lifted out of a list. No network here, so `CollectionView` can use it without
 * reaching for the client; the reads and writes are in `use-watch-next.ts`.
 */

/** The cap, which is the width of one poster row. The server's check says the same. */
export const WATCH_NEXT_MAX = 3;

/** The section's name, as the reader sees it above the pinned titles. */
export const WATCH_NEXT_LABEL = 'Watch next';

/**
 * Pinned first, in slot order, and never twice.
 *
 * `visible` is the Watchlist after the reader's filters and sort. The pinned titles are
 * lifted out of it — so a filter still hides a pin, and the "N of M" count stays honest —
 * and returned in slot order rather than sorted, because a pin stays on top of every sort,
 * Shuffle included. `rest` is everything else, in the order it arrived.
 */
export function partitionPinned<T extends { mediaItemId: string }>(
  visible: readonly T[],
  pinned: readonly string[],
): { pinned: T[]; rest: T[] } {
  if (pinned.length === 0) return { pinned: [], rest: [...visible] };
  const byId = new Map(visible.map((item) => [item.mediaItemId, item]));
  const lifted = pinned
    .map((id) => byId.get(id))
    .filter((item): item is T => item !== undefined);
  const liftedIds = new Set(lifted.map((item) => item.mediaItemId));
  return { pinned: lifted, rest: visible.filter((item) => !liftedIds.has(item.mediaItemId)) };
}
