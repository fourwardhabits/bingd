/**
 * One sort contract, for every list in the app that offers one.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (founder, 2026-08-30)
 *
 * The Collection's sort chip said **Recently watched** over a list that was plainly in
 * rating order. It was not a rendering bug: the control, the label, the comparator and
 * the rows had each been right on their own and wrong together, which is the failure a
 * shared contract prevents and a per-surface convention does not. See
 * `features/collection/filters.ts` for the data half of that story.
 *
 * Two surfaces offer a sort — the Collection tab and the profile's See-all sheet — and
 * before this they disagreed about what a sort control *is*. The Collection listed
 * `Your score: high` and `Your score: low` as two separate entries; the sheet listed
 * `Highest first`, `Lowest first`, `Newest first`, `Oldest first` as four. Both spend
 * menu rows on directions, both let a label drift away from the order it names, and
 * neither can grow a third axis without doubling.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT
 *
 *   1. **A label names its axis and nothing else.** Rating. Rank. Recently added.
 *      Recently ranked. Release year. Title. Never a direction, never a metric the
 *      surface does not actually order by.
 *   2. **Choosing a new axis starts in that axis's intuitive direction** — best first,
 *      newest first, A–Z. Nobody picks "Rating" hoping to see their worst film.
 *   3. **Choosing the axis already in use flips its direction.** One row per axis, two
 *      states behind it.
 *   4. **The label does not change when the direction does.** The arrow changes.
 *   5. **The arrow means the ordering of the underlying value**: down is descending
 *      (10 → 1, newest → oldest, Z → A), up is ascending. It is a two-state indicator,
 *      not a sentence, so every control also carries a spoken label that says the
 *      direction in words — `Sort. Rating, highest first`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 *
 * The comparators. An axis means something different over a `CollectionItem` than over
 * a ranked row, and a shared comparator would have to know both shapes. What is shared
 * is the *state machine* and the *vocabulary*: which axes exist, which is on, which way
 * it points, and what the control says about it. Each surface supplies its own ordering
 * for the axes it declares, and `sort.test.ts` pins the machine.
 */

/** Descending is high→low, new→old, Z→A. Ascending is the reverse, in every axis. */
export type SortDirection = 'desc' | 'asc';

/** Which axis is on, and which way it points. `direction` is ignored by an unordered axis. */
export type SortState<Axis extends string> = {
  axis: Axis;
  direction: SortDirection;
};

/**
 * One axis a surface offers.
 *
 * `directions` is absent for an axis that has no order to reverse — Shuffle is the only
 * one, and pressing it again reshuffles rather than inverting anything. Rule 3 does not
 * apply to it, which is why the absence of the words is what encodes the absence of the
 * behaviour rather than a second boolean that could disagree with them.
 */
export type SortAxisSpec<Axis extends string> = {
  axis: Axis;
  /** The whole label. Names the axis; never mentions a direction. */
  label: string;
  /** How each direction reads aloud, and `defaultDirection` picks the one a fresh choice starts in. */
  directions?: { desc: string; asc: string };
  /** Where rule 2 lands. Required when `directions` is present. */
  defaultDirection?: SortDirection;
};

/** Whether this axis has two states to move between. */
export const isDirectional = <Axis extends string>(spec: SortAxisSpec<Axis>): boolean =>
  spec.directions !== undefined;

/**
 * Rules 2 and 3, and they are the whole state machine.
 *
 * Pressing the axis already in use flips it; pressing any other axis moves to that
 * axis's own default direction. An axis with no directions is answered with `desc`,
 * which no comparator of an unordered axis reads.
 */
export function nextSortState<Axis extends string>(
  current: SortState<Axis>,
  pressed: Axis,
  specs: readonly SortAxisSpec<Axis>[],
): SortState<Axis> {
  const spec = specs.find((option) => option.axis === pressed);
  if (!spec) return current;

  if (!isDirectional(spec)) return { axis: pressed, direction: 'desc' };

  if (pressed === current.axis) {
    return { axis: pressed, direction: current.direction === 'desc' ? 'asc' : 'desc' };
  }
  return { axis: pressed, direction: spec.defaultDirection ?? 'desc' };
}

/**
 * The state a surface falls back to when the one it holds names an axis it cannot offer.
 *
 * The Collection carries one sort across Watched, Watchlist and Unranked, and only
 * Watched has ratings — so a reader who sorted by Rating and switched to their watchlist
 * is holding an axis with no column behind it. Falling back to the first offered axis in
 * *its* default direction keeps rule 1 true at the only moment it is easy to break: the
 * label and the order have to agree even when the axis was chosen somewhere else.
 */
export function coerceSortState<Axis extends string>(
  state: SortState<Axis>,
  specs: readonly SortAxisSpec<Axis>[],
): SortState<Axis> {
  const spec = specs.find((option) => option.axis === state.axis);
  if (spec) return state;
  const first = specs[0];
  if (!first) return state;
  return { axis: first.axis, direction: first.defaultDirection ?? 'desc' };
}

/** Rule 5's glyph. Named `-outline` to sit with the rest of the chip row. */
export const sortDirectionIcon = (direction: SortDirection): 'arrow-down-outline' | 'arrow-up-outline' =>
  direction === 'desc' ? 'arrow-down-outline' : 'arrow-up-outline';

/**
 * What a screen reader hears, and what the founder's retest reads off the chip.
 *
 * `Sort. Rating, highest first`. The axis, then the direction in words — because the
 * arrow is an indicator and a person who cannot see it is owed the sentence.
 */
export function spokenSortLabel<Axis extends string>(
  state: SortState<Axis>,
  specs: readonly SortAxisSpec<Axis>[],
): string {
  const spec = specs.find((option) => option.axis === state.axis);
  if (!spec) return 'Sort';
  if (!spec.directions) return `Sort. ${spec.label}`;
  return `Sort. ${spec.label}, ${spec.directions[state.direction]}`;
}

/** The words for one option's current direction, for the row inside an open menu. */
export function directionWords<Axis extends string>(
  spec: SortAxisSpec<Axis>,
  direction: SortDirection,
): string | null {
  return spec.directions ? spec.directions[direction] : null;
}
