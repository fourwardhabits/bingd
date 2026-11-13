import { useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { CollectionFilterSheet } from '@/features/collection/CollectionFilterSheet';
import {
  activeFilterCount,
  applyFilters,
  compareItems,
  emptyFilters,
  isFiltered,
  offersRuntime,
  titleFactSortAxes,
  type CollectionFilters,
  type CollectionItem,
} from '@/features/collection/filters';
import { bandSizes, projectedScore, scoreFor } from '@/features/collection/score';
import { useRankedCollection, type RankedEntry } from '@/features/collection/use-collection';
import { standaloneShows } from '@/features/collection/watched-rows';
import { posterUri } from '@/lib/images';
import { compactName } from '@/lib/titles';
import {
  DismissFooter,
  EmptyState,
  FilterChip,
  FiltersAction,
  ScoreBadge,
  SegmentedTabs,
  Sheet,
  SheetHeader,
  SkeletonRow,
  Text,
  TitleRow,
} from '@/ui/components';
import { coerceSortState, type SortAxisSpec, type SortState } from '@/ui/sort';
import { theme } from '@/ui/tokens';

export type RankedCategory = 'movies' | 'tv_seasons';

/**
 * How many rows this sheet will mount.
 *
 * Two hundred, which is what the server page it replaced already allowed, and it is a
 * *render* bound rather than a read bound: `useRankedCollection` reads the category to
 * exhaustion because the profile behind this sheet needs the whole thing to compute the
 * bands. What must stay bounded is the number of native views built in one frame — this
 * is a `ScrollView`, and `FollowListSheet` records why it cannot be a virtualised list
 * here: a `FlatList` inside a `maxHeight: 90%` container measures to zero.
 */
const VISIBLE_CAP = 200;

/**
 * The two axes this sheet offers, and there are deliberately only two.
 *
 * ---------------------------------------------------------------------------
 * WHY "RECENTLY RANKED" AND NOT "RECENTLY WATCHED"
 *
 * The founder asked for a recency axis on somebody else's collection. The watch date
 * cannot carry it: PRD §22 states that watch dates are private "on any profile, at any
 * visibility, to anybody", and `logged_collection` — the projection a visitor's read of a
 * collection goes through — omits the column on purpose. A control labelled *Recently
 * watched* over another person's list would either be a lie about what it sorts by or a
 * reversal of that rule made in passing.
 *
 * So the axis is the moment the title entered their ranking (`rankings.created_at`),
 * which is exactly the instant their public "ranked X" activity already carries, and the
 * label says so. Same order, same rows, nothing private crossing a boundary. Founder
 * decision, 2026-08-29.
 *
 * **The Collection tab reached the same answer from the other side** on 2026-08-30, and
 * for a different reason — its Recently-watched axis was ordering by nothing at all —
 * so the two surfaces now agree that a recency label names the fact it actually reads:
 * *Recently added* over a collection's membership time, *Recently ranked* over a
 * ranking's. Neither of them names a watch date, and one of them could not.
 *
 * ---------------------------------------------------------------------------
 * TWO AXES, NOT FOUR ORDERS
 *
 * It listed `Highest first`, `Lowest first`, `Newest first`, `Oldest first` — four rows
 * for two axes, with the direction spent on the label. It is now one row per axis with
 * the direction on an arrow, which is `ui/sort.ts`'s contract and the same control the
 * Collection tab draws. Nothing about *which orders exist* changed; what changed is that
 * the label names the axis, so it cannot drift away from the direction beside it.
 *
 * ---------------------------------------------------------------------------
 * WHY RANK IS STILL THE DEFAULT
 *
 * Unchanged: the wall above this sheet shows the best six, and the question a reader has
 * after seeing it is what comes seventh.
 */
export type CollectionSortAxis = 'rank' | 'ranked' | 'year' | 'runtime' | 'title';

export type CollectionSort = SortState<CollectionSortAxis>;

/**
 * The two axes that are this sheet's own: its owner's order, and when each title entered it.
 */
const RANKING_AXES: readonly SortAxisSpec<CollectionSortAxis>[] = [
  {
    axis: 'rank',
    label: 'Rank',
    directions: { desc: 'highest first', asc: 'lowest first' },
    defaultDirection: 'desc',
  },
  {
    axis: 'ranked',
    label: 'Recently ranked',
    directions: { desc: 'newest first', asc: 'oldest first' },
    defaultDirection: 'desc',
  },
];

/**
 * **Every order this sheet offers** (founder spec §4, 2026-11-13: "reuse applicable
 * filter/sort definitions from the main Collection").
 *
 * The two ranking axes above, then the main Collection's own definitions of the orders
 * that are facts about the titles — Release year, Runtime, Title — taken from
 * `titleFactSortAxes` rather than restated. Still no watch-date order and no Shuffle:
 * a watch date is private (above), and Shuffle is a way of choosing what to watch from
 * one's own list rather than of reading somebody's ranking.
 */
export const sortAxesForRanked = ({
  runtime = true,
}: { runtime?: boolean } = {}): readonly SortAxisSpec<CollectionSortAxis>[] => [
  ...RANKING_AXES,
  ...titleFactSortAxes({ runtime }),
];

export const SORT_AXES: readonly SortAxisSpec<CollectionSortAxis>[] = sortAxesForRanked();

/** Where the sheet opens: the best of the list, which is the question the wall leaves. */
export const INITIAL_SORT: CollectionSort = { axis: 'rank', direction: 'desc' };

/**
 * The comparator for one order, **total in every case**.
 *
 * `position` is unique per category (`rankings_position_unique`), so the two rank orders
 * have no ties to break; the id tiebreak is there anyway, because a comparator that is
 * only total by accident of a constraint elsewhere is one schema change from reordering
 * itself between renders.
 *
 * **Undated titles sort last in both directions**, which is the founder's rule and is
 * why the date test comes before the direction rather than inside it. `rankings.created_at`
 * is `not null`, so this can only fire for a bundle reading a response without the
 * column — and "last, always" is the answer that does not put an unknown at the top of a
 * list claiming to be newest.
 */
export function compareBySort(sort: CollectionSort) {
  return (
    a: { position: number; rankedAt: string | null; mediaItemId: string },
    b: { position: number; rankedAt: string | null; mediaItemId: string },
  ): number => {
    const tiebreak = a.mediaItemId.localeCompare(b.mediaItemId);

    // Position 1 is the top of the band, so "highest first" is ascending in `position`.
    if (sort.axis === 'rank') {
      return (
        (sort.direction === 'desc' ? a.position - b.position : b.position - a.position) ||
        tiebreak
      );
    }

    if (sort.axis !== 'ranked') return tiebreak;

    if (!a.rankedAt && !b.rankedAt) return tiebreak;
    if (!a.rankedAt) return 1;
    if (!b.rankedAt) return -1;

    const byDate =
      sort.direction === 'desc'
        ? b.rankedAt.localeCompare(a.rankedAt)
        : a.rankedAt.localeCompare(b.rankedAt);
    return byDate || tiebreak;
  };
}

export type RankedTitlesSheetProps = {
  /** Which list is open, or null while the sheet is closed. */
  category: RankedCategory | null;
  /** Switches the list without closing it — the sheet's own Movies / TV control. */
  onChangeCategory: (next: RankedCategory) => void;
  userId: string;
  /** The profile's display name, for the header of somebody else's list. */
  name: string;
  isSelf: boolean;
  onPressTitle: (mediaItemId: string) => void;
  onClose: () => void;
};

/**
 * Somebody's ranked collection, in their order.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 *
 * A profile shows the best of a collection — `TopRanked`'s wall of six. Browsing the
 * rest of somebody's ranking is the social use that wall implies and did not answer, so
 * this is the See all behind it: the whole list, read-only, in rank order.
 *
 * **A sheet, not a screen** — `FollowListSheet`'s rule, for the same reason: this is a
 * list you glance at and leave, and every row already leads somewhere real. It is also
 * how there comes to be no second self-collection surface: the reader's own See all goes
 * to the Collection tab, which is the editable one.
 *
 * ---------------------------------------------------------------------------
 * RANK ORDER, WHICH REPLACED NEWEST-FIRST (founder, 2026-08-29)
 * ---------------------------------------------------------------------------
 *
 * This listed newest addition first, on the reasoning that a profile visit asks "what
 * have they been adding lately". The founder's correction is that **rank order is the
 * point**: the wall above already shows the best six, and the question a reader has
 * after seeing it is what comes seventh — not what was added on Tuesday.
 *
 * The ordinal is drawn, because without it a rank-ordered list is indistinguishable
 * from an arbitrary one.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE DATA COMES FROM, AND WHY IT COSTS NOTHING
 * ---------------------------------------------------------------------------
 *
 * `useRankedCollection`, which is **the query `TopRanked` already ran** to build the wall
 * on the profile behind this sheet — same key, same cache entry, so opening this issues
 * no request *while that entry is fresh*. It is not free for ever: the global
 * `staleTime` is 60s, and a reader who spends a minute on a profile before opening the
 * list pays one refetch. Only the category actually on screen is enabled, so that is one
 * refetch rather than two. It replaced a second, sheet-only read of `rankings` ordered by
 * `created_at` and capped at 200; that read is gone rather than left beside this one.
 *
 * It is keyset-paginated on `media_item_id` inside `readAllByKey` — deliberately not on
 * `position`, because inserting a ranking shifts every position below it and a position
 * cursor can be moved out from under the read by a concurrent ranking session. So pages
 * cannot duplicate or drop a row, and rank order is applied to the assembled list.
 *
 * **The scores are the profile owner's, computed against their whole band** —
 * `scoreFor` over `bandSizes` of the full category, never over the slice on screen,
 * which is the rule `TopRanked` records: scoring six titles against themselves gives all
 * six a 10. Nothing here reads the viewer's own collection, so there is no path by which
 * one person's number is drawn beside another person's name.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT SHOW
 * ---------------------------------------------------------------------------
 *
 * No edit, re-rank, remove or unlog control; no notes, reviews, companions or watch
 * dates; no watchlist. Those are either the owner's alone or belong to the Collection
 * tab, and this is a read of ranking data and nothing else.
 *
 * Privacy is the reading rather than the sheet: `rankings` answers to `rankings_read`,
 * so an unapproved viewer of a private profile gets nothing from the server — and the
 * profile above this refuses first, so the sheet is never reached. Logged-only titles
 * are owner-private by policy and are neither counted on the stat nor listed here.
 */
export function RankedTitlesSheet({
  category,
  onChangeCategory,
  userId,
  name,
  isSelf,
  onPressTitle,
  onClose,
}: RankedTitlesSheetProps) {
  // **Only the category on screen**, and only while the sheet is open.
  //
  // Both were enabled at first, on the reasoning that the profile behind this sheet has
  // already asked for both so neither is a new request. That is true only while those
  // entries are fresh: the global `staleTime` is 60s, so a reader who spends a minute on
  // a profile and then opens Movies was refetching **both** whole collections, one of
  // which is not being drawn. The switch below enables the other when it is asked for.
  const movies = useRankedCollection(userId, 'movies', { enabled: category === 'movies' });
  const seasons = useRankedCollection(userId, 'tv_seasons', {
    enabled: category === 'tv_seasons',
  });
  // TV is two rankings since 2026-11-14: the seasons, and the whole shows that stand alone
  // beside them under Candidate A's precedence. Read only while TV is open.
  const shows = useRankedCollection(userId, 'tv_shows', { enabled: category === 'tv_seasons' });
  const list = category === 'tv_seasons' ? seasons : movies;

  const [sort, setSort] = useState<CollectionSort>(INITIAL_SORT);
  /**
   * **The main Collection's filters, over somebody's ranking** (founder spec §4).
   *
   * Genre, language, decade and rating — the same facets, drawn by the same
   * `CollectionFilterSheet`, over the same `CollectionItem` shape. They narrow what is
   * drawn and nothing else: the scores beside each row are still computed against the
   * owner's whole band, never against the filtered slice.
   */
  const [filters, setFilters] = useState<CollectionFilters>(emptyFilters);
  const [filtering, setFiltering] = useState(false);
  /**
   * **Filters belong to one list, opened once** (independent review, 2026-11-13). The
   * profile keeps this sheet mounted while it is closed, so without this a genre chosen
   * over somebody's films would still be applied when their TV list is opened from the
   * wall — possibly straight into "Nothing matches". Reset whenever the category changes,
   * which includes closing (null) and the sheet's own Movies / TV switch. Adjusted during
   * render, React's answer for state that follows a prop.
   */
  const [filtersFor, setFiltersFor] = useState(category);
  if (filtersFor !== category) {
    setFiltersFor(category);
    setFilters(emptyFilters());
    setFiltering(false);
  }
  const scroll = useRef<ScrollView>(null);

  const pooled = useMemo(() => {
    const own = list.data ?? [];
    const showRows = category === 'tv_seasons' ? standaloneShows(own, shows.data ?? []) : [];
    // **The band is measured over the whole category, the slice is what gets drawn.**
    // Scoring against the visible slice would give the top row a 10 whatever it is
    // (`TopRanked` records the same rule), so `bandSizes` sees everything and the cap is
    // applied afterwards. Each pool against its own bands: a show among shows.
    const sizes = bandSizes(own);
    const showSizes = bandSizes(shows.data ?? []);
    return [
      ...own.map((entry) => ({ entry, sizes, pool: 0 })),
      ...showRows.map((entry) => ({ entry, sizes: showSizes, pool: 1 })),
    ].map((item) => ({
      ...item,
      projected: projectedScore(item.entry.bucket, item.entry.position, item.sizes),
      score: scoreFor(item.entry.bucket, item.entry.position, item.sizes),
    }));
  }, [category, list.data, shows.data]);

  /** Each row as the main Collection's item, for its filters and its title-fact orders. */
  const items = useMemo(
    () => pooled.map(({ entry, score }) => asCollectionItem(entry, score)),
    [pooled],
  );
  const axes = useMemo(() => sortAxesForRanked({ runtime: offersRuntime(items) }), [items]);
  // A list made only of seasons offers no Runtime; an order chosen over films falls back to
  // the first axis rather than silently sorting by a field every row lacks (the Collection
  // tab's own rule, `CollectionView`).
  const order = useMemo(() => coerceSortState(sort, axes), [sort, axes]);

  const { rows, matching } = useMemo(() => {
    const kept = isFiltered(filters)
      ? new Set(applyFilters(items, filters).map((item) => item.mediaItemId))
      : null;
    const filtered = kept ? pooled.filter((item) => kept.has(item.entry.mediaItemId)) : pooled;
    const byItem = new Map(items.map((item) => [item.mediaItemId, item]));

    // **Two pools are ordered by score, never by ordinal.** A show's #2 and a season's #2
    // are different lists, so the rank order of a mixed TV list is the score each row
    // prints (unrounded, so each pool keeps its own order), then a fixed pool order, then
    // the id. One pool keeps `compareBySort` exactly as before.
    const bySort = compareBySort(order);
    const byFact =
      order.axis === 'year' || order.axis === 'runtime' || order.axis === 'title'
        ? compareItems({ axis: order.axis, direction: order.direction })
        : null;
    const mixed = filtered.some((item) => item.pool === 1);
    const compare = (a: (typeof pooled)[number], b: (typeof pooled)[number]) => {
      if (byFact) {
        const left = byItem.get(a.entry.mediaItemId);
        const right = byItem.get(b.entry.mediaItemId);
        return left && right ? byFact(left, right) : 0;
      }
      return mixed && order.axis === 'rank'
        ? (order.direction === 'desc' ? b.projected - a.projected : a.projected - b.projected) ||
            a.pool - b.pool ||
            a.entry.mediaItemId.localeCompare(b.entry.mediaItemId)
        : bySort(a.entry, b.entry);
    };
    // **Sorted before the cap, never after.** A cap applied first would make each order a
    // re-arrangement of the same two hundred titles rather than the first two hundred of
    // that order — so "Oldest first" would silently mean "oldest of their most recent
    // two hundred", which is a different and wrong claim.
    const drawn = [...filtered]
      .sort(compare)
      .slice(0, VISIBLE_CAP)
      .map(({ entry, score }) => ({
        mediaItemId: entry.mediaItemId,
        // The canonical compact form, so a season reads "The Bear, S2" here exactly as it
        // does on the wall, in the feed and in search.
        title:
          compactName({
            kind: entry.kind,
            title: entry.title,
            seriesTitle: entry.seriesTitle,
            seasonNumber: entry.seasonNumber,
          }) ?? entry.title,
        year: entry.year,
        posterUri: posterUri(entry.posterPath),
        position: entry.position,
        /** A whole show's ordinal counts among shows, and its row says so. */
        isShow: entry.kind === 'series',
        score,
        bucket: entry.bucket,
      }));
    return { rows: drawn, matching: filtered.length };
  }, [filters, items, order, pooled]);

  /** How many the category actually holds, for the count and the cap's disclosure. */
  const total = pooled.length;

  if (!category) return null;

  const whose = isSelf ? 'Your collection' : `${name}'s collection`;
  const pending = list.isPending || (category === 'tv_seasons' && shows.isPending);
  const failed = list.isError || (category === 'tv_seasons' && shows.isError);
  const activeCount = activeFilterCount(filters);
  const backToTop = () => scroll.current?.scrollTo({ y: 0, animated: false });

  return (
    <Sheet
      visible
      onClose={onClose}
      label={whose}
      // The densest list in the app's sheets: it gets the whole 90%, and keeps it while
      // its tabs, sorts and filters change what is in it.
      density="dense"
      footer={<DismissFooter onPress={onClose} />}
    >
      <SheetHeader title={whose}>
        {/* Movies and TV are separate rankings and a position only means anything inside
            its own category (PRD §11), so this switches between two lists rather than
            filtering one. Same control and same words as the wall above it. */}
        <SegmentedTabs
          options={[
            { id: 'movies' as const, label: 'Movies' },
            { id: 'tv_seasons' as const, label: 'TV Shows' },
          ]}
          value={category}
          // A filter chosen over films is not a filter over seasons — a genre or a decade
          // may not exist in the other list at all — so the switch clears them (above).
          onChange={onChangeCategory}
        />
      </SheetHeader>

      {/**
       * **Filters & Sort, the main Collection's one entry** (founder spec §4, 2026-11-13).
       *
       * It replaced a sort chip with an inline menu, which was this sheet's own grammar for
       * an idea the Collection tab already draws: one action opening one sheet that holds
       * the order and the filters. The count beside it says how much of the list the
       * filters leave, as the Collection tab's does.
       */}
      {pending || failed || total === 0 ? null : (
        <View style={styles.toolbar} testID="ranked-toolbar">
          <Text variant="footnote" tone="secondary" style={styles.count} testID="ranked-count">
            {matching === total
              ? `${total} ${total === 1 ? 'title' : 'titles'}`
              : `${matching} of ${total}`}
          </Text>
          {isFiltered(filters) ? (
            <FilterChip
              icon="close"
              label="Clear all"
              onPress={() => {
                setFilters(emptyFilters());
                backToTop();
              }}
            />
          ) : null}
          <FiltersAction
            label="Filters & Sort"
            activeCount={activeCount}
            accessibilityLabel={filterSortSpoken(axes, order, activeCount)}
            accessibilityHint="Opens filters and the sort order"
            onPress={() => setFiltering(true)}
            testID="ranked-filter-sort"
          />
        </View>
      )}

      <ScrollView
        ref={scroll}
        testID="ranked-list"
        // Flexes to the room the sheet has left, so the last row scrolls into view above
        // the Close footer. A fixed cap here (it was 380) is what left this list cramped.
        style={styles.list}
        contentContainerStyle={styles.listContent}
      >
        {pending ? (
          <SkeletonRow count={4} />
        ) : failed ? (
          <View style={styles.empty}>
            <EmptyState
              kind="couldNotLoad"
              compact
              title="Could not load the list"
              body="Check your connection and try again."
              action={{
                label: 'Try again',
                onPress: () => {
                  void list.refetch();
                  if (category === 'tv_seasons') void shows.refetch();
                },
              }}
            />
          </View>
        ) : total === 0 ? (
          <View style={styles.empty}>
            <EmptyState
              kind="nothingYet"
              compact
              // "TV" keeps its capitals mid-sentence; only "Movies" lowers.
              title={`No ${category === 'movies' ? 'movies' : 'TV'} ranked yet`}
              body={
                isSelf
                  ? 'Log and rank a title and it will appear here.'
                  : 'Nothing ranked in this category so far.'
              }
            />
          </View>
        ) : rows.length === 0 ? (
          <View style={styles.empty}>
            <EmptyState
              kind="nothingMatches"
              compact
              title="Nothing matches your filters"
              body="Try removing one, or clear them and start again."
              action={{ label: 'Clear all', onPress: () => setFilters(emptyFilters()) }}
            />
          </View>
        ) : (
          <>
            {rows.map((row) => (
              <TitleRow
                key={row.mediaItemId}
                title={row.title}
                year={row.year}
                posterUri={row.posterUri}
                // The ordinal leads the row, because it is what the order means.
                // Tertiary ink and caption weight: it labels the row rather than
                // competing with the score, which is the number a reader is scanning for.
                leading={
                  <View style={styles.ordinal}>
                    <Text variant="caption" tone="tertiary">
                      {`#${row.position}`}
                    </Text>
                    {/* A show's place is among shows, never among the seasons around it. */}
                    {row.isShow ? (
                      <Text variant="caption" tone="tertiary">
                        show
                      </Text>
                    ) : null}
                  </View>
                }
                // The owner's score, in the badge every other list in the app uses. No
                // `onPress` of its own: on the Collection tab that badge opens the log
                // sheet, which is an owner action and has no meaning on somebody else's
                // ranking — the row's own tap goes to the title page instead.
                trailing={<ScoreBadge score={row.score} bucket={row.bucket} />}
                divided
                onPress={() => onPressTitle(row.mediaItemId)}
              />
            ))}
            {/* **The cap is said rather than left to be discovered by counting.**
                This is a `ScrollView` and every row it holds is mounted at once, so the
                render is bounded, as the 200-row server page this replaced already
                bounded it, and a reader with more than that is told so instead of
                silently shown a prefix. Their whole collection is still what the band
                and the scores were computed from. */}
            {matching > VISIBLE_CAP ? (
              <Text variant="footnote" tone="secondary" style={styles.truncation}>
                {/* "Their top 200" was true while rank was the only order and is a wrong
                    claim under "Oldest first". The bound is what has to be said; which
                    end of which order it cuts is on screen already. */}
                {`Showing ${VISIBLE_CAP} of ${matching}.`}
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>

      {/* Mounted only while open: the filter sheet seeds its draft once, on mount. */}
      {filtering ? (
        <CollectionFilterSheet
          items={items}
          value={filters}
          showBuckets
          label={isSelf ? undefined : `Filter and sort ${name}'s collection`}
          onApply={(next) => {
            setFilters(next);
            setFiltering(false);
            backToTop();
          }}
          onClose={() => setFiltering(false)}
          sort={{
            axes,
            value: order,
            onChange: (next) => {
              setSort(next);
              // **Back to the top on every change.** A `ScrollView` keeps its offset when
              // its children are replaced, so a reader two hundred rows down would be
              // dropped into the middle of an order they have not seen the start of.
              backToTop();
            },
          }}
        />
      ) : null}
    </Sheet>
  );
}

/** One ranked entry in the main Collection's shape, so its filters and orders apply as-is. */
function asCollectionItem(entry: RankedEntry, score: number): CollectionItem {
  return {
    mediaItemId: entry.mediaItemId,
    title: entry.title,
    seriesTitle: entry.seriesTitle,
    seasonNumber: entry.seasonNumber ?? null,
    kind: entry.kind,
    year: entry.year,
    posterPath: entry.posterPath,
    genres: entry.genres ?? [],
    language: entry.language ?? null,
    runtimeMinutes: entry.runtimeMinutes ?? null,
    score,
    position: entry.position,
    category: entry.category,
    bucket: entry.bucket,
    // Private on anybody's profile (PRD §22), and never read here.
    watchedOn: null,
    addedAt: null,
  };
}

/** The sentence a screen reader is given for the Filters & Sort action — the Collection tab's. */
function filterSortSpoken(
  axes: readonly SortAxisSpec<CollectionSortAxis>[],
  sort: CollectionSort,
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

const styles = StyleSheet.create({
  toolbar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space[2],
    paddingLeft: theme.layout.gutter,
    // The Filters action's own 44pt cell carries its glyph to the gutter.
    paddingRight: theme.layout.gutter - theme.space[2],
    paddingBottom: theme.space[1],
  },
  count: { flex: 1 },
  // Wide enough for "#100" so the posters keep an unbroken left edge however deep the
  // list goes — a column that resizes per row is the ragged one.
  ordinal: { minWidth: 34 },
  // Fills the dense sheet's content area: no cap, so the list takes the room it is given.
  list: { flex: 1 },
  listContent: { paddingBottom: theme.space[3] },
  truncation: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
  empty: { paddingHorizontal: theme.layout.gutter },
});
