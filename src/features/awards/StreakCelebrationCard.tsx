import { StyleSheet, View } from 'react-native';

import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

export type StreakCelebrationCardProps = {
  /** Consecutive qualifying weeks, including the one just confirmed. Always ≥ 2. */
  weeks: number;
};

/**
 * A weekly streak, in the same card the awards use.
 *
 * Deliberately the same object: same surface, same elevation, same three-line rhythm of
 * mark, name and sentence. A streak and an award are both "something you did that the
 * app noticed", and giving the streak a design of its own would make one ranking produce
 * two different-looking congratulations.
 *
 * The flame is decoration beside a number that already says it, so the card carries the
 * spoken sentence and the glyph is not read out on its own.
 *
 * **Only ever shown from two weeks up.** A first week is a week, not a streak, and
 * `streakAdvanced` refuses to enqueue one — this component states the same rule in its
 * copy rather than defending against it, because a card that quietly renders "1-week
 * streak" would mean the rule had already been broken somewhere it matters more.
 */
export function StreakCelebrationCard({ weeks }: StreakCelebrationCardProps) {
  return (
    <View
      style={styles.card}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`A ${weeks} week streak. You ranked something this week.`}
    >
      <Text variant="title1" allowFontScaling={false} style={styles.flame}>
        🔥
      </Text>
      <Text variant="caption" tone="secondary">
        STREAK CONTINUED
      </Text>
      <Text variant="title2" style={styles.centred}>
        {`${weeks}-week streak`}
      </Text>
      <Text variant="footnote" tone="secondary" style={styles.centred}>
        Ranked this week
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * Raised rather than transparent, exactly as `CelebrationCard` is: it sits on a wall
   * of posters, and the one thing that must never be in question is which pixels are the
   * message.
   */
  card: {
    alignItems: 'center',
    gap: theme.space[2],
    paddingVertical: theme.space[6],
    paddingHorizontal: theme.space[5],
    borderRadius: theme.radius.card,
    backgroundColor: theme.surface.base,
    ...theme.elevation.e2,
  },
  // Sized to sit where an award's badge sits, so the two cards are the same shape.
  flame: { fontSize: 56, lineHeight: 64, marginBottom: theme.space[2] },
  centred: { textAlign: 'center' },
});
