import { BUCKET_LABEL, bandSizes, formatScore, scoreFor, type Bucket } from './score';
import {
  activeFilterCount,
  type CollectionFilters,
  type CollectionItem,
  type CollectionSegment,
  type CollectionSortState,
} from './filters';
import type { RankedEntry, RankingCategory } from './use-collection';

/**
 * **Collection drag-to-rerank: where a title may go, decided without React** (#318,
 * `docs/architecture/collection-rerank.md`).
 *
 * A drop moves `rankings.position` through `rank_reorder`. This module decides, from what is
 * on screen, whether the screen is a ranking at all, and turns a drop's display index into
 * the absolute positions and guards that call takes. The gesture (`use-lift-drag.ts`), the
 * write (`use-rerank.ts`) and the accessibility actions all go through it, so a drag and a
 * VoiceOver "Move up" cannot disagree about where a title lands.
 */

/** One ranked title on the ladder: its index on screen is `position - 1`. */
export type Rung = {
  mediaItemId: string;
  title: string;
  bucket: Bucket;
  position: number;
};

/** A screen that **is** one ranking: one pool, in position order, `1..n` with no gaps. */
export type Ladder = {
  category: RankingCategory;
  rungs: Rung[];
};

/**
 * Why a long-press does not lift a title. The order of the checks is the order a reader
 * fixes them in, so the first one named is the one to act on.
 *
 *   segment   Watchlist or Unranked: nothing there has a position.
 *   tv-wall   The TV wall: one poster per series, each an explicit show score or a season
 *             average. It has no single ladder, so it is never mutated from a display index.
 *   sort      Any order but Rating, highest first. A display index is not a position.
 *   filters   Any filter. The positions on screen are not contiguous.
 *   unranked  The title has no position to move.
 *   ambiguous The rows do not read as positions 1..n of one pool. Never expected; a guard.
 */
export type RerankBlock = 'segment' | 'tv-wall' | 'sort' | 'filters' | 'unranked' | 'ambiguous';

/**
 * Whether the screen as configured can be a ladder at all. `pool` is the ranking the drawn
 * items belong to, or null for a wall that mixes pools (the TV wall).
 */
export function screenBlock({
  segment,
  sort,
  filters,
  pool,
}: {
  segment: CollectionSegment;
  sort: CollectionSortState;
  filters: CollectionFilters;
  pool: RankingCategory | null;
}): RerankBlock | null {
  if (segment !== 'watched') return 'segment';
  if (pool === null) return 'tv-wall';
  if (sort.axis !== 'rating' || sort.direction !== 'desc') return 'sort';
  if (activeFilterCount(filters) > 0) return 'filters';
  return null;
}

/**
 * The ladder the visible rows are, or null when they are not unambiguously one.
 *
 * Ranked rows lead (Rating sinks the unranked) and must be exactly positions `1..n` of one
 * pool, in order, each an explicit ranking. A series poster carrying a season average is
 * not a rung of anything, and one appearing here means the screen is not a single ladder.
 */
export function ladderOf(visible: readonly CollectionItem[], pool: RankingCategory): Ladder | null {
  const rungs: Rung[] = [];
  let ended = false;
  for (const item of visible) {
    const ranked = item.score != null && item.position != null && item.bucket != null;
    if (!ranked) {
      ended = true;
      continue;
    }
    // A ranked row after an unranked one: not a ladder.
    if (ended) return null;
    if (item.showScore?.source === 'average') return null;
    if ((item.category ?? null) !== pool) return null;
    const position = item.position as number;
    if (position !== rungs.length + 1) return null;
    rungs.push({
      mediaItemId: item.mediaItemId,
      title: item.title,
      bucket: item.bucket as Bucket,
      position,
    });
  }
  return { category: pool, rungs };
}

