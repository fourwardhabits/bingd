import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { AwardBadge } from './AwardBadge';
import type { AwardProgress } from './progress';

export type AwardRowProps = {
  award: AwardProgress;
  /**
   * Opens the titles behind the number.
   *
   * Passed only where there are any — `award.hasContributors` — so a row is pressable
   * exactly when there is something behind it. A row that looks tappable and does
   * nothing is worse than one that never offered.
   */
  onPress?: () => void;
};

/**
 * One award, as a row.
 *
 *     [badge]  Movie Muncher                                   84 / 200
 *              Bronze earned
 *              Next: Watch 200 movies
 *
 * The founder's shape, and the count on the right is doing the work a progress bar
 * would do in a taller row. A bar per award over twenty awards is twenty bars, which
 * reads as a dashboard; `84 / 200` is the same fact in the space of a word.
 *
 * **Three lines at most, and usually two.** The earned line is absent before the first
 * tier. At the top it is present and the line under it changes person — "Gold earned"
 * over "Watched 1,000 movies" — so a finished track states the tier and what finished
 * it, rather than pointing at a fourth tier that does not exist.
 *
 * **No explanatory paragraph, on any row.** Three tracks carried one — that Queue
 * Dragon counts the pile you are holding, that Bingd cannot see whether an invite link
 * was opened, that Two-Screen Life shows whichever side you are behind on. All three
 * were the same defect: a technical footnote about a metric, in a list somebody is
 * scrolling for fun. Two were answered by fixing the metric (invites now count people,
 * Two-Screen Life now counts capped contributions) and the third by trusting "Keep 25
 * titles on your watchlist" to say what it says.
 *
 * **A track whose number could not be read says so**, rather than drawing a zero. The
 * badge stays locked, the detail line reads "Could not load this one" and the count is a
 * dash. Zero is a statement about the reader — you have sent no recommendations — and
 * making it on the strength of a request that never came back is the app being wrong
 * about somebody in a way they cannot argue with.
 */
export function AwardRow({ award, onPress }: AwardRowProps) {
  const earned = award.earnedTier != null;

  // One announcement, in the order the row reads. Without this a screen reader gives
  // four fragments and the count lands last, detached from the goal it is counting
  // toward. The hint is only true where there is a drill-down to hint at.
  const label = (
    award.unavailable
      ? [award.displayName, award.detailLine]
      : [
          award.displayName,
          earned ? `${award.badgeTierLabel} earned` : `${award.badgeTierLabel} locked`,
          award.detailLine,
          award.nextTier ? `${award.value} of ${award.nextTier.threshold}` : `${award.value}`,
        ]
  ).join('. ');

  const body = (
    <>
      <AwardBadge badge={award.badge} earned={earned} />

      <View style={styles.copy}>
        <Text variant="callout">{award.displayName}</Text>
        {award.earnedLine ? (
          <Text variant="footnote" tone="secondary">
            {award.earnedLine}
          </Text>
        ) : null}
        <Text variant="footnote" tone="secondary">
          {award.detailLine}
        </Text>
      </View>

      <Text
        variant="footnote"
        tone={earned ? 'primary' : 'secondary'}
        style={styles.count}
        // The count is already in the row's one label, and a second reading of
        // "84 / 200" as "eighty-four slash two hundred" helps nobody.
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
      accessibilityHint="Shows the titles that counted"
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
  copy: { flex: 1, gap: 1 },
  /**
   * Right-aligned with a floor under it, so `7 / 50` and `1,164 / 2,000` end on the
   * same edge and the column does not breathe as the reader scrolls past a wider
   * number. Wider than it was: the top tiers are now four figures.
   */
  count: { minWidth: 72, textAlign: 'right' },
  pressed: { opacity: 0.7 },
});
