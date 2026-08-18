import { StyleSheet, View } from 'react-native';

import { Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { AwardBadge } from './AwardBadge';
import type { AwardProgress } from './progress';

export type AwardRowProps = {
  award: AwardProgress;
};

/**
 * One award, as a row.
 *
 *     [badge]  Movie Muncher
 *              Bronze earned
 *              Next: Watch 50 movies                          27 / 50
 *
 * The founder's shape, and the count on the right is doing the work a progress bar
 * would do in a taller row. A bar per award over twenty awards is twenty bars, which
 * reads as a dashboard; `27 / 50` is the same fact in the space of a word.
 *
 * **Three lines at most, and usually two.** The earned line is absent before the first
 * tier and absent again at the top, where the detail line already carries the word
 * "earned" — so the row grows by one line exactly once in a track's life, in the middle,
 * where there genuinely are two things to say.
 *
 * **A track whose number could not be read says so**, rather than drawing a zero. The
 * badge stays locked, the detail line reads "Could not load this one" and the count is a
 * dash. Zero is a statement about the reader — you have sent no recommendations — and
 * making it on the strength of a request that never came back is the app being wrong
 * about somebody in a way they cannot argue with.
 *
 * **Not tappable.** There is nothing behind an award: no detail screen, no history, no
 * share. A row that looks pressable and does nothing is worse than one that never
 * offered, and the drill-down the goals rows have exists because a *goal* is a claim
 * about which titles counted. An award is a count of a thing the reader can already see
 * listed elsewhere in the app.
 */
export function AwardRow({ award }: AwardRowProps) {
  const earned = award.earnedTier != null;

  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="text"
      // One announcement, in the order the row reads. Without this a screen reader
      // gives four fragments and the count lands last, detached from the goal it is
      // counting toward.
      accessibilityLabel={(award.unavailable
        ? [award.displayName, award.detailLine]
        : [
            award.displayName,
            earned ? `${award.badgeTierLabel} earned` : `${award.badgeTierLabel} locked`,
            award.detailLine,
            award.nextTier ? `${award.value} of ${award.nextTier.threshold}` : `${award.value}`,
          ]
      ).join('. ')}
    >
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
        {/* The caveat, where a track has one — that Queue Dragon counts the pile you
            are holding rather than everything you ever added, that Bingd cannot see
            whether an invite link was opened. Two tracks have one. It is tertiary
            because it is a footnote about the number, not part of the goal.

            Suppressed on an unreadable row: a note explaining what a number means,
            under a row that has no number, is noise on top of an apology. */}
        {award.note && !award.unavailable ? (
          <Text variant="caption" tone="tertiary">
            {award.note}
          </Text>
        ) : null}
      </View>

      <Text
        variant="footnote"
        tone={earned ? 'primary' : 'secondary'}
        style={styles.count}
        // The count is already in the row's one label, and a second reading of
        // "27 / 50" as "twenty-seven slash fifty" helps nobody.
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {award.countLabel}
      </Text>
    </View>
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
   * Right-aligned with a floor under it, so `7 / 10` and `164 / 300` end on the same
   * edge and the column does not breathe as the reader scrolls past a wider number.
   */
  count: { minWidth: 56, textAlign: 'right' },
});