/** The indices `[lo, hi]` of the band the rung at `index` belongs to. */
export function bandRange(ladder: Ladder, index: number): { lo: number; hi: number } {
  const bucket = ladder.rungs[index]?.bucket;
  let lo = index;
  let hi = index;
  while (lo > 0 && ladder.rungs[lo - 1]?.bucket === bucket) lo -= 1;
  while (hi < ladder.rungs.length - 1 && ladder.rungs[hi + 1]?.bucket === bucket) hi += 1;
  return { lo, hi };
}

/**
 * What a drop from `from` to `to` asks the server to do.
 *
 *   noop     The title is back where it was. Nothing is sent, nothing is said.
 *   outside  Another band. Not applied: crossing a band is a change of rating, which goes
 *            through Rerank's comparisons, never through a drag.
 *   move     `rank_reorder(mediaItemId, toPosition, op, fromPosition, anchorId)`, where the
 *            anchor is the title on screen at the target, so a list gone stale is refused.
 */
export type PlannedMove =
  | { kind: 'noop' }
  | { kind: 'outside'; rung: Rung; direction: 'up' | 'down' }
  | {
      kind: 'move';
      category: RankingCategory;
      mediaItemId: string;
      title: string;
      bucket: Bucket;
      fromPosition: number;
      toPosition: number;
      anchorId: string;
    };

export function planMove(ladder: Ladder, from: number, to: number): PlannedMove | null {
  const rung = ladder.rungs[from];
  if (!rung) return null;
  const target = Math.max(0, Math.min(to, ladder.rungs.length - 1));
  if (target === from) return { kind: 'noop' };
  const band = bandRange(ladder, from);
  if (target < band.lo || target > band.hi) {
    return { kind: 'outside', rung, direction: target < band.lo ? 'up' : 'down' };
  }
  const anchor = ladder.rungs[target] as Rung;
  return {
    kind: 'move',
    category: ladder.category,
    mediaItemId: rung.mediaItemId,
    title: rung.title,
    bucket: rung.bucket,
    fromPosition: rung.position,
    toPosition: anchor.position,
    anchorId: anchor.mediaItemId,
  };
}

/**
 * `rankings`' own shift, applied to a cached copy of one pool: the moved title takes
 * `toPosition` and the titles between close up. Every other row is untouched, and band
 * sizes cannot change, so every score the screen derives reflows exactly as the server's
 * will. Null when the title is not in the list (the caller then has nothing to predict).
 */
export function applyMove<T extends { mediaItemId: string; position: number }>(
  entries: readonly T[],
  mediaItemId: string,
  toPosition: number,
): T[] | null {
  const subject = entries.find((entry) => entry.mediaItemId === mediaItemId);
  if (!subject) return null;
  const from = subject.position;
  if (from === toPosition) return [...entries];
  return entries.map((entry) => {
    if (entry.mediaItemId === mediaItemId) return { ...entry, position: toPosition };
    if (toPosition < from && entry.position >= toPosition && entry.position < from) {
      return { ...entry, position: entry.position + 1 };
    }
    if (toPosition > from && entry.position > from && entry.position <= toPosition) {
      return { ...entry, position: entry.position - 1 };
    }
    return entry;
  });
}

/**
 * The move that puts a just-moved title back, in the coordinates of the list it left
 * behind: from where it is now to where it was, anchored on whichever title now holds that
 * position. Undo is an ordinary guarded move, so if anything else moved in between it is
 * refused as stale instead of undoing the wrong thing.
 */
export function undoOf(
  entriesAfter: readonly RankedEntry[],
  move: Extract<PlannedMove, { kind: 'move' }>,
): Extract<PlannedMove, { kind: 'move' }> | null {
  const anchor = entriesAfter.find((entry) => entry.position === move.fromPosition);
  if (!anchor) return null;
  return {
    ...move,
    fromPosition: move.toPosition,
    toPosition: move.fromPosition,
    anchorId: anchor.mediaItemId,
  };
}

