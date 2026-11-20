import { compareItems, type CollectionItem, type CollectionSortState } from './filters';
import { planMove, type Ladder, type MoveAction, type PlannedMove, type Rung } from './rerank';
import { bandSizes, bucketForScore, scoreFor, type Bucket } from './score';

/**
 * **The TV wall, dragged directly** (#319, founder QA 2026-11-20,
 * `docs/architecture/collection-rerank.md` "TV, dragged on the wall").
 *
 * The wall is one poster per series. A poster is scored either by the reader's explicit
 * `tv_shows` ranking, or by the mean of their ranked seasons (`SN AVG`). Only the first
 * kind is a place in a ranking. So a drop is read against the explicit shows on either side
 * of where it lands, and the average posters in between are passed over:
 *
 *   an explicit show   moves among the explicit shows (`rank_reorder` in tv_shows), to
 *                      just below the last explicit show above the drop;
 *   an average poster  is promoted (`rank_promote_show`): it becomes an explicit show at
 *                      that same place, with the score that place has.
 *
 * The category is the one the drop lands among (the displaced poster's, an average poster's
 * read from its score), clamped to fit between the explicit neighbours, so the server never
 * has to refuse it. A season ranking is never read for a place, and never written.
 *
 * **The visual-order limitation.** After the move the wall is re-sorted by score as always.
 * Explicit shows keep the order the reader made. An average poster stays where its average
 * puts it, so a promoted or moved show can sort a few posters away from the exact cell it
 * was dropped on, among the averages, but never past an explicit show. A drag of an explicit
 * show across average posters only, with no explicit show passed, changes nothing and
 * springs back with a notice.
 */

/** A ranked poster on the wall, in display order. */
export type WallPoster = {
  mediaItemId: string;
  title: string;
  /** The reader's own show ranking, rather than an average of seasons. */
  explicit: boolean;
  /** The explicit show's category, or the category an average's score falls in. */
  bucket: Bucket;
  /** `tv_shows` position, for an explicit show. */
  position: number | null;
};

export type TvWall = {
  posters: WallPoster[];
  /** The explicit shows alone, as the `tv_shows` ladder (positions 1..m). */
  shows: Ladder;
};

/**
 * The wall the visible rows are, or null when they are not unambiguously one: ranked series
 * posters leading, each carrying `showScore`, and the explicit ones being positions `1..m`
 * of `tv_shows` in display order.
 */
export function tvWallOf(visible: readonly CollectionItem[]): TvWall | null {
  const posters: WallPoster[] = [];
  const rungs: Rung[] = [];
  let ended = false;
  for (const item of visible) {
    const ranked = item.score != null && item.showScore != null;
    if (!ranked) {
      ended = true;
      continue;
    }
    if (ended) return null;
    const showScore = item.showScore!;
    if (showScore.source === 'explicit') {
      if (item.bucket == null || item.position == null) return null;
      if (item.position !== rungs.length + 1) return null;
      rungs.push({
        mediaItemId: item.mediaItemId,
        title: item.title,
        bucket: item.bucket,
        position: item.position,
      });
      posters.push({
        mediaItemId: item.mediaItemId,
        title: item.title,
        explicit: true,
        bucket: item.bucket,
        position: item.position,
      });
    } else {
      posters.push({
        mediaItemId: item.mediaItemId,
        title: item.title,
        explicit: false,
        bucket: bucketForScore(showScore.sumTenths / (10 * showScore.n)),
        position: null,
      });
    }
  }
  return { posters, shows: { category: 'tv_shows', rungs } };
}

/** An average poster made an explicit show at `toPosition` in `toBucket`. */
export type PlannedPromotion = {
  kind: 'promote';
  category: 'tv_shows';
  mediaItemId: string;
  title: string;
  toBucket: Bucket;
  toPosition: number;
  /** The explicit show at `toPosition` now, or null past the last one. */
  anchorId: string | null;
};

/** A drag of an explicit show that passes only average posters: nothing to move. */
export type PlannedPassOver = { kind: 'passover'; title: string };

export type TvPlan = PlannedMove | PlannedPromotion | PlannedPassOver;

const ORDER: readonly Bucket[] = ['loved', 'fine', 'not_for_me'];
const rank = (bucket: Bucket) => ORDER.indexOf(bucket);

/**
 * What a drop from wall index `from` to wall index `to` asks for. `toBucket` is given by an
 * accessibility action; a drag lands among the displaced poster's category. Null when the
 * indices name nothing.
 */
