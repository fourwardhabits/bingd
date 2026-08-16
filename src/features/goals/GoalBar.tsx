import { StyleSheet, View } from 'react-native';

import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { GOAL_LABEL, goalSentence, type GoalStatus } from './goals';

export type GoalBarProps = {
  status: GoalStatus;
};

/**
 * One medium's progress toward its yearly goal.
 *
 * A bar, and not a ring or a number alone, because the question it answers is "am I
 * on track" and a bar is the only one of the three that can be read at a glance
 * against a full width. The count is stated in words beside it regardless — PRD's
 * accessibility rule that colour and length are never the only signal, and a bar at
 * 23% means nothing without "12 of 52" next to it.
 *
 * The fill is Sage while the goal is open and Amber once it is met. Amber is the
 * milestone colour in design-system.md §3 and this is the one milestone the app has;
 * Sage is "watched, completed, progress" and is what the bar is measuring until then.
 * Neither is ever text.
 */
export function GoalBar({ status }: GoalBarProps) {
  const sentence = goalSentence(status);
  const percent = Math.round(status.fraction * 100);

  return (
    <View
      style={styles.root}
      accessibilityRole="progressbar"
      // Spoken as one thing: "Movies, 12 of 52". Without an explicit label a screen
      // reader reads the two Text children as separate items and the value loses the
      // medium it belongs to.
      accessibilityLabel={`${GOAL_LABEL[status.category]}, ${sentence}`}
      accessibilityValue={{ min: 0, max: status.target, now: status.count, text: sentence }}
    >
      <View style={styles.heading}>
        <Text variant="callout">{GOAL_LABEL[status.category]}</Text>
        <Text variant="footnote" tone="secondary">
          {sentence}
        </Text>
      </View>

      <View style={styles.track} accessibilityElementsHidden importantForAccessibility="no">
        {/* Zero-width would render as a hairline artefact on some Android densities;
            a goal with nothing against it should show an empty track instead. */}
        {percent > 0 ? (
          <View
            style={[
              styles.fill,
              { width: `${percent}%` },
              status.complete && styles.fillComplete,
            ]}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: theme.space[2] },
  heading: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: theme.space[3],
  },
  track: {
    height: 8,
    borderRadius: theme.radius.full,
    backgroundColor: theme.surface.sunken,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: theme.radius.full,
    backgroundColor: theme.semantic.progress,
  },
  fillComplete: { backgroundColor: theme.semantic.emphasis },
});