/** The score a planned move lands on, from the same projection every screen draws. */
export function scoreAfter(ladder: Ladder, move: Extract<PlannedMove, { kind: 'move' }>) {
  return scoreFor(move.bucket, move.toPosition, bandSizes(ladder.rungs));
}

/** One VoiceOver / TalkBack action on a rung: its name, its spoken label, and its target. */
export type MoveAction = { name: string; label: string; to: number };

/**
 * The accessibility moves a rung offers: one step either way, and to either end of its band.
 * Never across a band, for the reason {@link planMove} refuses one. Empty for a band of one.
 */
export function moveActions(ladder: Ladder, index: number): MoveAction[] {
  if (!ladder.rungs[index]) return [];
  const { lo, hi } = bandRange(ladder, index);
  const actions: MoveAction[] = [];
  if (index > lo) actions.push({ name: 'moveUp', label: 'Move up', to: index - 1 });
  if (index < hi) actions.push({ name: 'moveDown', label: 'Move down', to: index + 1 });
  if (index - 1 > lo) actions.push({ name: 'moveToTop', label: 'Move to top of its group', to: lo });
  if (index + 1 < hi) {
    actions.push({ name: 'moveToBottom', label: 'Move to bottom of its group', to: hi });
  }
  return actions;
}

// ---------------------------------------------------------------------------
// What the reader is told
// ---------------------------------------------------------------------------

export type RerankNoticeAction = 'undo' | 'retry' | 'sortByRating' | 'openTitle' | 'reorderTv';

export type RerankNotice = {
  message: string;
  action?: { kind: RerankNoticeAction; label: string };
  /** The title an `openTitle` action opens. */
  mediaItemId?: string;
  /** Errors stay until acted on or dismissed; confirmations fade. */
  tone: 'info' | 'error';
};

const quoted = (title: string) => `“${title}”`;

export const notices = {
  moved: (title: string, position: number, score: number): RerankNotice => ({
    message: `Moved ${quoted(title)} to #${position} · ${formatScore(score)}`,
    action: { kind: 'undo', label: 'Undo' },
    tone: 'info',
  }),
  undone: (title: string, position: number): RerankNotice => ({
    message: `Moved ${quoted(title)} back to #${position}`,
    tone: 'info',
  }),
  outside: (rung: Rung): RerankNotice => ({
    message: `${quoted(rung.title)} is in ${BUCKET_LABEL[rung.bucket]}. Drag it within that group, or use Rerank on its page to change your rating.`,
    action: { kind: 'openTitle', label: 'Open title' },
    mediaItemId: rung.mediaItemId,
    tone: 'info',
  }),
  stale: (): RerankNotice => ({
    message: 'Your ranking changed on another device. It has been refreshed, so try the move again.',
    tone: 'error',
  }),
  failed: (title: string): RerankNotice => ({
    message: `Couldn’t move ${quoted(title)}. Nothing changed on this screen.`,
    action: { kind: 'retry', label: 'Retry' },
    tone: 'error',
  }),
  blocked: (block: RerankBlock, item: { mediaItemId: string; title: string }): RerankNotice | null => {
    switch (block) {
      case 'sort':
      case 'filters':
        return {
          message: 'To reorder, sort by Rating, highest first, with no filters.',
          action: { kind: 'sortByRating', label: 'Sort by rating' },
          tone: 'info',
        };
      case 'tv-wall':
        return {
          message: 'TV shows and seasons are ranked separately. Choose one to reorder.',
          action: { kind: 'reorderTv', label: 'Reorder' },
          tone: 'info',
        };
      case 'unranked':
        return {
          message: `Rank ${quoted(item.title)} first to place it in your list.`,
          action: { kind: 'openTitle', label: 'Open title' },
          mediaItemId: item.mediaItemId,
          tone: 'info',
        };
      case 'ambiguous':
        return {
          message: 'This list is still updating. Try again in a moment.',
          tone: 'info',
        };
      case 'segment':
      default:
        return null;
    }
  },
};
