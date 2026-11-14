import { FlashList } from '@shopify/flash-list';
import { useState, type ReactNode } from 'react';
import { AccessibilityInfo, StyleSheet, useWindowDimensions, View } from 'react-native';

import { posterUri } from '@/lib/images';
import { compactName } from '@/lib/titles';
import {
  BrowseControlsRow,
  EmptyState,
  FilterIconButton,
  PosterGridList,
  Text,
  TitleMetadata,
  TitleRow,
  ViewModeToggle,
} from '@/ui/components';
import { coerceSortState, filterSortSpoken } from '@/ui/sort';
import { theme } from '@/ui/tokens';

import { CollectionFilterSheet } from './CollectionFilterSheet';
import { TitleRowActions } from './TitleRowActions';
import {
  activeFilterCount,
  COLLECTION_SORT_AXES,
  emptyFilters,
  nextShuffleSeed,
  offersRuntime,
  sortAxesFor,
  visibleItems,
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
  /**
   * Moved by every press of Shuffle ({@link nextShuffleSeed}), and by nothing else — not a
   * scroll, a re-render, a refetch, a filter or a switch between Poster and List.
   */
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
  /**
   * The page's marquee title, `Watched ▾` (marquee cohesion sprint, 2026-11-07): the left
   * of the toolbar, which scrolls away with the titles. Drawn in every state, so the way
   * to Watchlist never depends on there being titles here.
   */
  title?: ReactNode;
  /** Cards between the toolbar and the count (the unranked and refine prompts). */
  lead?: ReactNode;
  /**
   * Drawn in place of the titles while the section has none to give yet: its skeleton
   * while the read is on its way, its error when it failed. `items` is ignored meanwhile.
   *
   * **Here rather than in a screen of its own, so the toolbar is never remounted**
   * (2026-11-11). Collection drew loading and failed sections with a toolbar of their own
   * and swapped in this component's when the titles landed: two places in the tree, so a
   * Watched ▾ menu opened before the list arrived closed by itself when it did. Every
   * state is now drawn in the same list, under the same header.
   */
  placeholder?: ReactNode;
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
  title,
  lead,
  placeholder,
}: CollectionViewProps) {
  const [filterOpen, setFilterOpen] = useState(false);

  // Runtime only where a row could carry one: not on a TV list made only of seasons.
  const axes = sortAxesFor(segment, { runtime: offersRuntime(items) });
  // A sort the current segment does not offer — Rating on a watchlist — falls back
  // rather than silently ordering by a field that is null on every row. The fallback
  // lands in the replacement axis's own default direction, so the chip, the arrow and
  // the rows agree the moment the tab changes.
  const sort = coerceSortState(state.sort, axes);

  // No manual `useMemo`. The React Compiler is on for this project
  // (app.config.ts `experiments.reactCompiler`), and it memoizes this itself —
  // a hand-written one here only gave it a dependency list it could not prove
  // stable, which it reports rather than silently ignoring.
  const visible = visibleItems(items, state.filters, sort, state.seed);

  /**
   * What stands in for the titles, when something does: the section's own placeholder
   * (loading, failed), the empty collection, or a filter that hides everything. It is
   * drawn under the header inside the same list the titles use, so the toolbar keeps its
   * place in the tree whatever the read is doing (see `placeholder`).
   */
  const hasTitles = placeholder == null && items.length > 0;
  const standIn =
    placeholder != null ? (
      placeholder
    ) : items.length === 0 ? (
      <StateFill>{empty}</StateFill>
    ) : visible.length === 0 ? (
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
    ) : null;

  const activeCount = activeFilterCount(state.filters);

  /**
   * **Every press of Shuffle, from any axis or from Shuffle itself** (approved spec,
   * 2026-11-10): a new seed whose order differs from the one on screen, applied at once,
   * and the sheet closed so the new order is what the reader sees next.
   *
   * It does not wait for Apply and does not apply the filter drafts: those are the
   * filters' own, and closing the sheet abandons them exactly as closing it any other way
   * does. There is no reshuffle glyph in the toolbar any more — Shuffle lives in the sheet.
   */
  const shuffleNow = () => {
    setFilterOpen(false);
    // The sheet closes on the press, so nothing on screen says the order changed; a screen
    // reader is told in words.
    AccessibilityInfo.announceForAccessibility('Shuffled');
    onChange({
      ...state,
      sort: { axis: COLLECTION_SORT_AXES.shuffle.axis, direction: 'desc' },
      seed: nextShuffleSeed(
        items,
        state.filters,
        state.seed,
        visible.map((item) => item.mediaItemId),
      ),
    });
  };

  /**
   * **The page's toolbar, then its cards, then the count — all at the head of the list**
   * (founder, marquee cohesion sprint, 2026-11-07).
   *
   *     Watched ▾                               ⚙   ▦ ☰
   *     37 titles                                My lists ›
   *
   * The marquee is the page's navigation (Watched / Watchlist / Unranked), and the tools
   * opposite it act on what it shows: the Filters & Sort icon, one sheet holding the sort and
   * the filters, then the Poster / List toggle, rightmost (QA 11-14, §5) —
   * `BrowseControlsRow` since FU1113-C, so the tools never wrap and the marquee is what gives way on a narrow phone. The full-width segmented control that sat above this is
   * gone; the order in force is not written beside Filters any more, because the sheet
   * names it. The whole header scrolls away with the titles, so the posters get the screen
   * back; the app header and the tab bar stay where they always were.
   */
  const header = (
    <View>
      {/* First, in every state: the one position the marquee has (see `placeholder`). The
          tools act on titles, so they are drawn only when there are some. */}
      <View style={styles.toolbar}>
        <BrowseControlsRow
          testID="collection-toolbar"
          leading={title}
          trailing={
            hasTitles ? (
              <>
                {/* **Filters & Sort first, the view toggle rightmost** (founder QA 11-14,
                    §5; was toggle then filter), as on For You. */}
                <FilterIconButton
                  activeCount={activeCount}
                  // The sentence says the order and the count itself, so the button adds no
                  // ", N on" of its own.
                  accessibilityLabel={filterSortSpoken(axes, sort, activeCount)}
                  announceCount={false}
                  accessibilityHint="Opens filters and the sort order"
                  onPress={() => setFilterOpen(true)}
                  testID="collection-filter-sort"
                />
                {/* The view control, not a third collection state. **Poster first, list
                    second** (founder §11): the leftmost cell is the one a device with no
                    stored preference opens on, so the row and the state agree. */}
                <ViewModeToggle
                  value={state.mode}
                  onChange={(mode) => onChange({ ...state, mode })}
                  testID="collection-view-mode"
                />
              </>
            ) : undefined
          }
        />
      </View>

      {lead}

      {hasTitles ? (
        <View style={styles.countRow}>
          <Text variant="footnote" tone="secondary" style={styles.countText} testID="collection-count">
            {visible.length === items.length
              ? `${items.length} ${items.length === 1 ? 'title' : 'titles'}`
              : `${visible.length} of ${items.length}`}
          </Text>
          {countAccessory}
        </View>
      ) : countAccessory ? (
        // The way to the lists never depends on there being titles.
        <View style={styles.accessoryOnly}>{countAccessory}</View>
      ) : null}

      {standIn}
    </View>
  );
  /** The titles the list draws: none while something stands in for them. */
  const shown = standIn == null ? visible : [];

  return (
    <View style={styles.body}>
      {state.mode === 'poster' ? (
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
          tiles={shown.map((item) => ({
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
            // A ranked season's pill names its season: `S4 - 9.1`. The TV Collection draws
            // series, not seasons, since WS-TVC, so this only fires where a season tile
            // still appears.
            season: item.kind === 'season' && item.score != null ? (item.seasonNumber ?? null) : null,
            // WS-TVC: a series poster's score is its explicit show ranking (filled) or the
            // mean of its ranked seasons (outlined `SN AVG`).
            scoreSource: item.showScore?.source,
            rankedSeasonCount: item.showScore?.rankedSeasonCount,
          }))}
          onPressTile={(tile) => onPressItem(tile.id)}
          // The wall's top space follows the header now, rather than preceding it.
          header={
            <>
              {header}
              <View style={styles.wallTop} />
            </>
          }
          paddingBottom={styles.wall.paddingBottom}
        />
      ) : (
        <FlashList
          data={shown}
          keyExtractor={(item) => item.mediaItemId}
          // See the note on the grid in `PosterGridList`: a re-sort keeps the offset
          // rather than chasing the row that happened to be on top.
          maintainVisibleContentPosition={LIST_POSITION}
          ListHeaderComponent={header}
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
                    score={
                      item.score != null
                        ? {
                            score: item.score,
                            bucket: item.bucket,
                            // WS-TVC: a season average draws outlined, as on the wall —
                            // the same `SN AVG` badge since FU1113-B.
                            variant: item.showScore?.source === 'average' ? 'outlined' : 'filled',
                            average: item.showScore?.source === 'average',
                          }
                        : null
                    }
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
          // The sort choices this segment offers, applied on the press as they always were;
          // the sheet stays open so a second press reverses. Shuffle is the exception: any
          // press of it deals a new order and closes the sheet (`shuffleNow`).
          sort={{
            axes,
            value: sort,
            onChange: (next) =>
              next.axis === COLLECTION_SORT_AXES.shuffle.axis
                ? shuffleNow()
                : onChange({ ...state, sort: next }),
            onRepeatUndirected: shuffleNow,
          }}
        />
      ) : null}
    </View>
  );
}

