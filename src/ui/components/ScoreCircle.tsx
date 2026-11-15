import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { formatScore } from '@/features/collection/score';

import { theme } from '../tokens';
import { ScoreBadge, scoreBadgeMetrics } from './ScoreBadge';
import { Text } from './Text';

export type ScoreCircleVariant = 'filled' | 'outlined';

export type ScoreCircleProps = {
  /** Null draws the placeholder (a dash), never an empty or zero circle. */
  score: number | null;
  /** `filled`: the reader's own explicit score. `outlined`: anything else. */
  variant: ScoreCircleVariant;
  /** The words under the circle: "Your score", "Season Average", "bingd". */
  label: string;
  /** One quiet line under the label. Optional; the title page uses none. */
  caption?: string;
  /** The number is on its way. Draws the placeholder and says "Score loading". */
  loading?: boolean;
  onPress?: () => void;
  /** The whole unit's spoken name. Defaults to label, caption and value. */
  accessibilityLabel?: string;
  testID?: string;
  // ---- Optional extensions (adding optional props keeps the contract) ----
  /** A count printed after the label in tertiary ink: `bingd (4)`. Null prints nothing. */
  count?: number | null;
  /** `row` sets the circle beside its label: the title page's stacked, narrow layout. */
  layout?: 'column' | 'row';
  accessibilityHint?: string;
  /** The cell's own frame (flex share, dividers). Never the circle's shape. */
  style?: StyleProp<ViewStyle>;
};

const DASH = '—';

/**
 * **One score, one circle, one label** — every metric on the title page (FU1113-B).
 *
 * The reader's own score, a season average, bingd's and Following's are all this
 * component, so they share one diameter (`scoreBadge.md`), one 2pt ring and one type
 * setting by construction rather than by agreement:
 *
 *   `filled`    Maroon disc, Parchment numerals — the reader's own explicit ranking.
 *   `outlined`  Maroon ring, Maroon numerals — a season average, the community, Following.
 *
 * **It stays a circle at every text size.** The diameter and the numerals scale together
 * (`ScoreBadge.metrics`, capped at 130%), and the circle sits in a slot of exactly that
 * diameter that may not shrink, so a narrow cell or a row layout can squeeze the label
 * but never the circle into an oval. Nothing but the number goes inside it — no `AVG`.
 *
 * A score that does not exist is the existing placeholder: a tertiary dash in the same
 * slot, so the labels of a row of these still share a baseline.
 */
export function ScoreCircle({
  score,
  variant,
  label,
  caption,
  loading = false,
  onPress,
  accessibilityLabel,
  testID,
  count,
  layout = 'column',
  accessibilityHint,
  style,
}: ScoreCircleProps) {
  const { diameter } = scoreBadgeMetrics('md');
  const row = layout === 'row';
  const value = score != null ? formatScore(score) : null;
  const spoken =
    accessibilityLabel ??
    [label, caption, value ? `${value} out of 10` : loading ? 'Score loading' : 'No score yet']
      .filter(Boolean)
      .join('. ');

  const body: ReactNode = (
    <>
      <View
        testID={testID ? `${testID}-circle-slot` : undefined}
        style={[styles.slot, { width: diameter, height: diameter }]}
      >
        {score != null ? (
          <ScoreBadge score={score} bucket={null} size="md" variant={variant} />
        ) : (
          <Text variant="headline" tone="tertiary" numberOfLines={1}>
            {DASH}
          </Text>
        )}
      </View>
      <View style={row ? styles.textRow : styles.textColumn}>
        <Text
          variant="footnote"
          tone="secondary"
          numberOfLines={2}
          style={row ? styles.labelRow : styles.label}
          testID={testID ? `${testID}-label` : undefined}
        >
          {label}
          {count != null ? (
            <Text variant="footnote" tone="tertiary">{` (${count})`}</Text>
          ) : null}
        </Text>
        {caption ? (
          <Text
            variant="caption"
            tone="tertiary"
            numberOfLines={2}
            style={row ? styles.labelRow : styles.label}
            testID={testID ? `${testID}-caption` : undefined}
          >
            {caption}
          </Text>
        ) : null}
      </View>
    </>
  );

  const frame = [styles.unit, row && styles.unitRow, style];

  if (!onPress) {
    return (
      <View testID={testID} style={frame} accessible accessibilityLabel={spoken}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => [...frame, pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  unit: {
    minHeight: theme.layout.minTapTarget,
    flexDirection: 'column',
    alignItems: 'center',
    gap: theme.space[1],
  },
  unitRow: { flexDirection: 'row', gap: theme.space[3] },
  // Exactly the circle's diameter and never squeezed: this is what keeps it round.
  slot: { flexShrink: 0, flexGrow: 0, alignItems: 'center', justifyContent: 'center' },
  textColumn: { alignSelf: 'stretch', gap: theme.space[1] },
  textRow: { flexShrink: 1, minWidth: 0, gap: theme.space[1] },
  label: { textAlign: 'center', alignSelf: 'stretch' },
  labelRow: { textAlign: 'left' },
  pressed: { opacity: 0.7 },
});
