import { Fragment } from 'react';
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

        const cell = stat.onPress ? (
          <Pressable
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
            accessible
            accessibilityLabel={label}
            style={[styles.item, centered && styles.centered]}
          >
            {content}
          </View>
        );

        // The rule is a sibling *between* two cells rather than a border on either, so
        // neither tap target gives up its height to it, and nothing is drawn before the
        // first stat or after the last.
        return (
          <Fragment key={stat.label}>
            {index > 0 ? (
              <View
                testID="stat-rule"
                style={styles.rule}
                pointerEvents="none"
                accessible={false}
                importantForAccessibility="no"
              />
            ) : null}
            {cell}
          </Fragment>
        );
      })}
    </View>
  );
}

/**
 * **Four open columns, no card** (founder, marquee cohesion sprint, 2026-11-07): the boxed,
 * divided strip was the part of the profile that read as older than the poster sections
 * under it, so the box, the fill and the full-height dividers went. Every cell is still the
 * whole 44pt target it was.
 *
 * **A lighter rule back between the four** (founder, 2026-11-12). Not the old strip's: the
 * title page's score-card hairline (`ImmersiveScores`' `divided` — `hairlineWidth * 2`, so
 * it survives the Android densities where a single hairline rounds to nothing, in
 * `border.hairline`), drawn short and centred so it separates the figures without
 * re-drawing a box around them. Its height is the two lines of type it sits beside, not
 * the cell: a full-height border would be the old divided strip again, and would run the
 * whole height of the tap target.
 */
const styles = StyleSheet.create({
  /**
   * **A subtle rounded outline around the four** (founder spec §7, 2026-11-13: "a clean
   * outline rather than a heavy coloured background"). The hairline is the dividers' own
   * colour and weight, so the frame and the rules read as one drawing; the radius is the
   * card's. The cells keep their 44pt targets — the padding is inside the frame, around
   * them, never taken out of them.
   */
  row: {
    flexDirection: 'row',
    marginHorizontal: theme.layout.gutter,
    paddingHorizontal: theme.space[2],
    paddingVertical: theme.space[1],
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    borderRadius: theme.radius.card,
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
    // A little air between a rule and the words beside it, now that the row is framed.
    paddingHorizontal: theme.space[1],
    gap: 2,
  },
  centered: { alignItems: 'center' },
  rule: {
    alignSelf: 'center',
    height: theme.typography.headline.lineHeight + theme.typography.footnote.lineHeight,
    borderLeftWidth: StyleSheet.hairlineWidth * 2,
    borderLeftColor: theme.border.hairline,
  },
  pressed: { opacity: 0.6 },
});
