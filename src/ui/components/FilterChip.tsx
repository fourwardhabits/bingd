import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type FilterChipProps = {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  /** Draws the on state: Maroon border, sunken fill, Maroon glyph and label. */
  selected?: boolean;
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
  accessibilityLabel,
  onPress,
}: FilterChipProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected }}
      onPress={onPress}
      hitSlop={theme.space[1]}
      style={({ pressed }) => [styles.chip, selected && styles.on, pressed && styles.pressed]}
    >
      <Ionicons
        name={icon}
        size={theme.layout.icon.sm}
        color={selected ? theme.semantic.action : theme.text.secondary}
      />
      <Text variant="footnote" tone={selected ? 'action' : 'secondary'}>
        {label}
      </Text>
    </Pressable>
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
  pressed: { opacity: 0.7 },
});