export function planTvMove(
  wall: TvWall,
  from: number,
  to: number,
  toBucket?: Bucket,
): TvPlan | null {
  const subject = wall.posters[from];
  if (!subject) return null;
  const target = Math.max(0, Math.min(to, wall.posters.length - 1));
  if (target === from && !toBucket) return { kind: 'noop' };

  // Where it lands among the others: `target` is its index in the final order.
  const rest = wall.posters.filter((_, i) => i !== from);
  const above = rest.slice(0, target).filter((p) => p.explicit);
  const below = rest.slice(target).filter((p) => p.explicit);

  // The category it lands among, clamped between the explicit shows either side.
  let landing = toBucket ?? (target === from ? subject.bucket : wall.posters[target]!.bucket);
  const floor = above.length ? rank(above[above.length - 1]!.bucket) : 0;
  const ceiling = below.length ? rank(below[0]!.bucket) : ORDER.length - 1;
  if (rank(landing) < floor) landing = ORDER[floor]!;
  if (rank(landing) > ceiling) landing = ORDER[ceiling]!;

  if (!subject.explicit) {
    return {
      kind: 'promote',
      category: 'tv_shows',
      mediaItemId: subject.mediaItemId,
      title: subject.title,
      toBucket: landing,
      toPosition: above.length + 1,
      anchorId: below[0]?.mediaItemId ?? null,
    };
  }

  const fromIndex = wall.shows.rungs.findIndex((r) => r.mediaItemId === subject.mediaItemId);
  if (fromIndex < 0) return null;
  const planned = planMove(wall.shows, fromIndex, above.length, landing);
  if (planned?.kind === 'noop') return { kind: 'passover', title: subject.title };
  return planned;
}

/**
 * The moves a screen reader is offered on a wall poster, the same places a drag reaches.
 *
 * An explicit show: one explicit show up or down (the averages a drag would pass over are
 * skipped, since passing them changes nothing). An average poster: rank it as a show where it
 * is drawn, or one explicit show above or below that.
 */
export function tvMoveActions(wall: TvWall, index: number): MoveAction[] {
  const subject = wall.posters[index];
  if (!subject) return [];
  const key = (plan: TvPlan | null) =>
    plan?.kind === 'promote' || plan?.kind === 'move'
      ? `${plan.toPosition}:${plan.toBucket}`
      : null;
  const here = subject.explicit ? null : planTvMove(wall, index, index, subject.bucket);
  const actions: MoveAction[] = [];
  if (here)
    actions.push({
      name: 'rankHere',
      label: 'Rank as a show here',
      to: index,
      toBucket: subject.bucket,
    });
  const seen = new Set([key(here)]);
  const step = (dir: -1 | 1) => {
    for (let to = index + dir; to >= 0 && to < wall.posters.length; to += dir) {
      const k = key(planTvMove(wall, index, to));
      if (k && !seen.has(k)) {
        seen.add(k);
        return to;
      }
    }
    return null;
  };
  const verb = subject.explicit ? 'Move' : 'Rank as a show,';
  const up = step(-1);
  if (up !== null)
    actions.push({
      name: 'moveUp',
      label: `${verb} ${subject.explicit ? 'up' : 'higher'}`,
      to: up,
    });
  const down = step(1);
  if (down !== null)
    actions.push({
      name: 'moveDown',
      label: `${verb} ${subject.explicit ? 'down' : 'lower'}`,
      to: down,
    });
  return actions;
}

/**
 * The wall index a planned move or promotion will be drawn at once it lands, read with the
 * wall's own Rating comparator over the posters as they will be scored: every explicit show
 * re-scored from the new band sizes, the subject explicit at its new place, the averages as
 * they are. The drop's copy glides there, so it becomes the cell in place.
 */
export function landingIndex(
  visible: readonly CollectionItem[],
  wall: TvWall,
  plan: Extract<TvPlan, { kind: 'move' | 'promote' }>,
  order: CollectionSortState,
): number {
  const rungs = wall.shows.rungs.map((r) => ({ ...r }));
  let next: { mediaItemId: string; position: number; bucket: Bucket }[];
  if (plan.kind === 'promote') {
    next = rungs.map((r) =>
      r.position >= plan.toPosition ? { ...r, position: r.position + 1 } : r,
    );
    next.push({
      mediaItemId: plan.mediaItemId,
      position: plan.toPosition,
      bucket: plan.toBucket,
    });
  } else {
    next = rungs.map((r) => {
      if (r.mediaItemId === plan.mediaItemId)
        return { ...r, position: plan.toPosition, bucket: plan.toBucket };
      if (
        plan.toPosition < plan.fromPosition &&
        r.position >= plan.toPosition &&
        r.position < plan.fromPosition
      )
        return { ...r, position: r.position + 1 };
      if (
        plan.toPosition > plan.fromPosition &&
        r.position > plan.fromPosition &&
        r.position <= plan.toPosition
      )
        return { ...r, position: r.position - 1 };
      return r;
    });
  }
  const sizes = bandSizes(next);
  const byId = new Map(next.map((r) => [r.mediaItemId, r]));
  const ranked = visible.slice(0, wall.posters.length).map((item) => {
    const r = byId.get(item.mediaItemId);
    if (!r) return item;
    const score = scoreFor(r.bucket, r.position, sizes);
    return {
      ...item,
      score,
      position: r.position,
      bucket: r.bucket,
      showScore: {
        sumTenths: Math.round(score * 10),
        n: 1,
        source: 'explicit' as const,
        rankedSeasonCount: item.showScore?.rankedSeasonCount ?? 0,
      },
    };
  });
  const sorted = [...ranked].sort(compareItems(order));
  return sorted.findIndex((item) => item.mediaItemId === plan.mediaItemId);
}
