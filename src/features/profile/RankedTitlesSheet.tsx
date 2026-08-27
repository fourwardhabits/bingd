import { ScrollView, StyleSheet, View } from 'react-native';

import { Button, EmptyState, Sheet, SkeletonRow, Text, TitleRow } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { RANKED_TITLES_PAGE, useRankedTitles } from './use-public-profile';

export type RankedTitlesSheetProps = {
  /** Which count was tapped, or null while the sheet is closed. */
  category: 'movies' | 'tv_seasons' | null;
  userId: string;
  /** The profile's display name, for the header of somebody else's list. */
  name: string;
  isSelf: boolean;
  viewerId: string;
  onPressTitle: (mediaItemId: string) => void;
  onClose: () => void;
};

/**
 * What the number on a profile stat is made of.
 *
 * The same correction `GoalTitlesSheet` records, arrived at from the other side:
 * "Movies · 41" on somebody's profile is a claim the reader could not previously
 * check without already knowing the person's whole collection. Tapping the stat now
 * enumerates it, newest addition first — the order that answers the question a
 * profile visit is actually asking, which is "what have they been adding lately",
 * not "what is their all-time number one" (Top Ranked, further down, already answers
 * that one).
 *
 * **A sheet, not a screen** — `FollowListSheet`'s rule, for the same reason: this is
 * a list you glance at and leave, and every row already leads somewhere real.
 *
 * Privacy is the reading, not the sheet: `rankings` under `rankings_read` is all this
 * can enumerate, which is exactly what produced the count it explains. Logged-only
 * titles are owner-private by policy and are neither counted there nor listed here.
 */
export function RankedTitlesSheet({
  category,
  userId,
  name,
  isSelf,
  viewerId,
  onPressTitle,
  onClose,
}: RankedTitlesSheetProps) {
  const titles = useRankedTitles(viewerId, category ? userId : null, category);

  if (!category) return null;

  // "TV" keeps its capitals in the possessive form — lowercasing the label works for
  // "Your movies" and produces "Your tv", so the self heading is spelt out per case.
  const what = category === 'movies' ? 'Movies' : 'TV';
  const whose = isSelf ? (category === 'movies' ? 'Your movies' : 'Your TV') : `${name} · ${what}`;

  return (
    <Sheet visible onClose={onClose} label={`${whose}, newest first`}>
      <View style={styles.head}>
        <Text variant="title2">{whose}</Text>
        <Text variant="footnote" tone="secondary">
          Newest first.
        </Text>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {titles.isPending ? (
          <SkeletonRow count={4} />
        ) : titles.isError ? (
          <View style={styles.empty}>
            <EmptyState
              kind="couldNotLoad"
              compact
              title="Could not load the list"
              body="Check your connection and try again."
              action={{ label: 'Try again', onPress: () => void titles.refetch() }}
            />
          </View>
        ) : (titles.data?.length ?? 0) === 0 ? (
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
            {titles.data!.map((title) => (
              <TitleRow
                key={title.mediaItemId}
                title={title.title}
                year={title.year}
                posterUri={title.posterUri}
                divided
                onPress={() => onPressTitle(title.mediaItemId)}
              />
            ))}
            {/* A full page means the read hit its cap, and the stat this sheet opened
                from is not capped — so the truncation is said rather than left for the
                reader to discover by counting (review 60). */}
            {titles.data!.length >= RANKED_TITLES_PAGE ? (
              <Text variant="footnote" tone="secondary" style={styles.truncation}>
                Showing the newest {RANKED_TITLES_PAGE}.
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
  // Bounded so a large collection does not push Close off a sheet already capped at
  // 90% of the screen (GoalTitlesSheet's arrangement, for the same reason).
  list: { maxHeight: 380 },
  listContent: { paddingBottom: theme.space[2] },
  truncation: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
  },
  empty: { paddingHorizontal: theme.layout.gutter },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[2],
  },
});
