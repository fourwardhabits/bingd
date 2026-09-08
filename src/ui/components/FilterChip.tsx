import { Ionicons } from '@expo/vector-icons';
import { Animated, Pressable, StyleSheet } from 'react-native';

import { hapticSelection } from '../haptics';
import { usePressScale } from '../press';
import { theme } from '../tokens';
import { Text } from './Text';

export type FilterChipProps = {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  /** Draws the on state: Maroon border, sunken fill, Maroon glyph and label. */
  selected?: boolean;
  /**
   * **Marks a chip that opens a bingd. feature rather than narrowing a list** (founder,
   * physical QA, 2026-09-08).
   *
   * For You's control row is *Sent to you*, *Group Picks*, *Filters*, and on the device
   * the first two read as generic grey utility controls — which is what they looked
   * like, and which undersells the two things on that row somebody would tell a friend
   * about. The founder's instruction is a restrained hierarchy, not a promotion: **social
   * feature, social feature, utility**.
   *
   * So this is a Maroon glyph, a Maroon label and a Maroon-tinted hairline, and it is
   * nothing else. No filled pill, no larger target, no badge, and above all no extra
   * height — the row's one-line density is a founder lock and this changes only colour.
   *
   * It composes with `selected` rather than competing: an emphasised chip that is also on
   * still takes the full-strength ring and the Parchment fill, so "this is a feature" and
   * "this is currently applied" remain two readable states.
   */
  emphasis?: 'social';
  /** Read aloud instead of `label`, where the label alone is ambiguous. */
  accessibilityLabel?: string;
  onPress: () => void;
};

/**
 * One control in a filter row.
 *
 * Extracted from `CollectionView`, where it lived as a private `Control`, because For
 * You now has the same row and the founder's instruction is that the two screens look
 * like the same product. Two copies of a chip drift within a week; one does not.
 *
 * Not `ToggleChip`, which is a checkbox: these announce as buttons because most of them
 * open something — a sheet, a menu — rather than flipping a value in place. The ones
 * that do flip a value carry `selected`, which is what `accessibilityState` reports.
 */
export function FilterChip({
  icon,
  label,
  selected = false,
  emphasis,
  accessibilityLabel,
  onPress,
}: FilterChipProps) {
  // Maroon for both, and the two are still told apart by the ring and the fill `on`
  // adds — see `emphasis`. Computed once so the glyph and the word cannot disagree.
  const action = selected || emphasis === 'social';
  const press = usePressScale();

  return (
    <Animated.View style={press.pressStyle}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ selected }}
        /**
         * **Selection, the lightest haptic there is** (founder premium pass, 2026-09-08).
         *
         * A chip row is where somebody says what they want to look at, and every chip in it
         * is a small reversible statement — which is exactly the `selection` case in
         * `ui/haptics.ts`. It fires on *every* chip rather than only on the toggles: to a
         * thumb the row is one control surface, and a row where two of five buzz would read
         * as three of them being broken.
         *
         * Before `onPress`, not after, and not inside it: the feedback is answering the
         * touch, and a sheet that takes 40ms to mount must not be what the reader feels.
         */
        onPress={() => {
          hapticSelection();
          onPress();
        }}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        // 32pt drawn, 44pt pressed. It was `space[1]` all round, which made the chip 40pt
        // tall to a thumb — short of the target by the four points the audit measured.
        hitSlop={theme.layout.chipHitSlop}
        style={({ pressed }) => [
          styles.chip,
          // Order matters: emphasis tints the hairline, and `on` overrides it with the
          // full-strength ring, so a selected feature chip reads as selected.
          emphasis === 'social' && styles.social,
          selected && styles.on,
          pressed && styles.pressed,
        ]}
      >
        <Ionicons
          name={icon}
          size={theme.layout.icon.sm}
          color={action ? theme.semantic.action : theme.text.secondary}
        />
        <Text variant="footnote" tone={action ? 'action' : 'secondary'}>
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[1],
    minHeight: theme.layout.control.chipHeight,
    paddingHorizontal: theme.space[3],
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.raised,
  },
  on: { borderColor: theme.semantic.action, backgroundColor: theme.surface.sunken },
  /**
   * A feature chip at rest: the same geometry, a Maroon-tinted hairline.
   *
   * The border alone, with no fill. A tinted ground here would read as a third selected
   * state on a row where one chip is genuinely a toggle, and the founder's constraint is
   * that this row must not get noisier or taller — so the emphasis is carried by the two
   * things already being drawn, the glyph and the word, plus the line around them.
   */
  social: { borderColor: theme.semantic.actionSubtle },
  pressed: { opacity: 0.7 },
});
