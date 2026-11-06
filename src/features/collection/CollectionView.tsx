import { Ionicons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { posterUri } from '@/lib/images';
import { compactName } from '@/lib/titles';
import {
  EmptyState,
  IconToggle,
  type IconToggleOption,
  PosterGridList,
  Text,
  TitleMetadata,
  TitleRow,
} from '@/ui/components';
import { coerceSortState, isDirectional, type SortAxisSpec } from '@/ui/sort';
import { theme } from '@/ui/tokens';

import { CollectionFilterSheet } from './CollectionFilterSheet';
import { TitleRowActions } from './TitleRowActions';
import {
  activeFilterCount,
  applyFilters,
  COLLECTION_SORT_AXES,
  emptyFilters,
  isFiltered,
  sortAxesFor,
  sortItems,
  type CollectionFilters,
  type CollectionItem,
  type CollectionSegment,
  type CollectionSortState,
} from './filters';

/**
 * Poster or list.
 *
 * **Named `poster` and not `wall`**, which it was until the 2026-08-28 tranche. The
 * value had never left the process, so the internal name and the label on the control
 * were free to disagree; that tranche persists the choice, and a stored string reading
 * `wall` under a control labelled Poster is a disagreement that outlives every rename
 * anybody would think to make. The word the founder uses is Poster, so this is Poster.
 */
export type CollectionViewMode = 'list' | 'poster';

export type CollectionViewState = {
  filters: CollectionFilters;
  /**
   * The axis and the direction, as one value.
   *
   * It was a flat `SortKey` — `'score-desc'`, `'recent'` — which could name a direction
   * for one axis and none for another, and which the chip then had to translate back
   * into a label. See `filters.ts` for what that cost.
   */
  sort: CollectionSortState;
  mode: CollectionViewMode;
  /** Bumped by Shuffle. Nothing else changes the order. */
  seed: number;
};

/**
 * A fresh collection, before any stored preference has arrived.
 *
 * **Poster, which is the founder's aesthetic default** (§11). It was List, and the
 * reasoning for the change is that a collection is a wall of artwork before it is a
 * table of scores — the first thing a person should see of what they have watched is
 * what it looked like.
 *
 * This is the *unset* default rather than the startup mode. `CollectionScreen` reads a
 * stored choice over the top of it, so a reader who has chosen List gets List on every
 * launch; this value is what a device with nothing stored opens on, and what a stored
 * value that fails to parse falls back to.
 */
export const initialViewState = (): CollectionViewState => ({
  filters: emptyFilters(),
  // Rating, highest first — the same order the collection has always opened on, said
  // in the vocabulary the control now uses.
  sort: { axis: COLLECTION_SORT_AXES.rating.axis, direction: 'desc' },
  mode: 'poster',
  seed: 1,
});

/** Whether an unknown value from the preference store is a mode this component can draw. */
export const isCollectionViewMode = (value: unknown): value is CollectionViewMode =>
  value === 'list' || value === 'poster';

/**
 * Poster first, list second — the founder's ordering (§11).
 *
 * The leftmost cell is the one a device with no stored preference opens on, so the
 * control reads as its own default without the reader having to discover that it does.
 * Reversed from the original, which drew List first and then had to default to Poster.
 */
const VIEW_MODES = [
  { value: 'poster', icon: 'grid', label: 'Poster view' },
  { value: 'list', icon: 'list', label: 'List view' },
] as const satisfies readonly IconToggleOption<CollectionViewMode>[];

export type CollectionViewProps = {
  items: readonly CollectionItem[];
  segment: CollectionSegment;
  state: CollectionViewState;
  onChange: (next: CollectionViewState) => void;
  onPressItem: (mediaItemId: string) => void;
  /** Shown when the collection itself is empty, before any filtering. */
  empty: React.ReactNode;
  /**
   * Drawn at the right of the count row: Collection's `My lists ›` (UI cohesion pass,
   * 2026-11-06). Also drawn above an empty collection, where there is no count row, so the
   * way to the lists never depends on there being titles.
   */
  countAccessory?: ReactNode;
};

/**
 * One collection, two views.
 *
 * List and Poster are not separate screens and not separate tabs — the brief is
 * explicit that Poster is a *view mode* over the same Movies/TV and Watched/Watchlist
 * selection, so both read the same filtered, sorted array and differ only in what
 * they draw. Everything above them is shared: one filter sheet, one sort menu, one
 * shuffle seed.
 *
 * The state lives with the caller so it survives switching between Watched and
 * Watchlist, which is what "persists while navigating within the Collection" means in
 * practice — a filter that resets every time you look at your watchlist is a filter
 * nobody uses twice.
 */
export function CollectionView({
  items,
  segment,
  state,
  onChange,
  onPressItem,
  empty,
  countAccessory,
}: CollectionViewProps) {
  const [filterOpen, setFilterOpen] = useState(false);

  const axes = sortAxesFor(segment);
  // A sort the current segment does not offer — Rating on a watchlist — falls back
  // rather than silently ordering by a field that is null on every row. The fallback
  // lands in the replacement axis's own default direction, so the chip, the arrow and
  // the rows agree the moment the tab changes.
  const sort = coerceSortState(state.sort, axes);

  // No manual `useMemo`. The React Compiler is on for this project
  // (app.config.ts `experiments.reactCompiler`), and it memoizes this itself —
  // a hand-written one here only gave it a dependency list it could not prove
  // stable, which it reports rather than silently ignoring.
  const visible = sortItems(applyFilters(items, state.filters), sort, state.seed);

  if (items.length === 0) {
    return (
      <>
        {countAccessory ? <View style={styles.accessoryOnly}>{countAccessory}</View> : null}
        {empty}
      </>
    );
  }

  const activeCount = activeFilterCount(state.filters);
  const filtered = isFiltered(state.filters);
  const reshuffle = () => onChange({ ...state, seed: state.seed + 1 });

  return (
    <View style={styles.body}>
      {/**
       * **One quiet toolbar: Filter & Sort on the left, Grid / List on the right** (founder,
       * UI cohesion pass, 2026-11-06). It replaced a row of outlined chips and a filled
       * segmented pair, which read as competing controls. Filter & Sort is one
       * text-and-icon action that opens one sheet; what is in force is said beside it in
       * tertiary text, so nothing needs a third row to show its state.
       */}
      <View style={styles.controls} testID="collection-toolbar">
        <View style={styles.toolbarStart}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={filterSortSpoken(axes, sort, activeCount)}
            accessibilityHint="Opens filters and the sort order"
            onPress={() => setFilterOpen(true)}
            style={({ pressed }) => [styles.filterSort, pressed && styles.pressed]}
            testID="collection-filter-sort"
          >
            {/* Footnote, secondary: a tool under the page's navigation, not a peer of it
                (final title refinement, 2026-11-06). The 44pt row is unchanged. */}
            <Ionicons
              name="options-outline"
              size={theme.layout.icon.sm}
              color={filtered ? theme.semantic.action : theme.text.tertiary}
            />
            <Text variant="footnote" tone="secondary" style={styles.filterSortLabel}>
              Filter & Sort
            </Text>
            <Text
              variant="footnote"
              tone={filtered ? 'action' : 'tertiary'}
              numberOfLines={1}
              // At a large text size it gives up a little size before it would end in "…".
              adjustsFontSizeToFit
              minimumFontScale={0.8}
              style={styles.filterSortStatus}
              testID="collection-filter-sort-status"
            >
              {filterSortStatus(axes, sort, activeCount)}
            </Text>
          </Pressable>
          {/* Shuffle's reshuffle, one press from the toolbar rather than three. */}
          {sort.axis === 'shuffle' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Shuffle again"
              onPress={reshuffle}
              style={({ pressed }) => [styles.reshuffle, pressed && styles.pressed]}
              testID="collection-reshuffle"
            >
              <Ionicons name="shuffle" size={theme.layout.icon.sm} color={theme.semantic.action} />
            </Pressable>
          ) : null}
        </View>

        {/* The view control, not a third collection state.

            **Poster first, list second** — the founder's §11 ordering, and it is the
            control reading as its own default: the leftmost cell is the one a device
            with no stored preference opens on, so the row and the state agree without
            the reader having to discover that they do. Reversed from the original,
            which put List first and then defaulted to it, and then had to default to
            Poster while still drawing List first. */}
        <IconToggle
          label="View"
          appearance="quiet"
          value={state.mode}
          onChange={(mode) => onChange({ ...state, mode })}
          options={VIEW_MODES}
          style={styles.toggle}
        />
      </View>

      <View style={styles.countRow}>
        <Text variant="footnote" tone="secondary" style={styles.countText} testID="collection-count">
          {visible.length === items.length
            ? `${items.length} ${items.length === 1 ? 'title' : 'titles'}`
            : `${visible.length} of ${items.length}`}
        </Text>
        {countAccessory}
      </View>

      {visible.length === 0 ? (
        <View style={styles.padded}>
          <EmptyState
            kind="nothingMatches"
            compact
            title="Nothing matches"
            body="Try removing a filter."
            action={{
              label: 'Clear all',
              onPress: () => onChange({ ...state, filters: emptyFilters() }),
            }}
          />
        </View>
      ) : state.mode === 'poster' ? (
        /**
         * **Both modes are virtualised, and that is the 2026-09-16 fix.**
         *
         * Each drew every row it was given into a plain `ScrollView`, so a library of 688
         * imported titles mounted 688 tiles before the first frame and kept every one of
         * them alive while scrolling. It was never about the importer: Watched (ranked
         * Movies and TV), Watchlist, Unranked and every filtered or sorted view of them
         * are this component, and all of them grew the same way. Poster was the one a
         * reader noticed because its tile is the heavier cell.
         *
         * Order, filters and counts are untouched: `visible` is computed exactly as it
         * was, and only the drawing of it changed.
         */
        <PosterGridList
          tiles={visible.map((item) => ({
            id: item.mediaItemId,
            title: nameOf(item),
            year: item.year,
            // `row` (342px wide) rather than `card` (500px). A wall tile is a third of
            // the screen, about 115pt, which is 345px at 3x and ~300px on a typical
            // Android panel — so 342 is the tile's own resolution, and 500 was decoding
            // twice the pixels for every poster scrolled past.
            posterUri: posterUri(item.posterPath, 'row'),
            // Only for titles that have one. A watchlist wall carries no
            // numbers, which is what keeps it from looking like a scoreboard.
            score: item.score,
            bucket: item.bucket,
          }))}
          onPressTile={(tile) => onPressItem(tile.id)}
          paddingTop={styles.wall.paddingTop}
          paddingBottom={styles.wall.paddingBottom}
        />
      ) : (
        <FlashList
          data={visible}
          keyExtractor={(item) => item.mediaItemId}
          // See the note on the grid in `PosterGridList`: a re-sort keeps the offset
          // rather than chasing the row that happened to be on top.
          maintainVisibleContentPosition={LIST_POSITION}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <TitleRow
              title={nameOf(item)}
              year={item.year}
              posterUri={posterUri(item.posterPath)}
              secondary={
                <TitleMetadata
                  runtimeMinutes={item.runtimeMinutes}
                  genres={item.genres}
                  showYear={false}
                />
              }
              trailing={
                segment !== 'watchlist' ? (
                  // The compact-row contract (design-system.md §11b): the score when
                  // ranked, otherwise the ordinary `+` — never a dashed ring, and the same
                  // for an import never ranked and a ranking left unfinished. It opens the
                  // title, whose Rank resumes an unfinished session.
                  <TitleRowActions
                    name={nameOf(item)}
                    kind={item.kind}
                    score={item.score != null ? { score: item.score, bucket: item.bucket } : null}
                    saved={null}
                    onRank={() => onPressItem(item.mediaItemId)}
                    onToggleWatchlist={() => {}}
                  />
                ) : undefined
              }
              divided
              onPress={() => onPressItem(item.mediaItemId)}
            />
          )}
        />
      )}

      {/* Mounted only while open, so the draft is seeded from the filters actually
          in force each time. See the comment on `CollectionFilterSheetProps.value`. */}
      {filterOpen ? (
        <CollectionFilterSheet
          items={items}
          value={state.filters}
          showBuckets={segment !== 'watchlist'}
          onApply={(filters) => {
            setFilterOpen(false);
            onChange({ ...state, filters });
          }}
          onClose={() => setFilterOpen(false)}
          // The sort choices this segment offers, applied on the press as they always were.
          // Shuffle is the one axis with no direction, so choosing it again reseeds.
          sort={{
            axes,
            value: sort,
            onChange: (next) => onChange({ ...state, sort: next }),
            onRepeatUndirected: reshuffle,
          }}
        />
      ) : null}
    </View>
  );
}

