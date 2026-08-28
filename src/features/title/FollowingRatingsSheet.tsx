import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Avatar, Button, EmptyState, ScoreBadge, Sheet, SkeletonRow, Text } from '@/ui/components';
import { fontFamily, theme } from '@/ui/tokens';

import { useFollowingRatings, type FollowingRating } from './use-following-ratings';

export type FollowingRatingsSheetProps = {
  /** The title whose Following score was tapped, or null to close. */
  mediaItemId: string | null;
  /** The title's name, for the sheet label. */
  titleName: string;
  viewerId: string;
  /** Row tap → that person's profile. The sheet closes first (`FollowListSheet`'s rule). */
  onPressPerson: (username: string) => void;
  onClose: () => void;
};

/**
 * Who, of the people I follow, rated this — and how far I trust each of them.
 *
 * The founder's sentence for §13, drawn as `FollowListSheet`'s grammar: identity on
 * the left as the tap target, the judgment on the right. The right column is this
 * surface's whole reason to exist — their score for the title, over the Match that
 * says how much weight their opinion has earned with this viewer.
 *
 * A sheet, not a screen, for `FollowListSheet`'s reason verbatim: you open it, see
 * who liked it, maybe visit one profile, and go back to the film.
 *
 * The rows come ordered from `following_ratings` — trustworthy Match first, then
 * their rating, then username — and are not re-sorted here: one deterministic order,
 * owned by the function that also owns the visibility predicate.
 *
 * "Match TBD" is the below-threshold answer, printed in the muted tone a fact this
 * thin deserves. Never a number invented to fill the column (§16), and never blank —
 * a blank right column under a neighbour's "82% Match" reads as an error rather than
 * as an absence.
 */
export function FollowingRatingsSheet({
  mediaItemId,
  titleName,
  viewerId,
  onPressPerson,
  onClose,
}: FollowingRatingsSheetProps) {
  const ratings = useFollowingRatings(mediaItemId, viewerId);

  if (!mediaItemId) return null;

  return (
    <Sheet visible onClose={onClose} label={`People you follow who rated ${titleName}`}>
      <View style={styles.head}>
        <Text variant="title2">Following</Text>
        <Text variant="footnote" tone="secondary">
          Their scores for {titleName}.
        </Text>
      </View>

      {ratings.isPending ? (
        <View style={styles.pad}>
          <SkeletonRow count={3} />
        </View>
      ) : ratings.isError ? (
        <View style={styles.pad}>
          <EmptyState
            kind="couldNotLoad"
            compact
            title="Could not load these"
            body="Check your connection and try again."
            action={{ label: 'Try again', onPress: () => void ratings.refetch() }}
          />
        </View>
      ) : (ratings.data?.length ?? 0) === 0 ? (
        // Reachable when the score refetches to zero behind an open sheet — a
        // followee unranked it, or a block landed. The copy states the population,
        // not an apology.
        <View style={styles.pad}>
          <EmptyState
            kind="nothingYet"
            compact
            title="Nobody yet"
            body="No one you follow has ranked this."
          />
        </View>
      ) : (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {ratings.data!.map((row) => (
            <RatingRow key={row.userId} row={row} onPress={() => onPressPerson(row.username)} />
          ))}
          {/* The function caps at 50, and a full page is the one case where the
              aggregate may count people this list does not show. Said rather than
              implied — a list that silently disagrees with the number it explains
              is review 66's Minor 4. */}
          {ratings.data!.length === 50 ? (
            <Text variant="footnote" tone="tertiary" style={styles.truncated}>
              The 50 strongest matches. The score averages everyone.
            </Text>
          ) : null}
        </ScrollView>
      )}

      {/* The labelled way out every sheet carries — `Sheet` hides its scrim from the
          accessibility tree on the understanding that this exists. */}
      <View style={styles.foot}>
        <Button label="Done" onPress={onClose} />
      </View>
    </Sheet>
  );
}

function RatingRow({ row, onPress }: { row: FollowingRating; onPress: () => void }) {
  const match = row.matchScore != null ? `${row.matchScore}% Match` : 'Match TBD';

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[
          row.name,
          `@${row.username}`,
          `rated it ${row.score.toFixed(1)} out of 10`,
          match,
        ].join(', ')}
        accessibilityHint="Opens their profile"
        onPress={onPress}
        style={({ pressed }) => [styles.identity, pressed && styles.pressed]}
      >
        <Avatar size="sm" uri={row.avatarUri} name={row.name} />
        <View style={styles.copy}>
          <Text variant="callout" numberOfLines={1} style={styles.name}>
            {row.name}
          </Text>
          <Text variant="caption" tone="tertiary" numberOfLines={1}>
            @{row.username}
          </Text>
        </View>
      </Pressable>

      {/* The judgment column: their number for this film over the trust behind their
          numbers generally. Hidden from the reader's screen reader as separate stops —
          both facts are in the identity's one announcement above. */}
      <View style={styles.verdict} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <ScoreBadge score={row.score} bucket={null} size="sm" />
        <Text
          variant="caption"
          tone={row.matchScore != null ? 'action' : 'tertiary'}
          numberOfLines={1}
        >
          {match}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[2], gap: 2 },
  pad: { paddingHorizontal: theme.layout.gutter, paddingVertical: theme.space[4] },
  list: { maxHeight: 420 },
  listContent: { paddingBottom: theme.space[2] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingVertical: theme.space[2],
    minHeight: theme.layout.rowMinHeight,
  },
  identity: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  copy: { flex: 1, gap: 2 },
  name: { fontFamily: fontFamily.sansSemibold },
  verdict: { alignItems: 'flex-end', gap: 2 },
  truncated: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
  foot: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
  pressed: { opacity: 0.7 },
});
