import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type SegmentOption<T extends string> = { id: T; label: string };

export type SegmentedTabsProps<T extends string> = {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
};

/**
 * The tabs under a screen's title (screens.md §5).
 *
 * Underline rather than a filled pill. The filled version competed with the
 * score badges in the list below it — two rounded, tinted shapes in the same
 * column of the screen, one of which carries meaning and one of which is
 * navigation. An underline is unmistakably chrome.
 */
export function SegmentedTabs<T extends string>({ options, value, onChange }: SegmentedTabsProps<T>) {
  return (
    <View style={styles.row} accessibilityRole="tablist">
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.id)}
            style={styles.tab}
          >
            <Text variant="callout" tone={selected ? 'primary' : 'tertiary'}>
              {option.label}
            </Text>
            <View style={[styles.underline, selected && styles.underlineActive]} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: theme.space[5],
    paddingHorizontal: theme.layout.gutter,
  },
  tab: {
    minHeight: theme.layout.minTapTarget,
    justifyContent: 'center',
    alignItems: 'center',
    gap: theme.space[1],
  },
  // Always present, so selecting a tab does not shift the row by two points.
  underline: {
    height: 2,
    alignSelf: 'stretch',
    borderRadius: theme.radius.full,
    backgroundColor: 'transparent',
  },
  underlineActive: { backgroundColor: theme.semantic.action },
});
