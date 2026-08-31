import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { posterUri } from '@/lib/images';
import { compactName } from '@/lib/titles';
import {
  EmptyState,
  FilterChip,
  IconToggle,
  type IconToggleOption,
  PosterGrid,
  ScoreBadge,
  SortChip,
  SortMenu,
  Text,
  TitleMetadata,
  TitleRow,
} from '@/ui/components';
import { coerceSortState } from '@/ui/sort';
import { theme } from '@/ui/tokens';

import { CollectionFilterSheet } from './CollectionFilterSheet';
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
}: CollectionViewProps) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);

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

  if (items.length === 0) return <>{empty}</>;

  const activeCount = activeFilterCount(state.filters);

  return (
    <View style={styles.body}>
      <View style={styles.controls}>
        <FilterChip
          icon="options-outline"
          label={activeCount ? `Filters · ${activeCount}` : 'Filters'}
          selected={isFiltered(state.filters)}
          onPress={() => setFilterOpen(true)}
        />
        <SortChip axes={axes} value={sort} onPress={() => setSortOpen((open) => !open)} />
        {sort.axis === 'shuffle' ? (
          <FilterChip
            icon="shuffle"
            label="Shuffle"
            onPress={() => onChange({ ...state, seed: state.seed + 1 })}
          />
        ) : null}

        <View style={styles.spacer} />

        {/* The view control, not a third collection state.

            **Poster first, list second** — the founder's §11 ordering, and it is the
            control reading as its own default: the leftmost cell is the one a device
            with no stored preference opens on, so the row and the state agree without
            the reader having to discover that they do. Reversed from the original,
            which put List first and then defaulted to it, and then had to default to
            Poster while still drawing List first. */}
        <IconToggle
          label="View"
          value={state.mode}
          onChange={(mode) => onChange({ ...state, mode })}
          options={VIEW_MODES}
        />
      </View>

      {sortOpen ? (
        <SortMenu
          axes={axes}
          value={sort}
          onChange={(next) => onChange({ ...state, sort: next })}
          onClose={() => setSortOpen(false)}
          // Shuffle is the one axis with no direction, so choosing it again reseeds
          // rather than reversing anything. The reshuffle chip beside the control stays,
          // because reseeding from a closed menu is one press instead of three.
          onRepeatUndirected={() => onChange({ ...state, seed: state.seed + 1 })}
        />
      ) : null}

      <Text variant="footnote" tone="secondary" style={styles.count}>
        {visible.length === items.length
          ? `${items.length} ${items.length === 1 ? 'title' : 'titles'}`
          : `${visible.length} of ${items.length}`}
      </Text>

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
        <ScrollView contentContainerStyle={styles.wall}>
          <PosterGrid
            tiles={visible.map((item) => ({
              id: item.mediaItemId,
              title: nameOf(item),
              year: item.year,
              posterUri: posterUri(item.posterPath, 'card'),
              // Only for titles that have one. A watchlist wall carries no
              // numbers, which is what keeps it from looking like a scoreboard.
              score: item.score,
              bucket: item.bucket,
            }))}
            onPressTile={(tile) => onPressItem(tile.id)}
          />
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {visible.map((item) => (
            <TitleRow
              key={item.mediaItemId}
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
                  <ScoreBadge
                    score={item.score}
                    bucket={item.bucket}
                    onPress={() => onPressItem(item.mediaItemId)}
                  />
                ) : undefined
              }
              divided
              onPress={() => onPressItem(item.mediaItemId)}
            />
          ))}
        </ScrollView>
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
        />
      ) : null}
    </View>
  );
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
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
  },
  spacer: { flex: 1 },

  // The sort menu's own styles moved to `ui/components/SortControl` with the menu.
  count: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[1],
  },
  list: { paddingBottom: theme.space[10] },
  wall: { paddingBottom: theme.space[10], paddingTop: theme.space[2] },
  padded: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[4] },
});
