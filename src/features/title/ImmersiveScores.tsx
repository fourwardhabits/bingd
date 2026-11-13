import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';

import { formatScore } from '@/features/collection/score';
import { averageCaption } from '@/features/collection/show-projection';
import { ScoreBadge, Text } from '@/ui/components';
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
     * **A series' season average** (WS-TVC, founder spec t168u §2): on a series page with
     * no explicit show ranking but ranked seasons, the mean of those seasons — drawn as the
     * outlined `AVG 8.7` with "Average of N ranked seasons" under it, never as the filled
     * circle that means an explicit ranking. Ignored when `score` is present.
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
const DASH = '—';

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
  /** The personal slot's season average, drawn outlined as `AVG` with its caption. */
  average?: { score: number; count: number } | null;
  divided?: boolean;
  stacked?: boolean;
  onPress?: () => void;
  hint?: string;
}) {
  const value = score != null ? formatScore(score) : null;
  const body = (
    <>
      <View style={styles.valueSlot}>
        {/**
         * **One rule for all three** (founder spec §8, 2026-11-13): the reader's own score
         * is a filled Maroon circle with Parchment numerals; bingd's and Following's are a
         * Maroon ring with Maroon numerals; a score that does not exist is a dash, never
         * an empty circle. Presentation only — which number is shown, its sample floor and
         * what it means are decided upstream and are unchanged.
         */}
        {average ? (
          <View testID={`${testID}-average`} style={styles.averageChip}>
            <Text
              variant="headline"
              tone="action"
              numberOfLines={1}
              allowFontScaling={false}
              style={styles.averageValue}
            >
              {`AVG ${formatScore(average.score)}`}
            </Text>
          </View>
        ) : score != null ? (
          <ScoreBadge
            score={score}
            bucket={null}
            size="md"
            variant={prominent ? 'filled' : 'outlined'}
          />
        ) : (
          <Text variant="headline" tone="tertiary" numberOfLines={1}>
            {DASH}
          </Text>
        )}
      </View>
      {/* One line where it fits. At 320pt or a large text size the count may take a
          second line under its label — still centred, never clipped. */}
      <Text
        variant="footnote"
        tone="secondary"
        numberOfLines={2}
        style={stacked ? styles.labelStacked : styles.label}
        testID={`${testID}-label`}
      >
        {label}
        {count != null ? (
          <Text variant="footnote" tone="tertiary">{` (${count})`}</Text>
        ) : null}
      </Text>
      {/* The contextual explanation the founder asked for on the show page (t168u §2). */}
      {average ? (
        <Text
          variant="caption"
          tone="tertiary"
          numberOfLines={2}
          style={stacked ? styles.labelStacked : styles.label}
          testID={`${testID}-caption`}
        >
          {averageCaption(average.count)}
        </Text>
      ) : null}
    </>
  );
  const style = stacked
    ? [styles.cell, styles.cellStacked, divided && styles.dividedStacked]
    : [styles.cell, divided && styles.divided];
  const spoken = [
    spokenLabel ?? label,
    average ? averageCaption(average.count) : null,
    value ? `${value} out of 10` : reason,
    count != null ? ratings(count) : null,
  ]
    .filter(Boolean)
    .join('. ');

  if (!onPress) {
    return (
      <View testID={testID} style={style} accessible accessibilityLabel={spoken}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint={hint}
      onPress={onPress}
      style={({ pressed }) => [...style, pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  );
}

const BADGE = theme.layout.scoreBadge.md;

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
  /** Every value sits in a slot the badge's height, so the three labels share a baseline. */
  valueSlot: { height: BADGE, alignItems: 'center', justifyContent: 'center' },
  averageValue: { fontVariant: ['tabular-nums'] },
  // The season average: outlined Maroon, Maroon numerals, pill-shaped so "AVG" reads as a
  // label on the number, at the badge's own height (WS-TVC).
  averageChip: {
    minHeight: BADGE - theme.space[2],
    paddingHorizontal: theme.space[3],
    borderRadius: theme.radius.full,
    borderWidth: 2,
    borderColor: theme.semantic.score,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { textAlign: 'center', alignSelf: 'stretch' },
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
  labelStacked: { flexShrink: 1, textAlign: 'left' },
  dividedStacked: {
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: theme.border.hairline,
  },
  divided: { borderLeftWidth: StyleSheet.hairlineWidth * 2, borderLeftColor: theme.border.hairline },
  pressed: { opacity: 0.7 },
});
