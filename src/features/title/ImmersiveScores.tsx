import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';

import { formatScore } from '@/features/collection/score';
import { ScoreBadge, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * **The three scores as one compact strip, on the artwork** (Immersive Scroll experiment).
 *
 * The same three values, labels and unavailable states as `ScoresSection`, which the
 * original page keeps; the inputs are the same shape so the title page builds them once.
 * What differs is only the presentation, for a dark cinematic field:
 *
 * - one row in one hairline-framed strip, three cells divided by hairlines — not a beige
 *   card, which would be a block of Paper cut into the artwork;
 * - a score that does not exist is a dash and its existing reason ("Not enough ratings"),
 *   never an empty circle, so a title nobody has rated reads as quiet rather than broken;
 * - the reader's own score, once ranked, is the one filled Maroon badge and the widest
 *   cell. bingd and Following are numbers;
 * - side by side while the three fit, stacked into three rows when they do not — a narrow
 *   phone at a large text size — so a label is never cut to "Your sc…".
 *
 * Parchment on Ink throughout. The field beneath is the artwork under an Ink scrim of at
 * least 0.82, so a white sky reads as dark grey here and contrast holds on bright art.
 */
export type ImmersiveScoresProps = {
  you: { score: number | null; pending?: boolean; onPress?: () => void } | null;
  bingd: { score: number | null; ratingCount: number } | null;
  following: { score: number | null; ratingCount: number } | null;
  onPressFollowing?: () => void;
};

const NOT_ENOUGH = 'Not enough ratings';
const NO_FOLLOWING = 'No ratings yet';
const NOT_RANKED = 'Not ranked yet';
const SCORE_LOADING = 'Score loading';

/** Below this many points of width per unit of text scale, the three cells stack. */
const STACK_BELOW = 290;

const ratings = (count: number) => (count === 1 ? '1 rating' : `${count} ratings`);

export function ImmersiveScores({ you, bingd, following, onPressFollowing }: ImmersiveScoresProps) {
  const { width, fontScale } = useWindowDimensions();
  if (!you && !bingd && !following) return null;
  const youRanked = you?.score != null;
  // Three cells need about 300pt of 1x text; below that, at this text size, they stack.
  const stacked = width / fontScale < STACK_BELOW;

  return (
    <View testID="immersive-scores" style={[styles.strip, stacked && styles.stripStacked]}>
      {you ? (
        <Cell
          testID="immersive-score-you"
          label="Your score"
          score={you.score}
          support={youRanked ? null : you.pending ? SCORE_LOADING : NOT_RANKED}
          prominent={youRanked}
          stacked={stacked}
          onPress={you.onPress}
          hint="Opens your rating options"
        />
      ) : null}
      {bingd ? (
        <Cell
          testID="immersive-score-bingd"
          label="bingd"
          score={bingd.score}
          support={bingd.score != null ? ratings(bingd.ratingCount) : NOT_ENOUGH}
          divided={Boolean(you)}
          stacked={stacked}
        />
      ) : null}
      {following ? (
        <Cell
          testID="immersive-score-following"
          label="Following"
          score={following.score}
          support={following.score != null ? ratings(following.ratingCount) : NO_FOLLOWING}
          divided={Boolean(you || bingd)}
          stacked={stacked}
          onPress={following.ratingCount > 0 && onPressFollowing ? onPressFollowing : undefined}
          hint="Opens the people behind this score"
        />
      ) : null}
    </View>
  );
}

function Cell({
  testID,
  label,
  score,
  support,
  prominent = false,
  divided = false,
  stacked = false,
  onPress,
  hint,
}: {
  stacked?: boolean;
  testID: string;
  label: string;
  score: number | null;
  support: string | null;
  prominent?: boolean;
  divided?: boolean;
  onPress?: () => void;
  hint?: string;
}) {
  const value = score != null ? formatScore(score) : null;
  const body = (
    <>
      {prominent && score != null ? (
        <ScoreBadge score={score} bucket={null} size="md" variant="filled" />
      ) : (
        <Text
          variant="headline"
          tone={value ? 'primary' : 'tertiary'}
          style={value ? styles.value : styles.missing}
          numberOfLines={1}
          // The dash is a picture of "nothing here"; the reason beside it is what is read.
          accessibilityElementsHidden={!value}
          importantForAccessibility={value ? 'auto' : 'no-hide-descendants'}
        >
          {value ?? '–'}
        </Text>
      )}
      <View style={styles.copy}>
        {/* Two lines in either layout: a label is never cut ("Your sc…"), and at a large
            text size on a narrow phone the cell grows rather than truncating. */}
        <Text variant="footnote" tone="secondary" numberOfLines={2}>
          {label}
        </Text>
        {support ? (
          <Text variant="caption" tone="tertiary" numberOfLines={2}>
            {support}
          </Text>
        ) : null}
      </View>
    </>
  );
  const style = stacked
    ? [styles.cell, styles.cellStacked, divided && styles.dividedStacked]
    : [styles.cell, prominent && styles.cellProminent, divided && styles.divided];
  const spoken = [label, value ? `${value} out of 10` : null, support].filter(Boolean).join('. ');

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

const styles = StyleSheet.create({
  /**
   * One row on the module's Paper (Cinematic Editorial, 2026-11-04): no panel of its own,
   * only a hairline above it separating the scores from the actions, and hairlines between
   * the cells. It was a tinted box on the artwork when the words sat on the picture.
   */
  strip: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderTopColor: theme.border.hairline,
    marginHorizontal: -theme.space[3],
  },
  cell: {
    flex: 1,
    minWidth: 0,
    minHeight: theme.layout.minTapTarget,
    // Stacked — value, label, reason — because three cells side by side at 320pt leave
    // about 90pt each, and a reason set beside its value would wrap to three lines.
    flexDirection: 'column',
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
    gap: theme.space[1],
    paddingVertical: theme.space[2] + 2,
    paddingHorizontal: theme.space[3],
  },
  cellProminent: { flex: 1.2 },
  stripStacked: { flexDirection: 'column' },
  cellStacked: { flex: 0, flexDirection: 'row', alignItems: 'center', gap: theme.space[3] },
  dividedStacked: { borderTopWidth: StyleSheet.hairlineWidth * 2, borderTopColor: theme.border.hairline },
  divided: { borderLeftWidth: StyleSheet.hairlineWidth * 2, borderLeftColor: theme.border.hairline },
  value: { fontVariant: ['tabular-nums'], minHeight: theme.layout.scoreBadge.md, textAlignVertical: 'center', lineHeight: theme.layout.scoreBadge.md },
  missing: { minHeight: theme.layout.scoreBadge.md, lineHeight: theme.layout.scoreBadge.md },
  copy: { alignSelf: 'stretch', gap: 1 },
  pressed: { opacity: 0.7 },
});
