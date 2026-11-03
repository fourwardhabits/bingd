import { PixelRatio, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';

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
};

/**
 * How wide one caption character is at 100%, near enough, for the column decision below.
 * Measured off the 130% render, "Followers" averages about 0.51em in the 12pt caption;
 * rounded up to 0.53em so the estimate errs towards two columns rather than a collision.
 * Four across still holds at 100% on a 320pt phone.
 */
const CAPTION_CHAR = 6.4;
/** What a cell keeps clear either side of its label, so two labels never touch. */
const CELL_INSET = theme.space[1];

/**
 * Four across, or two by two when four labels would collide (Visual 2.1 check,
 * 2026-11-03: at 130% on a 320pt phone "Followers" and "Following" ran into each other,
 * and at 200% every label did). Jest and the layout engine cannot measure text before it
 * is drawn, so this estimates the widest label from its length and the system text size,
 * which is the one input that changes it. At 100% it is four across on every supported
 * width.
 */
export const statColumns = (labels: string[], width: number, fontScale: number) => {
  const widest = Math.max(...labels.map((label) => label.length)) * CAPTION_CHAR * fontScale;
  const cell = (width - theme.layout.gutter * 2) / labels.length;
  return widest + CELL_INSET * 2 > cell ? 2 : labels.length;
};

export function StatRow({ stats }: StatRowProps) {
  // `useWindowDimensions` re-renders this when the width or the system text size changes;
  // `PixelRatio` is where React Native reports the text size itself.
  const { width } = useWindowDimensions();
  const columns = statColumns(
    stats.map((stat) => stat.label),
    width,
    PixelRatio.getFontScale(),
  );
  const cell = columns < stats.length ? styles.half : null;
  return (
    <View style={[styles.row, columns < stats.length && styles.grid]} testID="stat-row">
      {stats.map((stat) => {
        const content = (
          <>
            <Text variant="stat">{stat.value}</Text>
            <Text variant="caption" tone="secondary" style={styles.label}>
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
              cell,
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
            style={[styles.item, cell]}
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
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    marginHorizontal: theme.layout.gutter,
  },
  // Numbers on one line from the top, so a label that wraps at a large text size (TV
  // Shows, on a 320pt phone) grows its own cell downwards instead of lifting its number
  // above the other three.
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingVertical: theme.space[3],
    // Two stacked lines of text already clear this, so it changes nothing today. It is
    // stated because half of these tiles are now buttons, and the 44pt floor should be a
    // property of the cell rather than a coincidence of the type scale inside it.
    minHeight: theme.layout.minTapTarget,
    gap: 1,
  },
  label: { textAlign: 'center' },
  // Two by two: each cell half the row, so the four sit in a square under one another.
  grid: { flexWrap: 'wrap' },
  half: { flexBasis: '50%', flexGrow: 0, flexShrink: 0 },
  pressed: { opacity: 0.6 },
});