const LIST_POSITION = { disabled: true } as const;

const DOWN = '\u2193';
const UP = '\u2191';

/**
 * `Rating ↓`, `Recent ↓`, `Shuffle`, `Rating ↓ · 2 filters`: what is in force, beside the
 * action.
 *
 * **The axis in its short word** (QA corrections, 2026-11-06). The full label put
 * `Recently watched ↓` beside Filter & Sort, which ran out of room and ended in an
 * ellipsis on most phones. The status only has to say which order is on; the sheet one
 * tap away names it in full, and so does the spoken form.
 */
export function filterSortStatus<Axis extends string>(
  axes: readonly SortAxisSpec<Axis>[],
  sort: { axis: Axis; direction: 'asc' | 'desc' },
  activeFilters: number,
): string {
  const spec = axes.find((option) => option.axis === sort.axis);
  const name = spec ? (spec.shortLabel ?? spec.label) : '';
  const order = spec
    ? isDirectional(spec)
      ? `${name} ${sort.direction === 'desc' ? DOWN : UP}`
      : name
    : '';
  const filters = activeFilters
    ? `${activeFilters} ${activeFilters === 1 ? 'filter' : 'filters'}`
    : null;
  return [order, filters].filter(Boolean).join(' \u00b7 ');
}

/** The sentence a screen reader is given instead of the arrow. */
function filterSortSpoken<Axis extends string>(
  axes: readonly SortAxisSpec<Axis>[],
  sort: { axis: Axis; direction: 'asc' | 'desc' },
  activeFilters: number,
): string {
  const spec = axes.find((option) => option.axis === sort.axis);
  const order = spec
    ? spec.directions
      ? `Sorted by ${spec.label}, ${spec.directions[sort.direction]}`
      : `Sorted by ${spec.label}`
    : null;
  const filters = activeFilters
    ? `${activeFilters} ${activeFilters === 1 ? 'filter' : 'filters'} on`
    : 'No filters';
  return ['Filter and sort', order, filters].filter(Boolean).join('. ');
}