const LIST_POSITION = { disabled: true } as const;

/**
 * A state that stands in for the whole list (an empty collection, a failed read), centred
 * in roughly the room the list would have had.
 *
 * It is drawn inside the list's header now (see `placeholder`), and a header has no height
 * to fill, so `EmptyState`'s own `flex: 1` collapses and the state would sit pinned under
 * the toolbar with the screen blank below it (independent review, 2026-11-11). A minimum
 * height from the window gives it the room it had when it filled the screen. The skeleton
 * does not use this: a loading list starts at the top, as the titles will.
 */
export function StateFill({ children }: { children: ReactNode }) {
  const { height } = useWindowDimensions();
  return (
    <View
      style={[styles.fill, { minHeight: Math.round(height * STATE_FILL) }]}
      testID="collection-state-fill"
    >
      {children}
    </View>
  );
}

/** The share of the window a whole-list state is centred in: below the app header,
 * toolbar and tab bar on a phone. */
const STATE_FILL = 0.55;

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
  // The toolbar's top inset, as `ContentToolbar` drew it: `BrowseControlsRow` draws none.
  toolbar: { paddingTop: theme.space[2] },

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
  wall: { paddingBottom: theme.space[10] },
  wallTop: { height: theme.space[2] },
  padded: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[4] },
  fill: { justifyContent: 'center' },
});
