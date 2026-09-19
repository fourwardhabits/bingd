/**
 * The two evaluation modes, as a list of prediction tasks.
 *
 * ---------------------------------------------------------------------------
 * P1: TEMPORAL REPLAY. Useful, and NOISY at the moment.
 *
 * Walk each list in `rankings.created_at` order and predict every title from what existed
 * before it. The label is exact **if** `created_at` is the time of the title's one placement
 * and the order of earlier titles never changed afterwards. Today neither holds reliably:
 *
 *   - every correction resets `created_at` (until T0, open PR #118);
 *   - a manual `rank_reorder` moves a title and leaves no record;
 *   - Undo leaves the answered comparison in `comparisons`, so evidence counts overstate.
 *
 * The first can be detected, and is: comparisons involving a title long before its
 * `created_at` mean it was in the list earlier. The second cannot be detected. The third
 * inflates the placement-evidence segment. All three are flagged or stated in the report,
 * and P1 cannot gate a verdict (`P1_CAN_GATE`).
 *
 * P2: CURRENT-LIBRARY HOLDOUT. The model-comparison signal at current maturity.
 *
 * Hold out a bucket-stratified fifth of each current list and predict it from the rest. This
 * leaks the future: other people's later rankings, and the reader's own later taste, are all
 * visible. It is not a deployment simulation. But the current order *is* the reader's
 * current opinion, so the labels are reliable, which today P1's are not.
 * ---------------------------------------------------------------------------
 */

import { HOLDOUT_FOLDS, MIN_LIBRARY_FOR_HOLDOUT, SEEDS } from './config';
import { insertionTruth, libraryView, type LibraryView, type Truth } from './geometry';
import { unitHash } from './random';
import type { Category, Dataset, SnapshotRanking } from './snapshot';

export type Mode = 'P1' | 'P2';

export type LabelFlags = {
  /** Comparisons long before `created_at`: the title was re-placed, so `created_at` was reset. */
  replacedHint: boolean;
  /**
   * A later-dated, re-placed title in this list was already being compared before this label's
   * moment, so it was in the list then and the replay left it out.
   */
  asOfMayMissRows: boolean;
  /** Placed into a non-empty band with no comparison recorded: Too tough, a dry walk, or a reset. */
  noPlacementEvidence: boolean;
  /** Placed into an empty band, where no comparison is needed. */
  firstInBand: boolean;
};

export type Task = {
  mode: Mode;
  u: string;
  c: Category;
  target: SnapshotRanking;
  /** The reader's own list in this category, minus everything held out or not yet placed. */
  train: LibraryView;
  /** The reader's rankings in the other category that are visible here (Taste Match spans both). */
  otherCategory: readonly SnapshotRanking[];
  /** Other people's rankings count only if created strictly before this (P1). Null: no limit. */
  asOf: number | null;
  /** The reader's titles hidden from every aggregate: the held-out fold, or the future. */
  hidden: ReadonlySet<string>;
  /** Tasks sharing a group share the reader's side of every computation. */
  group: string;
  fold: number;
  truth: Truth;
  flags: LabelFlags;
};

const OTHER: Record<Category, Category> = { movies: 'tv_seasons', tv_seasons: 'movies' };

const libraryOf = (ds: Dataset, u: string, c: Category) => ds.library.get(`${u}|${c}`) ?? [];

const NO_FLAGS = (truth: Truth, target: SnapshotRanking): LabelFlags => ({
  replacedHint: false,
  asOfMayMissRows: false,
  noPlacementEvidence: truth.bandSize > 0 && target.cmp_window === 0,
  firstInBand: truth.bandSize === 0,
});

/** P2: bucket-stratified folds over each current list, seeded, every title predicted once. */
export function holdoutTasks(
  ds: Dataset,
  categories: readonly Category[] = ['movies', 'tv_seasons'],
): Task[] {
  const tasks: Task[] = [];
  for (const u of [...ds.users.keys()].sort()) {
    for (const c of categories) {
      const rows = libraryOf(ds, u, c);
      if (rows.length < MIN_LIBRARY_FOR_HOLDOUT) continue;

      const fold = new Map<string, number>();
      let j = 0;
      for (const bucket of ['loved', 'fine', 'not_for_me'] as const) {
        const band = rows
          .filter((r) => r.b === bucket)
          .sort(
            (a, b) =>
              unitHash(`${SEEDS.holdout}|${u}|${c}|${a.m}`) -
              unitHash(`${SEEDS.holdout}|${u}|${c}|${b.m}`),
          );
        for (const r of band) fold.set(r.m, j++ % HOLDOUT_FOLDS);
      }

      const other = libraryOf(ds, u, OTHER[c]);
      for (let f = 0; f < HOLDOUT_FOLDS; f += 1) {
        const held = rows.filter((r) => fold.get(r.m) === f);
        if (held.length === 0) continue;
        const hidden = new Set(held.map((r) => r.m));
        const train = libraryView(rows.filter((r) => !hidden.has(r.m)));
        for (const target of held) {
          const truth = insertionTruth(target, train);
          tasks.push({
            mode: 'P2',
            u,
            c,
            target,
            train,
            otherCategory: other,
            asOf: null,
            hidden,
            group: `${u}|${c}|f${f}`,
            fold: f,
            truth,
            flags: NO_FLAGS(truth, target),
          });
        }
      }
    }
  }
  return tasks;
}

/**
 * The order titles entered a list, as `created_at` records it.
 *
 * Ties are broken by key only so that the replay is deterministic. A tie is two placements
 * in one transaction, which a single ranking insert never produces.
 */
export const entryOrder = (rows: readonly SnapshotRanking[]): SnapshotRanking[] =>
  [...rows].sort((a, b) => a.t - b.t || (a.m < b.m ? -1 : a.m > b.m ? 1 : 0));

/**
 * P1: every title predicted from the list as it stood just before its own `created_at`.
 *
 * The reader's earlier titles keep their current relative order, which is the order they had
 * then unless a reorder or a re-placement intervened (see the header). Other people's
 * evidence is cut at the same moment by `asOf`.
 */
export function replayTasks(
  ds: Dataset,
  categories: readonly Category[] = ['movies', 'tv_seasons'],
): Task[] {
  const tasks: Task[] = [];
  for (const u of [...ds.users.keys()].sort()) {
    for (const c of categories) {
      const ordered = entryOrder(libraryOf(ds, u, c));
      const other = libraryOf(ds, u, OTHER[c]);
      for (let k = 1; k < ordered.length; k += 1) {
        const target = ordered[k]!;
        const prior = ordered.slice(0, k);
        const later = ordered.slice(k + 1);
        const train = libraryView(prior);
        const truth = insertionTruth(target, train);
        tasks.push({
          mode: 'P1',
          u,
          c,
          target,
          train,
          otherCategory: other.filter((r) => r.t < target.t),
          asOf: target.t,
          hidden: new Set([target.m, ...later.map((r) => r.m)]),
          group: `${u}|${c}|k${k}`,
          fold: -1,
          truth,
          flags: {
            ...NO_FLAGS(truth, target),
            replacedHint: target.cmp_earlier > 0,
            // Without a first-comparison time, any later re-placed title might have been
            // there, so the flag errs toward suspicion rather than toward a clean label.
            asOfMayMissRows: later.some(
              (r) => r.cmp_earlier > 0 && (r.cmp_first === null || r.cmp_first < target.t),
            ),
          },
        });
      }
    }
  }
  return tasks;
}
