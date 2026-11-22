import { Fragment } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';

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
  /**
   * **A section of the profile card rather than a card inside it** (founder, 2026-11-22).
   * No frame of its own: no outline, no radius. Inset by the card's own `layout.gutter`,
   * so its edges line up with the identity and bio above it. The rules between the four
   * stay. Each cell gives 2pt of its side air back, which keeps `TV Shows` on one line
   * at 320pt (see {@link statLabelFit}).
   */
  inCard?: boolean;
};

/**
 * **From this text size the labels wrap rather than fit one line** (founder, 286-SMOKE-UI,
 * t223u, 2026-11-15): one line at normal sizes, readability first at the accessibility
 * sizes. 1.5 sits above Android's 1.3 and iOS's largest standard size (xxxLarge, 1.353)
 * and below iOS's first accessibility size (AX1, 1.647), so every standard setting on
 * either platform gets one line and every accessibility size gets the pre-existing
 * wrapping label, at its full, uncapped size.
 */
export const STAT_LABEL_WRAP_SCALE = 1.5;

/** The `Button` `fit` floor: below 85% the label reads as a different size of type. */
export const STAT_LABEL_MIN_SCALE = 0.85;

/**
 * **How far a label may grow with the reader's text size before it fits itself to the
 * quarter** (founder, 286-SMOKE-UI, t222s1181), by window width.
 *
 * The cap is what lets the 0.85 floor hold: `adjustsFontSizeToFit` shrinks from the capped
 * size, so the capped size times 0.85 must fit the narrowest quarter at that width. The
 * widest label is `TV Shows`, 4.795em of Inter Regular (`StatRow.test.tsx` reads it from
 * the font), 64.83pt at 13pt with the 4% allowance `RankingSheet` uses. A quarter's text
 * width inside the profile card (card border and three rules each at most 1pt; the row
 * inset by the card's gutter with no frame of its own; 2pt item padding either side,
 * 2026-11-22) is
 *
 *     (W - 2 * gutter - 2 * 1 - 2 * gutter - 3 * 1) / 4 - 2 * 2  =  (W - 69) / 4 - 4
 *
 *     W      quarter   largest cap at 0.85   cap   shrink at the cap
 *     320    58.75     1.066                 1.05  0.863
 *     360    68.75     1.247                 1.1   0.964
 *     390    76.25     1.384                 1.2   0.980
 *
 * Steps rather than the ratio itself, so the type does not change size between phones a
 * point apart; each step is checked at the narrowest width it applies to.
 */
export function statLabelMaxScale(windowWidth: number): number {
  if (windowWidth >= 390) return 1.2;
  if (windowWidth >= 360) return 1.1;
  return 1.05;
}

/**
 * The label's line rule at this window: one line, fit to the quarter (`Button`'s `fit`
 * trio plus the width cap), below {@link STAT_LABEL_WRAP_SCALE}; nothing at all at or
 * above it, so the label wraps and grows the row exactly as it did before.
 *
 * Android: `adjustsFontSizeToFit` with `numberOfLines` shrinks there too, but its text
 * layout ignores `minimumFontScale` (see `RankingSheet`'s reveal exits). That costs nothing
 * here: the cap is chosen so the shrink a label needs is never below 0.85 in the first
 * place, and Android only shrinks as far as the label needs.
 */
export function statLabelFit(windowWidth: number, fontScale: number) {
  if (fontScale >= STAT_LABEL_WRAP_SCALE) return {};
  return {
    numberOfLines: 1,
    adjustsFontSizeToFit: true,
    minimumFontScale: STAT_LABEL_MIN_SCALE,
    maxFontSizeMultiplier: statLabelMaxScale(windowWidth),
  } as const;
}

export function StatRow({ stats, centered = false, inCard = false }: StatRowProps) {
  const { width, fontScale } = useWindowDimensions();
  // The same rule for all four labels: one that fits `TV Shows` is the one that fits all.
  const labelFit = statLabelFit(width, fontScale);

  return (
    <View style={[styles.row, inCard ? styles.inCard : styles.framed]}>
      {stats.map((stat, index) => {
        const content = (
          <>
            <Text variant="headline">{stat.value}</Text>
            <Text variant="footnote" tone="secondary" {...labelFit}>
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
              inCard && styles.itemInCard,
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
            style={[styles.item, inCard && styles.itemInCard, centered && styles.centered]}
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
   * **Outside a card: a subtle rounded outline around the four** (founder spec §7,
   * 2026-11-13: "a clean outline rather than a heavy coloured background"). The hairline
   * is the dividers' own colour and weight, so the frame and the rules read as one
   * drawing; the radius is the card's. The cells keep their 44pt targets — the padding is
   * inside the frame, around them, never taken out of them. `row` is what both share;
   * `framed` is the outline.
   */
  row: {
    flexDirection: 'row',
    paddingVertical: theme.space[1],
  },
  framed: {
    marginHorizontal: theme.layout.gutter,
    paddingHorizontal: theme.space[2],
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    borderRadius: theme.radius.card,
  },
  /**
   * **In the profile card: a section, not a card within a card** (founder, 2026-11-22).
   * The row touched the card's edges inside its own outline. It is now inset by the
   * card's content gutter, as the identity and bio rows are, and draws no outline. The
   * rules between the four are unchanged.
   */
  inCard: { marginHorizontal: theme.layout.gutter },
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
  // Centred labels, so the 2pt is not seen; it is what keeps `TV Shows` on one line at
  // 320pt now that the row is inset by the card's gutter.
  itemInCard: { paddingHorizontal: 2 },
  centered: { alignItems: 'center' },
  rule: {
    alignSelf: 'center',
    height: theme.typography.headline.lineHeight + theme.typography.footnote.lineHeight,
    borderLeftWidth: StyleSheet.hairlineWidth * 2,
    borderLeftColor: theme.border.hairline,
  },
  pressed: { opacity: 0.6 },
});
