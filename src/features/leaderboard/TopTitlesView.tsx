import { StyleSheet, View } from 'react-native';

import { formatScore } from '@/features/collection/score';
import type { Medium } from '@/features/recommendations/use-for-you';
import { posterUri } from '@/lib/images';
import { compactName } from '@/lib/titles';
import {
  Chip,
  Divider,
  EmptyState,
  ScoreBadge,
  SkeletonRow,
  Text,
  TitleRow,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

import type { TopTitle } from './use-top-titles';

export const TOP_TITLES_MEDIA: readonly { value: Medium; label: string }[] = [
  { value: 'movies', label: 'Movies' },
  { value: 'tv', label: 'TV' },
];

export type TopTitlesViewProps = {
  medium: Medium;
  onChangeMedium: (next: Medium) => void;
  titles: readonly TopTitle[] | undefined;
  loading: boolean;
  failed: boolean;
  onPressTitle: (mediaItemId: string) => void;
};

/** `1 rating` or `12 ratings` — the words `ScoresSection` prints under the same number. */
const ratingsLabel = (count: number) => (count === 1 ? '1 rating' : `${count} ratings`);

/**
 * The best-supported titles on bingd., as a board beside the people one (founder,
 * 2026-09-13).
 *
 * ---------------------------------------------------------------------------
 * A SIBLING, AND BUILT FROM THE PEOPLE BOARD'S PARTS
 *
 * The same chip row under the same tab, the same rank column with the same accent on the
 * top three, and nothing the people board ruled out — no medal, no podium, no badge, no
 * confidence label. A reader who has read one board has read both. There is no timeframe:
 * a community score is a standing verdict, not a monthly race, so the screen header's
 * timeframe selector is the people board's alone and is not drawn here.
 *
 * ---------------------------------------------------------------------------
 * THE NUMBER IS BINGD.'S, AND IT IS DRAWN AS SOMEBODY ELSE'S SCORE
 *
 * The trailing badge is `ScoreBadge`'s **outlined** variant, which is the design system's
 * one treatment for a score that is not the reader's own — the title page's `bingd.` unit
 * draws the same ring. A filled badge on this list would say "you gave this 9.2", which is
 * the confusion `screens.md` records as the reason Top Rated's poster wall carries no score
 * at all. Here the number is the point of the surface, so it is shown, in the ring that
 * says whose it is.
 *
 * The sample count sits under the title in the words the title page uses. It is the
 * honest companion to the number: the server has already refused anything below the
 * support floor, and the count says how far above it each title is.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE CLIENT DOES NOT DO
 *
 * Sort, filter, or decide who qualifies. `top_rated_titles` filters by
 * `community_support_floor` and orders the survivors; this draws the rows in the order
 * they arrived and numbers them, sharing a number only where score and support both tie.
 */
export function TopTitlesView({
  medium,
  onChangeMedium,
  titles,
  loading,
  failed,
  onPressTitle,
}: TopTitlesViewProps) {
  const rows = titles ?? [];

  return (
    <View style={styles.body}>
      <View style={styles.chips}>
        {TOP_TITLES_MEDIA.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            selected={option.value === medium}
            onPress={() => onChangeMedium(option.value)}
          />
        ))}
      </View>

      {loading ? (
        <View style={styles.padded}>
          <SkeletonRow count={3} />
        </View>
      ) : failed ? (
        <View style={styles.padded}>
          <EmptyState
            kind="couldNotLoad"
            compact
            title="Could not load top titles"
            body="Pull down to try again in a moment."
          />
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.padded}>
          {/* The For You wall's own empty copy, and for its reason: the threshold is the
              server's and moves with the community, so no figure belongs in the sentence. */}
          <EmptyState
            kind="nothingYet"
            compact
            title="Not enough ratings yet"
            body="Titles appear here once enough people have rated them."
          />
        </View>
      ) : (
        <View>
          {rows.map((row, index) => {
            const name =
              compactName({
                kind: row.kind,
                title: row.title,
                seriesTitle: row.seriesTitle,
                seasonNumber: row.seasonNumber,
              }) ?? row.title;
            const score = formatScore(row.communityScore);
            const ratings = ratingsLabel(row.ratingCount);
            return (
              <View key={row.mediaItemId}>
                {index > 0 ? <Divider /> : null}
                <TitleRow
                  title={name}
                  year={row.year}
                  posterUri={posterUri(row.posterPath)}
                  // The rank column the people board draws, and its top-three accent.
                  leading={
                    <Text
                      variant="callout"
                      tone={row.rank <= 3 ? 'action' : 'tertiary'}
                      style={styles.rank}
                      allowFontScaling={false}
                    >
                      {row.rank}
                    </Text>
                  }
                  secondary={ratings}
                  trailing={<ScoreBadge score={row.communityScore} variant="outlined" />}
                  // Position and score live in `leading` and `trailing`, which the row's
                  // own label cannot see — so both are spoken here, and whose score it is.
                  accessibilityLabel={[
                    `Number ${row.rank}`,
                    name,
                    row.year ? String(row.year) : null,
                    `bingd. score ${score} out of 10`,
                    ratings,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                  onPress={() => onPressTitle(row.mediaItemId)}
                />
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingBottom: theme.space[6] },
  // `LeaderboardView`'s chip row, measure for measure, so switching boards moves nothing.
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[2],
  },
  padded: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[4] },
  rank: { minWidth: 24, textAlign: 'right' },
});
