import { useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { bandSizes, scoreFor } from '@/features/collection/score';
import { useRankedCollection } from '@/features/collection/use-collection';
import { posterUri } from '@/lib/images';
import { compactName } from '@/lib/titles';
import {
  Button,
  EmptyState,
  FilterChip,
  ScoreBadge,
  SegmentedTabs,
  Sheet,
  SkeletonRow,
  Text,
  TitleRow,
} from '@/ui/components';
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
 * The four orders this sheet offers, and there are deliberately only four.
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
 * ---------------------------------------------------------------------------
 * WHY RANK IS STILL THE DEFAULT
 *
 * Unchanged from the note below: the wall above this sheet shows the best six, and the
 * question a reader has after seeing it is what comes seventh.
 */
export type CollectionSort = 'rank-desc' | 'rank-asc' | 'ranked-newest' | 'ranked-oldest';

const SORTS: readonly { key: CollectionSort; label: string }[] = [
  { key: 'rank-desc', label: 'Highest first' },
  { key: 'rank-asc', label: 'Lowest first' },
  { key: 'ranked-newest', label: 'Newest first' },
  { key: 'ranked-oldest', label: 'Oldest first' },
];

/** What the chip says while a menu is closed, so the current order is always on screen. */
const SORT_CHIP: Record<CollectionSort, string> = {
  'rank-desc': 'Rank · Highest first',
  'rank-asc': 'Rank · Lowest first',
  'ranked-newest': 'Recently ranked · Newest first',
  'ranked-oldest': 'Recently ranked · Oldest first',
};

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
  return (a: { position: number; rankedAt: string | null; mediaItemId: string },
          b: { position: number; rankedAt: string | null; mediaItemId: string }): number => {
    const tiebreak = a.mediaItemId.localeCompare(b.mediaItemId);

    // Position 1 is the top of the band, so "highest first" is ascending.
    if (sort === 'rank-desc') return a.position - b.position || tiebreak;
    if (sort === 'rank-asc') return b.position - a.position || tiebreak;

    if (!a.rankedAt && !b.rankedAt) return tiebreak;
    if (!a.rankedAt) return 1;
    if (!b.rankedAt) return -1;

    const byDate =
      sort === 'ranked-newest'
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
  const list = category === 'tv_seasons' ? seasons : movies;

  const [sort, setSort] = useState<CollectionSort>('rank-desc');
  const [sortOpen, setSortOpen] = useState(false);
  const scroll = useRef<ScrollView>(null);

  const rows = useMemo(() => {
    const entries = list.data ?? [];
    // **The band is measured over the whole category, the slice is what gets drawn.**
    // Scoring against the visible slice would give the top row a 10 whatever it is
    // (`TopRanked` records the same rule), so `bandSizes` sees everything and the cap is
    // applied afterwards.
    const sizes = bandSizes(entries);
    // **Sorted before the cap, never after.** A cap applied first would make each order a
    // re-arrangement of the same two hundred titles rather than the first two hundred of
    // that order — so "Oldest first" would silently mean "oldest of their most recent
    // two hundred", which is a different and wrong claim.
    return [...entries]
      .sort(compareBySort(sort))
      .slice(0, VISIBLE_CAP)
      .map((entry) => ({
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
        score: scoreFor(entry.bucket, entry.position, sizes),
        bucket: entry.bucket,
      }));
  }, [list.data, sort]);

  /** How many the category actually holds, for the disclosure under a capped list. */
  const total = list.data?.length ?? 0;

  if (!category) return null;

  const whose = isSelf ? 'Your collection' : `${name}'s collection`;

  return (
    <Sheet visible onClose={onClose} label={whose}>
      <View style={styles.head}>
        <Text variant="title2">{whose}</Text>
      </View>

      {/* Movies and TV are separate rankings and a position only means anything inside
          its own category (PRD §11), so this switches between two lists rather than
          filtering one. Same control and same words as the wall above it. */}
      <View style={styles.tabs}>
        <SegmentedTabs
          options={[
            { id: 'movies' as const, label: 'Movies' },
            { id: 'tv_seasons' as const, label: 'TV' },
          ]}
          value={category}
          onChange={onChangeCategory}
        />
      </View>

      {/**
        * **The sort control that replaced "In rank order."** (founder, 2026-08-29).
        *
        * A subtitle stating the order is a subtitle nobody can act on. This is the same
        * chip-and-menu the Collection tab has used since it had sorting — `FilterChip`
        * naming the current order, a radio list under it — rather than a second grammar
        * for the same idea on a second screen. Four options, no filters, no third axis:
        * the founder scoped this pass to exactly these.
        *
        * The chip says the whole order ("Rank · Highest first") and not just the axis,
        * because the direction is half the answer and a control that hides half of what
        * it is doing is the subtitle again with a chevron on it.
        */}
      <View style={styles.sortRow}>
        <FilterChip
          icon="swap-vertical-outline"
          label={SORT_CHIP[sort]}
          accessibilityLabel={`Sort. ${SORT_CHIP[sort]}`}
          onPress={() => setSortOpen((open) => !open)}
        />
      </View>

      {sortOpen ? (
        <View style={styles.sortMenu}>
          {SORTS.map((option) => (
            <Pressable
              key={option.key}
              accessibilityRole="radio"
              accessibilityState={{ selected: option.key === sort }}
              accessibilityLabel={SORT_CHIP[option.key]}
              onPress={() => {
                setSortOpen(false);
                setSort(option.key);
                // **Back to the top on every change.** A `ScrollView` keeps its offset
                // when its children are replaced, so a reader two hundred rows down would
                // be dropped into the middle of an order they have not seen the start of.
                scroll.current?.scrollTo({ y: 0, animated: false });
              }}
              style={({ pressed }) => [
                styles.sortOption,
                option.key === sort && styles.sortSelected,
                pressed && styles.sortPressed,
              ]}
            >
              <Text variant="callout" tone={option.key === sort ? 'inverse' : 'primary'}>
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <ScrollView ref={scroll} style={styles.list} contentContainerStyle={styles.listContent}>
        {list.isPending ? (
          <SkeletonRow count={4} />
        ) : list.isError ? (
          <View style={styles.empty}>
            <EmptyState
              kind="couldNotLoad"
              compact
              title="Could not load the list"
              body="Check your connection and try again."
              action={{ label: 'Try again', onPress: () => void list.refetch() }}
            />
          </View>
        ) : rows.length === 0 ? (
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
                  <Text variant="caption" tone="tertiary" style={styles.ordinal}>
                    {`#${row.position}`}
                  </Text>
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
                This is a `ScrollView` and every row it holds is mounted at once —
                `FollowListSheet` records why a virtualised list cannot be used here: a
                `FlatList` inside a `maxHeight: 90%` container measures to zero. So the
                render is bounded, as the 200-row server page this replaced already
                bounded it, and a reader with more than that is told so instead of
                silently shown a prefix. Their whole collection is still what the band
                and the scores were computed from. */}
            {total > VISIBLE_CAP ? (
              <Text variant="footnote" tone="secondary" style={styles.truncation}>
                {/* "Their top 200" was true while rank was the only order and is a wrong
                    claim under "Oldest first". The bound is what has to be said; which
                    end of which order it cuts is on screen already. */}
                {`Showing ${VISIBLE_CAP} of ${total}.`}
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>

      <View style={styles.actions}>
        <Button label="Close" kind="secondary" onPress={onClose} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
    paddingBottom: theme.space[3],
    gap: theme.space[1],
  },
  tabs: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[3] },
  sortRow: {
    flexDirection: 'row',
    paddingHorizontal: theme.layout.gutter,
    paddingBottom: theme.space[3],
  },
  // The Collection tab's own menu, to the point: a raised card of radio rows under the
  // chip that opened it, rather than a sheet inside a sheet.
  sortMenu: {
    marginHorizontal: theme.layout.gutter,
    marginBottom: theme.space[3],
    borderRadius: theme.radius.card,
    backgroundColor: theme.surface.raised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border.hairline,
    overflow: 'hidden',
  },
  sortOption: { paddingHorizontal: theme.space[3], paddingVertical: theme.space[2] },
  sortSelected: { backgroundColor: theme.semantic.action },
  sortPressed: { opacity: 0.6 },
  // Wide enough for "#100" so the posters keep an unbroken left edge however deep the
  // list goes — a column that resizes per row is the ragged one.
  ordinal: { minWidth: 34 },
  // Bounded so a large collection does not push Close off a sheet already capped at
  // 90% of the screen (GoalTitlesSheet's arrangement, for the same reason).
  list: { maxHeight: 380 },
  listContent: { paddingBottom: theme.space[2] },
  truncation: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
  empty: { paddingHorizontal: theme.layout.gutter },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[2],
  },
});
