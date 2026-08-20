import { StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type StatItem = { label: string; value: string | number };

export type StatRowProps = {
  stats: StatItem[];
};

export function StatRow({ stats }: StatRowProps) {
  return (
    <View style={styles.row}>
      {stats.map((stat, index) => (
        <View
          key={stat.label}
          // Grouped, or a screen reader reads five bare numbers and then five
          // words, and the pairing has to be reconstructed by counting. The
          // label comes first because that is the order the pair makes sense
          // in when heard rather than seen.
          accessible
          accessibilityLabel={`${stat.label}: ${stat.value}`}
          style={[styles.item, index > 0 && styles.itemDivider]}
        >
          <Text variant="headline">{stat.value}</Text>
          <Text variant="footnote" tone="secondary">
            {stat.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    borderColor: theme.border.hairline,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: theme.radius.card,
    backgroundColor: theme.surface.raised,
    marginHorizontal: theme.layout.gutter,
    overflow: 'hidden',
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.space[2],
    gap: 2,
  },
  itemDivider: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.border.hairline,
  },
});
