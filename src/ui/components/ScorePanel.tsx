import { StyleSheet, View } from 'react-native';

import type { Bucket } from '@/features/collection/score';

import { theme } from '../tokens';
import { ScoreBadge } from './ScoreBadge';
import { Text } from './Text';

export type ScorePanelProps = {
  /** The signed-in user's own score, or null when they have not ranked it. */
  yourScore?: number | null;
  yourBucket?: Bucket | null;
  /** Opens the log sheet from the unranked badge. */
  onRank?: () => void;
  /**
   * Where this sits in their own list — `#3 in Movies`. An ordinal, and only ever
   * described as one.
   */
  ordinal?: string | null;
  community?: {
    score: number | null;
    ratingCount: number;
    minRatings: number;
  } | null;
};

/**
 * Your score beside everyone else's (founder amendment, 2026-08-16).
 *
 * Beli's comparison of your rating against the room is the thing being borrowed, and
 * the two numbers are deliberately given equal visual weight and different labels.
 * The one the reader owns is on the left, where a first glance lands.
 *
 * **The community figure is never called a rank.** It is a mean, and calling an
 * average a "community rank" would be a made-up ordinal — the founder's words, and
 * the reason the personal ordinal below it is a separate line saying what it actually
 * is. `#3 in Movies` is a rank because there is a list it is third in.
 *
 * Below the sample threshold the count shows and the number does not. That is the
 * honest shape: "2 ratings" tells a reader exactly how much to trust what they are
 * looking at, where a mean of two would tell them nothing while looking like data.
 */
export function ScorePanel({
  yourScore,
  yourBucket,
  onRank,
  ordinal,
  community,
}: ScorePanelProps) {
  return (
    <View style={styles.panel}>
      <View style={styles.column}>
        <ScoreBadge score={yourScore} bucket={yourBucket} size="lg" onPress={onRank} />
        <Text variant="caption" tone="secondary">
          Your score
        </Text>
        {ordinal ? (
          <Text variant="caption" tone="tertiary" numberOfLines={1}>
            {ordinal}
          </Text>
        ) : null}
      </View>

      {community ? (
        <View style={styles.column}>
          {community.score != null ? (
            <View style={styles.communityBadge}>
              <Text variant="score" style={styles.communityNumber} allowFontScaling={false}>
                {community.score.toFixed(1)}
              </Text>
            </View>
          ) : (
            // Not a dashed ring: that shape means "you have not ranked this", and
            // this column is not about the reader at all.
            <View style={[styles.communityBadge, styles.thin]}>
              <Text variant="caption" tone="tertiary" allowFontScaling={false}>
                —
              </Text>
            </View>
          )}
          <Text variant="caption" tone="secondary">
            Community
          </Text>
          <Text variant="caption" tone="tertiary" numberOfLines={1}>
            {ratingsLabel(community)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** "12 ratings", or what is missing before there can be a number. */
function ratingsLabel({
  ratingCount,
  minRatings,
  score,
}: NonNullable<ScorePanelProps['community']>) {
  if (ratingCount === 0) return 'No ratings yet';
  if (score == null) {
    const needed = Math.max(minRatings - ratingCount, 1);
    return `${ratingCount} so far · ${needed} more`;
  }
  return ratingCount === 1 ? '1 rating' : `${ratingCount} ratings`;
}

const BADGE = theme.layout.scoreBadge.lg;

const styles = StyleSheet.create({
  panel: {
    flexDirection: 'row',
    gap: theme.space[6],
  },
  column: { alignItems: 'center', gap: theme.space[1] },
  /**
   * Outlined where the user's own badge is filled.
   *
   * The two numbers mean different things and must not read as two of the same
   * thing: one is the reader's judgement and one is a summary of other people's.
   * Filled versus outlined says that without a second colour, which the palette
   * does not have to spend (design-system.md §1).
   */
  communityBadge: {
    width: BADGE,
    height: BADGE,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: theme.semantic.action,
    backgroundColor: theme.surface.sunken,
  },
  thin: { borderWidth: 1, borderColor: theme.border.strong },
  communityNumber: { color: theme.semantic.action, fontSize: 19, lineHeight: 22 },
});