/** A ranked TV list is otherwise a column of rows called "Season 2". */
const nameOf = (item: CollectionItem) =>
  compactName({
    kind: item.kind,
    title: item.title,
    seriesTitle: item.seriesTitle,
    seasonNumber: item.seasonNumber,
  }) ?? item.title;

const styles = StyleSheet.create({
  body: { flex: 1 },
  /**
   * Two groups on one line: the action at the gutter, the view glyphs ending on it. The
   * glyphs' 44pt targets are wider than their 20pt glyphs by 12pt a side, so the row is
   * inset 12pt less on the right and the last glyph's edge lands on the gutter. The
   * status text is what gives way on a narrow phone or at a large text size: it
   * truncates before either control moves.
   */
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: theme.layout.gutter,
    paddingRight: theme.layout.gutter - (theme.layout.minTapTarget - theme.layout.icon.sm) / 2,
    paddingTop: theme.space[2],
  },
  toolbarStart: { flex: 1, flexDirection: 'row', alignItems: 'center', minWidth: 0 },
  // The status wraps under the label when the row has no room for both, rather than being
  // squeezed to nothing: at 200% text on a 320pt phone "Filter & Sort" alone fills the row
  // (QA corrections, 2026-11-06).
  filterSort: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space[2],
    minHeight: theme.layout.minTapTarget,
    flexShrink: 1,
    paddingRight: theme.space[2],
  },
  filterSortLabel: { flexShrink: 0 },
  filterSortStatus: { flexShrink: 0, maxWidth: '100%' },
  reshuffle: {
    width: theme.layout.minTapTarget,
    height: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggle: { marginLeft: theme.space[2] },
  pressed: { opacity: 0.6 },

  /** `37 titles` on the left and the lists link on the right, one line under the toolbar. */
  countRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[1],
    minHeight: theme.layout.minTapTarget - theme.space[2],
  },
  countText: { flexShrink: 1 },
  accessoryOnly: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
  },
  list: { paddingBottom: theme.space[10] },
  wall: { paddingBottom: theme.space[10], paddingTop: theme.space[2] },
  padded: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[4] },
});
