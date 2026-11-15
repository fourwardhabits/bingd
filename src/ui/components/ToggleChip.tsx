import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type ToggleChipProps = {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  on: boolean;
  onToggle: () => void;
  /** Read aloud instead of `label` where the label alone is ambiguous. */
  accessibilityLabel?: string;
  /**
   * Slop above and below, for a caller that knows the room around its chips (A11Y-44).
   * Slop only answers inside the parent's bounds, so it is worth no more than the parent's
   * padded box holds; `NoteClaims` passes what its row holds for each chip.
   */
  verticalSlop?: { top: number; bottom: number };
};

/**
 * A two-state control small enough to sit under a text field.
 *
 * `accessibilityRole="checkbox"` rather than `button`: the two note options are
 * both claims the author is making about their own writing, and a screen reader
 * has to be able to say which way each one currently sits without the user
 * pressing it to find out.
 *
 * On-state is carried by the Maroon fill (its border goes Maroon with it; the weight does
 * not change), the inverse label and the filled glyph the caller passes for `on`, together.
 * Colour alone would fail for the same reason the bucket chips carry a checkmark
 * (design-system.md §3), and this control's on-state is genuinely load-bearing —
 * getting the spoiler toggle backwards is not a cosmetic error.
 *
 * Slop is `space[1]` either side (design-system v3 A.2 #12): the chips sit `space[2]` apart,
 * and two neighbours' slops must meet in that gap without crossing, or a press between them
 * belongs to whichever was drawn last. Above and below it is what lifts the 32pt chip to
 * 44, 6pt each by default, or what the caller says its row holds (`verticalSlop`, A11Y-44).
 * Either way it only counts inside the parent, so the parent has to hold it.
 */
export function ToggleChip({
  icon,
  label,
  on,
  onToggle,
  accessibilityLabel,
  verticalSlop = VERTICAL_SLOP,
}: ToggleChipProps) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onToggle}
      hitSlop={{ ...verticalSlop, left: theme.space[1], right: theme.space[1] }}
      style={({ pressed }) => [styles.chip, on && styles.on, pressed && styles.pressed]}
    >
      <Ionicons
        name={icon}
        size={theme.layout.icon.sm}
        color={on ? theme.semantic.actionText : theme.text.secondary}
      />
      <Text variant="footnote" tone={on ? 'inverse' : 'secondary'}>
        {label}
      </Text>
    </Pressable>
  );
}

/** `(44 - 32) / 2` above and below: what lifts the chip to the tap target. */
const VERTICAL_INSET = (theme.layout.minTapTarget - theme.layout.control.chipHeight) / 2;
const VERTICAL_SLOP = { top: VERTICAL_INSET, bottom: VERTICAL_INSET };

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
    minHeight: theme.layout.control.chipHeight,
    paddingHorizontal: theme.space[3],
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.raised,
  },
  on: {
    backgroundColor: theme.semantic.action,
    borderColor: theme.semantic.action,
  },
  pressed: { opacity: 0.7 },
});
