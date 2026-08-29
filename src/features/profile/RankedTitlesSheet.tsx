import { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { bandSizes, scoreFor } from '@/features/collection/score';
import { useRankedCollection } from '@/features/collection/use-collection';
import { posterUri } from '@/lib/images';
import { compactName } from '@/lib/titles';
import {
  Button,
  EmptyState,
  ScoreBadge,
  SegmentedTabs,
  Sheet,
  SkeletonRow,
  Text,
  TitleRow,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

export type RankedCategory = 'movies' | 'tv_seasons';

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
 * `useRankedCollection`, which is **the query `TopRanked` already ran** to build the
 * wall on the profile behind this sheet — same key, same cache entry, so opening this
 * issues no request at all. It replaced a second, sheet-only read of `rankings` ordered
 * by `created_at` and capped at 200; that read is gone rather than left beside this one,
 * and with it the "Showing the newest 200" truncation notice that cap needed.
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
  // Both categories, because the control below switches between them without closing —
  // and because the profile behind this sheet has already asked for both, so neither is
  // a new request. `enabled` keeps a closed sheet from warming anything by itself.
  const movies = useRankedCollection(userId, 'movies', { enabled: Boolean(category) });
  const seasons = useRankedCollection(userId, 'tv_seasons', { enabled: Boolean(category) });
  const list = category === 'tv_seasons' ? seasons : movies;

  const rows = useMemo(() => {
    const entries = list.data ?? [];
    const sizes = bandSizes(entries);
    return entries.map((entry) => ({
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
  }, [list.data]);

  if (!category) return null;

  const whose = isSelf ? 'Your collection' : `${name}'s collection`;

  return (
    <Sheet visible onClose={onClose} label={`${whose}, in rank order`}>
      <View style={styles.head}>
        <Text variant="title2">{whose}</Text>
        <Text variant="footnote" tone="secondary">
          In rank order.
        </Text>
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

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
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
          rows.map((row) => (
            <TitleRow
              key={row.mediaItemId}
              title={row.title}
              year={row.year}
              posterUri={row.posterUri}
              // The ordinal leads the row, because it is what the order means. Tertiary
              // ink and caption weight: it labels the row rather than competing with the
              // score, which is the number a reader is actually scanning for.
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
          ))
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
  // Wide enough for "#100" so the posters keep an unbroken left edge however deep the
  // list goes — a column that resizes per row is the ragged one.
  ordinal: { minWidth: 34 },
  // Bounded so a large collection does not push Close off a sheet already capped at
  // 90% of the screen (GoalTitlesSheet's arrangement, for the same reason).
  list: { maxHeight: 380 },
  listContent: { paddingBottom: theme.space[2] },
  empty: { paddingHorizontal: theme.layout.gutter },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[2],
  },
});
