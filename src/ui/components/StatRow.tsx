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
   * `/u/[username]`. (Since 2026-09-12 the Movies and TV numbers count the watched
   * collection, imports included, while the drill-down still lists what is ranked.)
   * Optional rather than a no-op, so a stat with nothing behind it
   * (still loading, say) is not drawn as a button: a control that looks pressable
   * and does nothing is the thing people press twice and then report.
   */
  onPress?: () => void;
  /** Said after the label, for a stat that is a control. */
  hint?: string;
};

export type StatRowProps = {
  stats: StatItem[];
  /** Each figure centred in its quarter, inside the owner's profile card (2026-11-07). */
  centered?: boolean;
};

export function StatRow({ stats, centered = false }: StatRowProps) {
  return (
    <View style={styles.row}>
      {stats.map((stat) => {
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
              centered && styles.centered,
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
            style={[styles.item, centered && styles.centered]}
          >
            {content}
          </View>
        );
      })}
    </View>
  );
}

/**
 * **Four open columns, no card** (founder, marquee cohesion sprint, 2026-11-07): the boxed,
 * divided strip was the part of the profile that read as older than the poster sections
 * under it. Each figure and its label now sit left-aligned in an equal quarter, the first
 * on the gutter under the avatar, with no border, fill or rule. Every cell is still the
 * whole 44pt target it was.
 */
const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    marginHorizontal: theme.layout.gutter,
  },
  item: {
    flex: 1,
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingVertical: theme.space[2],
    // Two stacked lines of text already clear this, so it changes nothing today. It is
    // stated because half of these tiles are now buttons, and the 44pt floor should be a
    // property of the cell rather than a coincidence of the type scale inside it.
    minHeight: theme.layout.minTapTarget,
    gap: 2,
  },
  centered: { alignItems: 'center' },
  pressed: { opacity: 0.6 },
});
