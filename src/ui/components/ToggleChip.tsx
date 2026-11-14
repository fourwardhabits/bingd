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
 * Slop is `space[2]` above and below but only `space[1]` either side (design-system v3
 * A.2 #12): the chips sit `space[2]` apart, and two neighbours' slops must meet in that
 * gap without crossing, or a press between them belongs to whichever was drawn last.
 */
export function ToggleChip({ icon, label, on, onToggle, accessibilityLabel }: ToggleChipProps) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onToggle}
      hitSlop={SLOP}
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

const SLOP = {
  top: theme.space[2],
  bottom: theme.space[2],
  left: theme.space[1],
  right: theme.space[1],
};

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
