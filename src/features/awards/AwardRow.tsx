import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { AwardBadge } from './AwardBadge';
import { TierDots } from './TierDots';
import type { AwardProgress } from './progress';

export type AwardRowProps = {
  award: AwardProgress;
  /** Opens the breakdown behind the number. Every row has one. */
  onPress?: () => void;
};

/**
 * One award, as a row.
 *
 *     [badge]  Dabbler                                          10 / 14
 *      ●○○     Next: Watch 14 different genres
 *
 * The founder's shape, and the count on the right is doing the work a progress bar
 * would do in a taller row. A bar per award over twenty awards is twenty bars, which
 * reads as a dashboard; `10 / 14` is the same fact in the space of a word.
 *
 * **The title is the tier, and that is the reward.** A creative track is headed by the
 * name of the tier reached — Genre Gremlin becomes Dabbler, then Mixer, then Chaos
 * Collector — so earning one *changes the row*. It used to keep the family name and add
 * a third line saying "Dabbler earned", which stated the achievement and celebrated it
 * nowhere. The badge art changes with it and the dots below fill in.
 *
 * **The next tier's name is never shown.** A locked Genre Gremlin says "Genre Gremlin",
 * not "Dabbler", because handing over the name in advance spends the reward before it
 * is earned. What the row does show is the requirement — "Next: Watch 8 different
 * genres" — which is the useful half.
 *
 * **Metal tracks keep their family name.** Movie Muncher stays Movie Muncher at every
 * tier: a row headed "Silver" says nothing about what was done, and three rows headed
 * "Bronze" say less than one. See `AwardTrack.metalTiers`.
 *
 * **Two lines, always.** The separate earned line is gone in both directions — the tier
 * is in the title now, and at the top the second line states what finished it.
 *
 * **Every row is tappable.** If Bingd shows somebody `10 / 14`, they are entitled to see
 * what the fourteen are made of; a number a reader cannot check is a number they have to
 * take on faith. The seven non-title tracks open the same kind of sheet as the twelve
 * title ones — see `AwardBreakdownSheet`.
 *
 * **A track whose number could not be read says so**, rather than drawing a zero, and is
 * the one row with nothing behind it.
 */
export function AwardRow({ award, onPress }: AwardRowProps) {
  const earned = award.earnedTier != null;

  // One announcement, in the order the row reads. Without this a screen reader gives
  // four fragments and the count lands last, detached from the goal it is counting
  // toward. The tier is named here in words, which is what lets the dots be decorative.
  const label = (
    award.unavailable
      ? [award.displayName, award.detailLine]
      : [
          award.title,
          earned ? `${award.badgeTierLabel} earned` : `${award.badgeTierLabel} locked`,
          award.detailLine,
          award.nextTier ? `${award.value} of ${award.nextTier.threshold}` : `${award.value}`,
        ]
  ).join('. ');

  const body = (
    <>
      {/* The badge and its dots are one object: the strip is positioned inside this
          box, over the badge's lower edge, so the row's height is unchanged. */}
      <View style={styles.badge}>
        <AwardBadge badge={award.badge} earned={earned} />
        {award.unavailable ? null : <TierDots earnedTierIndex={award.earnedTierIndex} />}
      </View>

      <View style={styles.copy}>
        <Text variant="callout">{award.title}</Text>
        <Text variant="footnote" tone="secondary">
          {award.detailLine}
        </Text>
      </View>

      <Text
        variant="footnote"
        tone={earned ? 'primary' : 'secondary'}
        style={styles.count}
        // The count is already in the row's one label, and a second reading of
        // "10 / 14" as "ten slash fourteen" helps nobody.
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {award.countLabel}
      </Text>
    </>
  );

  if (!onPress) {
    return (
      <View style={styles.row} accessible accessibilityRole="text" accessibilityLabel={label}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Shows what counts toward this"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[3],
    paddingVertical: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    minHeight: theme.layout.row.media,
  },
  // Exactly the badge's own size, so `TierDots` can position against its bottom edge.
  badge: { width: theme.layout.awardBadge, height: theme.layout.awardBadge },
  copy: { flex: 1, gap: 1 },
  /**
   * Right-aligned with a floor under it, so `7 / 50` and `1,164 / 2,000` end on the
   * same edge and the column does not breathe as the reader scrolls past a wider
   * number.
   */
  count: { minWidth: 72, textAlign: 'right' },
  pressed: { opacity: 0.7 },
});
