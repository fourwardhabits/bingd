import { StyleSheet, View, useWindowDimensions } from 'react-native';

import { formatScore } from '@/features/collection/score';
import { averageCaption } from '@/features/collection/show-projection';
import { ScoreCircle } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * **The three scores as one compact row on the module's Paper** (Cinematic Editorial).
 *
 * Post-QA sprint 2 (2026-11-05) reworked the row, not the scores behind it:
 *
 *        (8.4)            (8.7)            —
 *     Your score       bingd (4)     Following (0)
 *
 * - three columns of exactly equal width, each value centred with its label centred
 *   directly beneath it, and the same padding above and below the row;
 * - the reader's own score is the filled Maroon circle once ranked; bingd and Following
 *   are the outlined Maroon ring with Maroon numerals where a score exists (founder spec
 *   §8, 2026-11-13 — they were bare numbers until then);
 * - the label carries the real **rating** count in brackets, as the server reports it,
 *   and only once it has reported it — never a 0 drawn while the number is loading;
 * - a score that does not exist is a dash. Its reason ("Not enough ratings", "No ratings
 *   from people you follow", "Not ranked yet", "Score loading") is what a screen reader
 *   says for that column — it is no longer printed as a second, wrapping line;
 * - while the three fit side by side they do; a narrow phone at a large text size
 *   stacks them into rows, so nothing is ever clipped.
 */
export type ImmersiveScoresProps = {
  you: {
    score: number | null;
    pending?: boolean;
    onPress?: () => void;
    /**
     * **A series' season average** (WS-TVC, founder spec t168u §2; FU1113-B): on a series
     * page with no explicit show ranking but ranked seasons, the mean of those seasons —
     * drawn as the outlined circle labelled `SEASON_AVERAGE`, never as the filled circle
     * that means an explicit ranking (founder QA 11-14 §4: the label was "Season Average").
     * The season count is spoken, not printed. Ignored when `score` is present.
     */
    average?: { score: number; count: number } | null;
  } | null;
  /**
   * `ratingCount` is null when the server has not given one; `loading` says it is still
   * being asked, which is the only time the column says "Loading".
   */
  bingd: { score: number | null; ratingCount: number | null; loading?: boolean } | null;
  following: { score: number | null; ratingCount: number | null; loading?: boolean } | null;
  onPressFollowing?: () => void;
};

const NOT_ENOUGH = 'Not enough ratings yet';
const NO_FOLLOWING = 'No ratings yet from people you follow';
const NOT_RANKED = 'Not ranked yet';
const SCORE_LOADING = 'Score loading';
const COUNT_LOADING = 'Loading';
/** The personal slot's label when its number is the mean of ranked seasons. */
const SEASON_AVERAGE = 'Your score (SN avg)';

/** Below this many points of width per unit of text scale, the three cells stack. */
const STACK_BELOW = 290;

const ratings = (count: number) => (count === 1 ? '1 rating' : `${count} ratings`);

export function ImmersiveScores({ you, bingd, following, onPressFollowing }: ImmersiveScoresProps) {
  const { width, fontScale } = useWindowDimensions();
  if (!you && !bingd && !following) return null;
  const youRanked = you?.score != null;
  const youAverage = !youRanked && you?.average ? you.average : null;
  // Three columns need about 300pt of 1x text; below that, at this text size, they stack.
  const stacked = width / fontScale < STACK_BELOW;

  return (
    <View testID="immersive-scores" style={[styles.strip, stacked && styles.stripStacked]}>
      {you ? (
        <Cell
          testID="immersive-score-you"
          label="Your score"
          score={youRanked ? you.score : (youAverage?.score ?? null)}
          reason={youRanked || youAverage ? null : you.pending ? SCORE_LOADING : NOT_RANKED}
          prominent={youRanked}
          average={youAverage}
          stacked={stacked}
          onPress={you.onPress}
          hint={youRanked || you.pending ? 'Opens your rating options' : 'Ranks this title'}
        />
      ) : null}
      {bingd ? (
        <Cell
          testID="immersive-score-bingd"
          label="bingd"
          spokenLabel="bingd score"
          count={bingd.ratingCount}
          score={bingd.score}
          reason={
            bingd.score != null ? null : bingd.loading ? COUNT_LOADING : NOT_ENOUGH
          }
          divided={Boolean(you)}
          stacked={stacked}
        />
      ) : null}
      {following ? (
        <Cell
          testID="immersive-score-following"
          label="Following"
          spokenLabel="People you follow"
          count={following.ratingCount}
          score={following.score}
          reason={
            following.score != null ? null : following.loading ? COUNT_LOADING : NO_FOLLOWING
          }
          divided={Boolean(you || bingd)}
          stacked={stacked}
          onPress={
            (following.ratingCount ?? 0) > 0 && onPressFollowing ? onPressFollowing : undefined
          }
          hint="Opens the people behind this score"
        />
      ) : null}
    </View>
  );
}

function Cell({
  testID,
  label,
  spokenLabel,
  count,
  score,
  reason,
  prominent = false,
  average = null,
  divided = false,
  stacked = false,
  onPress,
  hint,
}: {
  testID: string;
  label: string;
  /** What a screen reader says for the label, where the printed one is a wordmark. */
  spokenLabel?: string;
  /** The rating count, or null while unknown; absent for the reader's own column. */
  count?: number | null;
  score: number | null;
  /** Why there is no number — spoken, never printed. */
  reason: string | null;
  prominent?: boolean;
  /** The personal slot's season average: outlined, labelled `SEASON_AVERAGE`. */
  average?: { score: number; count: number } | null;
  divided?: boolean;
  stacked?: boolean;
  onPress?: () => void;
  hint?: string;
}) {
  const shown = average ? average.score : score;
  const value = shown != null ? formatScore(shown) : null;
  /**
   * **One `ScoreCircle` for all four states** (FU1113-B): yours filled; a season average,
   * bingd and Following outlined; a missing score the dash. The season average is the
   * same circle with `SEASON_AVERAGE` under it — no `AVG` inside the circle and no
   * "Average of N ranked seasons" paragraph. How many seasons it averages is still said,
   * to a screen reader, where it costs the sighted layout nothing.
   */
  const printed = average ? SEASON_AVERAGE : label;
  const spoken = [
    average ? SEASON_AVERAGE : (spokenLabel ?? label),
    average ? averageCaption(average.count) : null,
    value ? `${value} out of 10` : reason,
    count != null ? ratings(count) : null,
  ]
    .filter(Boolean)
    .join('. ');
  const style = stacked
    ? [styles.cell, styles.cellStacked, divided && styles.dividedStacked]
    : [styles.cell, divided && styles.divided];

  return (
    <ScoreCircle
      testID={testID}
      score={shown}
      variant={prominent ? 'filled' : 'outlined'}
      label={printed}
      count={count}
      layout={stacked ? 'row' : 'column'}
      accessibilityLabel={spoken}
      accessibilityHint={onPress ? hint : undefined}
      onPress={onPress}
      style={style}
    />
  );
}

const styles = StyleSheet.create({
  /**
   * One row on the module's Paper: a hairline above it separating the scores from the
   * actions, and hairlines between the columns. It is the module's last row, so it
   * cancels the module's bottom padding and sets its own — 12pt above and below the
   * columns' contents, which is what makes the row sit balanced on the hairline.
   */
  strip: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: theme.border.hairline,
    marginHorizontal: -theme.space[3],
    marginBottom: -theme.space[3],
  },
  cell: {
    // Equal thirds whatever the contents: basis 0, so a longer label cannot widen its own.
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    minHeight: theme.layout.minTapTarget,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: theme.space[1],
    paddingVertical: theme.space[3],
    paddingHorizontal: theme.space[1],
  },
  stripStacked: { flexDirection: 'column' },
  cellStacked: {
    flexGrow: 0,
    flexBasis: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingVertical: theme.space[2],
    paddingHorizontal: theme.space[3],
  },
  dividedStacked: {
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: theme.border.hairline,
  },
  divided: { borderLeftWidth: StyleSheet.hairlineWidth * 2, borderLeftColor: theme.border.hairline },
});
