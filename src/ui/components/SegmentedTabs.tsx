import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type SegmentOption<T extends string> = { id: T; label: string };

export type SegmentedTabsProps<T extends string> = {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
};

export function SegmentedTabs<T extends string>({ options, value, onChange }: SegmentedTabsProps<T>) {
  return (
    <View style={styles.row} accessibilityRole="tablist">
      {options.map((option) => (
        <Pressable
          key={option.id}
          accessibilityRole="tab"
          accessibilityState={{ selected: option.id === value }}
          onPress={() => onChange(option.id)}
          style={[styles.tab, option.id === value && styles.tabActive]}
        >
          <Text variant="callout" tone={option.id === value ? 'primary' : 'secondary'}>
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: theme.space[2],
    paddingHorizontal: theme.layout.gutter,
  },
  tab: {
    minHeight: theme.layout.minTapTarget,
    justifyContent: 'center',
    paddingHorizontal: theme.space[3],
    borderRadius: theme.radius.control,
  },
  tabActive: { backgroundColor: theme.surface.sunken },
});
