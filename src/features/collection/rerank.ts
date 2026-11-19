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
 *   sort      Any order but Rating, highest first. A display index is not a position.
 *   filters   Any filter. The positions on screen are not contiguous.
 *   unranked  The title has no position to move.
 *   ambiguous The rows do not read as positions 1..n of one pool. Never expected; a guard.
 */
export type RerankBlock = 'segment' | 'sort' | 'filters' | 'unranked' | 'ambiguous';

/**
 * Whether the screen as configured can be a ranking at all. The Movies wall and a TV pool
 * editor are one ladder; the TV wall is dragged through `tv-wall.ts` (#319, founder QA
 * 2026-11-20: the "ranked separately" refusal is gone). Either way, only the Rating order
 * with no filter is a ranking on screen.
 */
export function screenBlock({
  segment,
  sort,
  filters,
}: {
  segment: CollectionSegment;
  sort: CollectionSortState;
  filters: CollectionFilters;
}): RerankBlock | null {
  if (segment !== 'watched') return 'segment';
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

/** The three categories, best first: the order their runs take in every ranking. */
const BUCKET_ORDER: readonly Bucket[] = ['loved', 'fine', 'not_for_me'];
const rankOf = (bucket: Bucket) => BUCKET_ORDER.indexOf(bucket);

/**
 * What a drop from `from` to `to` asks the server to do.
 *
 *   noop  The title is back where it was, in the category it was in. Nothing is sent.
 *   move  `rank_reorder(mediaItemId, toPosition, op, fromPosition, anchorId, toBucket)`.
 *         The anchor is the title on screen at the target, so a list gone stale is refused.
 *         `bucket` is where the title is now and `toBucket` where it lands: they differ for
 *         a drop among another category's titles (founder, 2026-11-19), which recategorises
 *         it and rescores it from its new place.
 */
export type PlannedMove =
  | { kind: 'noop' }
  | {
      kind: 'move';
      category: RankingCategory;
      mediaItemId: string;
      title: string;
      bucket: Bucket;
      toBucket: Bucket;
      fromPosition: number;
      toPosition: number;
      anchorId: string;
    };

/**
 * **The category a drop lands in** (founder decision, 2026-11-19, replacing v1's same-group
 * rule). A dropped title takes the place of the title it displaces and joins that title's
 * category: drag *Heat* onto the third It was fine title and it is It was fine, third.
 *
 * One rule, with no geometry. It means a drag inside one category is exactly the move it
 * always was, and that the first place of the next category down is reached from above by
 * dropping onto its second title and then nudging, or with the accessibility action. That
 * place, the line between two categories, is the one spot two categories share.
 */
export function landingBucket(ladder: Ladder, from: number, to: number): Bucket | null {
  const rung = ladder.rungs[from];
  if (!rung) return null;
  const target = Math.max(0, Math.min(to, ladder.rungs.length - 1));
  return target === from ? rung.bucket : (ladder.rungs[target]?.bucket ?? null);
}

/**
 * Whether `toBucket` at index `target` is a place the server accepts: once the title has left
 * its own place, every title above the landing is in an equal or better category and every
 * title below in an equal or worse one. That is `rank_reorder`'s 22023 check, said here so
 * the client never sends a move the server must refuse.
 */
function fits(ladder: Ladder, from: number, target: number, toBucket: Bucket): boolean {
  const rest = ladder.rungs.filter((_, i) => i !== from);
  const above = rest.slice(0, target);
  const below = rest.slice(target);
  const r = rankOf(toBucket);
  return above.every((x) => rankOf(x.bucket) <= r) && below.every((x) => rankOf(x.bucket) >= r);
}

/**
 * `toBucket` is the drag's landing category when absent ({@link landingBucket}). The
 * accessibility actions pass it, because "Move down" from the bottom of a category is the
 * line between two categories, where the category is a choice and not a consequence.
 */
export function planMove(
  ladder: Ladder,
  from: number,
  to: number,
  toBucket?: Bucket,
): PlannedMove | null {
  const rung = ladder.rungs[from];
  if (!rung) return null;
  const target = Math.max(0, Math.min(to, ladder.rungs.length - 1));
  const landing = toBucket ?? landingBucket(ladder, from, target);
  if (!landing) return null;
  if (target === from && landing === rung.bucket) return { kind: 'noop' };
  if (!fits(ladder, from, target, landing)) return null;
  const anchor = ladder.rungs[target] as Rung;
  return {
    kind: 'move',
    category: ladder.category,
    mediaItemId: rung.mediaItemId,
    title: rung.title,
    bucket: rung.bucket,
    toBucket: landing,
    fromPosition: rung.position,
    toPosition: anchor.position,
    anchorId: anchor.mediaItemId,
  };
}

/**
 * `rankings`' own shift, applied to a cached copy of one pool: the moved title takes
 * `toPosition` (and `toBucket`, across a category) and the titles between close up. Every
 * other row keeps its category. Band sizes are recounted by whoever scores the list, so
 * every score the screen derives reflows exactly as the server's will. Null when the title
 * is not in the list (the caller then has nothing to predict).
 */
export function applyMove<T extends { mediaItemId: string; position: number; bucket?: Bucket }>(
  entries: readonly T[],
  mediaItemId: string,
  toPosition: number,
  toBucket?: Bucket,
): T[] | null {
  const subject = entries.find((entry) => entry.mediaItemId === mediaItemId);
  if (!subject) return null;
  const from = subject.position;
  const moved = (entry: T): T =>
    toBucket ? { ...entry, position: toPosition, bucket: toBucket } : { ...entry, position: toPosition };
  if (from === toPosition) {
    return entries.map((entry) => (entry.mediaItemId === mediaItemId ? moved(entry) : entry));
  }
  return entries.map((entry) => {
    if (entry.mediaItemId === mediaItemId) return moved(entry);
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
 * behind: from where it is now to where it was, in the category it was in, anchored on
 * whichever title now holds that position. The category is named explicitly rather than
 * read from the anchor: the title now at the old place may be from the next category.
 * Undo is an ordinary guarded move, so if anything else moved in between it is refused as
 * stale instead of undoing the wrong thing.
 */
export function undoOf(
  entriesAfter: readonly RankedEntry[],
  move: Extract<PlannedMove, { kind: 'move' }>,
): Extract<PlannedMove, { kind: 'move' }> | null {
  const anchor = entriesAfter.find((entry) => entry.position === move.fromPosition);
  if (!anchor) return null;
  return {
    ...move,
    bucket: move.toBucket,
    toBucket: move.bucket,
    fromPosition: move.toPosition,
    toPosition: move.fromPosition,
    anchorId: anchor.mediaItemId,
  };
}

/** Whether a planned move changes the title's rating category. */
export const crosses = (move: Extract<PlannedMove, { kind: 'move' }>) =>
  move.toBucket !== move.bucket;

/** The score a planned move lands on, from the same projection every screen draws. */
export function scoreAfter(ladder: Ladder, move: Extract<PlannedMove, { kind: 'move' }>) {
  const after =
    applyMove(
      ladder.rungs.map((rung) => ({ ...rung })),
      move.mediaItemId,
      move.toPosition,
      move.toBucket,
    ) ?? ladder.rungs;
  return scoreFor(move.toBucket, move.toPosition, bandSizes(after));
}

/**
 * One VoiceOver / TalkBack action on a rung: its name, its spoken label, its target index,
 * and the category it lands in when that is not the drag's landing rule.
 */
export type MoveAction = { name: string; label: string; to: number; toBucket?: Bucket };

/**
 * The accessibility moves a rung offers: one step either way, and to either end of its group.
 *
 * At a group's edge, one step is the line into the neighbouring category (founder,
 * 2026-11-19): "Move up into I liked it" from the top of It was fine makes it the last I liked
 * it title without moving it, and the next step moves it among them. So every place a drag
 * can reach, a screen reader can reach one step at a time.
 */
export function moveActions(ladder: Ladder, index: number): MoveAction[] {
  const rung = ladder.rungs[index];
  if (!rung) return [];
  const { lo, hi } = bandRange(ladder, index);
  const actions: MoveAction[] = [];
  const prev = BUCKET_ORDER[rankOf(rung.bucket) - 1];
  const next = BUCKET_ORDER[rankOf(rung.bucket) + 1];
  if (index > lo) {
    actions.push({ name: 'moveUp', label: 'Move up', to: index - 1, toBucket: rung.bucket });
  } else if (prev) {
    actions.push({
      name: 'moveUp',
      label: `Move up into ${BUCKET_LABEL[prev]}`,
      to: index,
      toBucket: prev,
    });
  }
  if (index < hi) {
    actions.push({ name: 'moveDown', label: 'Move down', to: index + 1, toBucket: rung.bucket });
  } else if (next) {
    actions.push({
      name: 'moveDown',
      label: `Move down into ${BUCKET_LABEL[next]}`,
      to: index,
      toBucket: next,
    });
  }
  if (index - 1 > lo) {
    actions.push({ name: 'moveToTop', label: 'Move to top of its group', to: lo, toBucket: rung.bucket });
  }
  if (index + 1 < hi) {
    actions.push({
      name: 'moveToBottom',
      label: 'Move to bottom of its group',
      to: hi,
      toBucket: rung.bucket,
    });
  }
  return actions;
}

// ---------------------------------------------------------------------------
// What the reader is told
// ---------------------------------------------------------------------------

export type RerankNoticeAction = 'undo' | 'retry' | 'sortByRating' | 'openTitle';

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
  /** `into` is the new category, named only when the move changed it. */
  moved: (title: string, position: number, score: number, into?: Bucket): RerankNotice => ({
    message: into
      ? `Moved ${quoted(title)} to ${BUCKET_LABEL[into]} · #${position} · ${formatScore(score)}`
      : `Moved ${quoted(title)} to #${position} · ${formatScore(score)}`,
    action: { kind: 'undo', label: 'Undo' },
    tone: 'info',
  }),
  undone: (title: string, position: number, into?: Bucket): RerankNotice => ({
    message: into
      ? `Moved ${quoted(title)} back to ${BUCKET_LABEL[into]} · #${position}`
      : `Moved ${quoted(title)} back to #${position}`,
    tone: 'info',
  }),
  /**
   * The server refused the place (22023). The client checks the same rule before sending,
   * so this means the list it checked against had changed: it has been refreshed.
   */
  outside: (title: string): RerankNotice => ({
    message: `Couldn’t place ${quoted(title)} there. Your list has been refreshed, so try the move again.`,
    tone: 'error',
  }),
  /** An SN AVG show placed from the TV wall (#319): it is a ranked show now. */
  promoted: (title: string, position: number, score: number): RerankNotice => ({
    message: `Ranked ${quoted(title)} as a show · #${position} · ${formatScore(score)}`,
    action: { kind: 'undo', label: 'Undo' },
    tone: 'info',
  }),
  unpromoted: (title: string): RerankNotice => ({
    message: `${quoted(title)} is back to its seasons’ average`,
    tone: 'info',
  }),
  /**
   * A ranked show dragged past average posters only. Its place among the shows the reader
   * ranked did not change, and the averages are placed by their seasons.
   */
  passover: (title: string): RerankNotice => ({
    message: `${quoted(title)} is still between the same ranked shows. Shows scored by their seasons’ average move with their seasons.`,
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
