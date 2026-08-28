import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type StatItem = {
  label: string;
  value: string | number;
  /**
   * What tapping this opens, for the stats that lead somewhere.
   *
   * All four lead somewhere now — Followers and Following to their people lists,
   * Movies and TV to the ranked-titles drill-down — on both the own tab and
   * `/u/[username]`. Optional rather than a no-op, so a stat with nothing behind it
   * (still loading, say) is not drawn as a button: a control that looks pressable
   * and does nothing is the thing people press twice and then report.
   */
  onPress?: () => void;
  /** Said after the label, for a stat that is a control. */
  hint?: string;
};

export type StatRowProps = {
  stats: StatItem[];
};

export function StatRow({ stats }: StatRowProps) {
  return (
    <View style={styles.row}>
      {stats.map((stat, index) => {
        const content = (
          <>
            <Text variant="headline">{stat.value}</Text>
            <Text variant="footnote" tone="secondary">
              {stat.label}
            </Text>
          </>
        );

        // Grouped either way, or a screen reader reads four bare numbers and then four
        // words, and the pairing has to be reconstructed by counting. The label comes
        // first because that is the order the pair makes sense in when heard.
        const label = `${stat.label}: ${stat.value}`;

        return stat.onPress ? (
          <Pressable
            key={stat.label}
            accessible
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint={stat.hint}
            onPress={stat.onPress}
            // The cell is already `rowMinHeight`-ish and stretches to the row, so the
            // whole tile is the target rather than the two lines of text inside it.
            style={({ pressed }) => [
              styles.item,
              index > 0 && styles.itemDivider,
              pressed && styles.pressed,
            ]}
          >
            {content}
          </Pressable>
        ) : (
          <View
            key={stat.label}
            accessible
            accessibilityLabel={label}
            style={[styles.item, index > 0 && styles.itemDivider]}
          >
            {content}
          </View>
        );
      })}
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
    // Two stacked lines of text already clear this, so it changes nothing today. It is
    // stated because half of these tiles are now buttons, and the 44pt floor should be a
    // property of the cell rather than a coincidence of the type scale inside it.
    minHeight: theme.layout.minTapTarget,
    gap: 2,
  },
  pressed: { opacity: 0.6 },
  itemDivider: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.border.hairline,
  },
});
