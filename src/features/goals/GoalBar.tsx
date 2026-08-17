import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { GOAL_LABEL, goalSentence, type GoalStatus } from './goals';

export type GoalBarProps = {
  status: GoalStatus;
  /**
   * Opens the titles behind the number.
   *
   * Optional, because the bar is also a plain readout in places that have nothing to
   * open — and a row that looks tappable and is not is worse than one that never
   * offered.
   */
  onPress?: () => void;
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
export function GoalBar({ status, onPress }: GoalBarProps) {
  const sentence = goalSentence(status);
  const percent = Math.round(status.fraction * 100);

  const body = (
    <>
      <View style={styles.heading}>
        <Text variant="callout" style={styles.label}>
          {GOAL_LABEL[status.category]}
        </Text>
        <Text variant="footnote" tone="secondary">
          {sentence}
        </Text>
        {/* Only where there is something to open, and small: the bar is the content
            and the chevron is a hint about it. */}
        {onPress ? (
          <Ionicons
            name="chevron-forward"
            size={theme.layout.icon.sm}
            color={theme.text.tertiary}
          />
        ) : null}
      </View>

      <View style={styles.track} accessibilityElementsHidden importantForAccessibility="no">
        {/* Zero-width would render as a hairline artefact on some Android densities;
            a goal with nothing against it should show an empty track instead. */}
        {percent > 0 ? (
          <View
            style={[styles.fill, { width: `${percent}%` }, status.complete && styles.fillComplete]}
          />
        ) : null}
      </View>
    </>
  );

  // Spoken as one thing: "Movies, 12 of 52". Without an explicit label a screen reader
  // reads the two Text children as separate items and the value loses the medium it
  // belongs to.
  const label = `${GOAL_LABEL[status.category]}, ${sentence}`;

  if (!onPress) {
    return (
      <View
        style={styles.root}
        accessibilityRole="progressbar"
        accessibilityLabel={label}
        accessibilityValue={{ min: 0, max: status.target, now: status.count, text: sentence }}
      >
        {body}
      </View>
    );
  }

  /**
   * The founder's correction: the progress row opens the titles behind it.
   *
   * `button` rather than `progressbar` once it is tappable, because a progressbar with
   * an action is a control a screen reader will not offer to activate. The value moves
   * into the label, which is where a button's state has to live — the sentence "Movies,
   * 12 of 52" is already the whole readout.
   *
   * The bar itself is unchanged and still not the only signal: the number is beside it
   * in words, and the hint says what a tap does rather than leaving it to the chevron.
   */
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Shows the titles that counted"
      onPress={onPress}
      style={({ pressed }) => [styles.root, pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { gap: theme.space[2] },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
  },
  // Takes the slack, so the count and the chevron sit together on the right rather
  // than the count drifting to the middle when the label is short.
  label: { flex: 1 },
  pressed: { opacity: 0.7 },
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
