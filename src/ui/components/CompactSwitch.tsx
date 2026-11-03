import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type CompactSwitchOption<T extends string> = { id: T; label: string };

export type CompactSwitchProps<T extends string> = {
  /** What a screen reader calls the group, e.g. "Medium". */
  accessibilityLabel: string;
  options: readonly CompactSwitchOption<T>[];
  value: T;
  onChange: (next: T) => void;
};

/**
 * Two or three short choices in one quiet outline (founder revision brief, 2026-11-03).
 *
 * For You's `Movies | TV Shows`, beside the Recommended / Top Rated selector (Visual 2.1).
 * Deliberately lighter than `SegmentedTabs` and the filled controls: a hairline box with
 * 8pt corners (no pills), the chosen half on Parchment with Ink text, the other in
 * secondary text, at footnote size so it shares the selector's row on a 360pt phone. The
 * visible box is 32pt; each half's press reaches 44pt tall through `hitSlop`, which works
 * here because the switch is not inside another press. Each half is wider than 44pt by its
 * word alone.
 */
export function CompactSwitch<T extends string>({
  accessibilityLabel,
  options,
  value,
  onChange,
}: CompactSwitchProps<T>) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} style={styles.box}>
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={option.label}
            onPress={() => {
              if (!selected) onChange(option.id);
            }}
            // 28 + 8 + 8 = 44 tall. None sideways: the halves are 2pt apart, and a side slop
            // would take the neighbour's own edge (siblings hit-test last-first).
            hitSlop={{ top: 8, bottom: 8, left: 0, right: 0 }}
            style={({ pressed }) => [
              styles.option,
              selected && styles.selected,
              pressed && !selected && styles.pressed,
            ]}
          >
            <Text variant="footnote" tone={selected ? 'primary' : 'secondary'} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    padding: 2,
    gap: 2,
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
  },
  option: {
    height: 28,
    paddingHorizontal: theme.space[2],
    borderRadius: theme.radius.control - 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selected: { backgroundColor: theme.surface.sunken },
  pressed: { opacity: 0.6 },
});
