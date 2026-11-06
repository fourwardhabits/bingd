import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type SectionHeaderProps = {
  title: string;
  actionLabel?: string;
  /**
   * What a screen reader calls the action, when the visible label alone is ambiguous.
   * Two "See all"s on one page are two controls nobody can tell apart by ear.
   */
  actionAccessibilityLabel?: string;
  onPressAction?: () => void;
  /**
   * Print the title exactly as given instead of upper-casing it.
   *
   * **One caller, and it is a brand exception the founder made deliberately**: the
   * profile's awards shelf reads `bingd AWARDS`, because the product's name is
   * lower-case and `BINGD AWARDS` spells it wrong. Everything else on every surface
   * stays upper-cased, which is what makes this an exception rather than a second style.
   * (Plain text writes the name without the wordmark's period, founder 2026-09-13.)
   *
   * The spoken name is `title` either way — uppercasing was always a style and never a
   * spelling, which is why `accessibilityLabel` has never been derived from it.
   */
  exactCase?: boolean;
  /**
   * `large` — 15pt rather than 12 (`sectionHeaderLarge`), for the Feed and Profile tabs'
   * own headings only (founder final polish, 2026-11-04). Every other heading, including
   * the same components drawn on somebody else's profile, keeps the standard size.
   */
  size?: SectionHeaderSize;
  /**
   * One line, shrinking to fit rather than wrapping. For a one-word heading beside a
   * control, which cannot wrap at a word: the Feed's LEADERBOARD at a large text size
   * (nav cohesion sprint, 2026-11-06). Every other heading wraps as before.
   */
  fit?: boolean;
  /**
   * Let the action drop under the heading when the two do not fit on one line, rather than
   * running off the screen: the Cinematic title page's sections at a large text size, whose
   * Trailers action is the reader's one way to ask for previews (title-page sprint,
   * 2026-11-06). Where both fit, nothing moves.
   */
  wrap?: boolean;
  /**
   * The heading's own line height rather than a 44pt row, so the content under it starts
   * about 8pt below the words rather than 14pt plus whatever the content adds: the
   * Cinematic title page, where the gap under ABOUT read as too large on the phone (final
   * title refinement, 2026-11-06). An action keeps a 44pt target through its slop, and the
   * row is raised above the body that follows (`zIndex`): both platforms hit-test siblings
   * in z order and, with nothing clipped, honour slop outside the row, so a rail drawn right
   * under the heading cannot take the lower half of See all or Show previews.
   */
  tight?: boolean;
};

export type SectionHeaderSize = 'standard' | 'large';

/**
 * The one way a screen names a section (design-system.md §8).
 *
 * Maroon rather than tertiary grey. A header at 12pt, medium weight and 5.2:1
 * is small, faint and light all at once, and the three together read as a
 * disclaimer under the content instead of a label over it. Maroon is 8.5:1 on
 * Paper and is already the app's structural colour.
 *
 * The gutter padding lives here and not at the call site, which is why
 * screens must not hand-roll a header: Profile did, omitted the padding on one
 * of its two, and shipped a heading flush to the screen edge.
 */
export function SectionHeader({
  title,
  actionLabel,
  actionAccessibilityLabel,
  onPressAction,
  exactCase = false,
  size = 'standard',
  fit = false,
  wrap = false,
  tight = false,
}: SectionHeaderProps) {
  return (
    <View
      style={[styles.row, wrap && styles.wrap, tight && styles.tight]}
      accessibilityRole="header"
      // Uppercasing is a style, not a spelling. Without this a screen reader
      // spells out "T O P  R A N K E D".
      accessibilityLabel={title}
    >
      <Text
        variant={size === 'large' ? 'sectionHeaderLarge' : 'sectionHeader'}
        tone="action"
        // The token itself uppercases, so printing the title as given is not enough: the
        // style has to be undone as well, or the exception quietly does nothing.
        style={[exactCase ? styles.exactCase : undefined, fit && styles.fit]}
        numberOfLines={fit ? 1 : undefined}
        adjustsFontSizeToFit={fit}
        minimumFontScale={fit ? FIT_FLOOR : undefined}
      >
        {exactCase ? title : title.toUpperCase()}
      </Text>
      {actionLabel && onPressAction ? (
        // The row is already 44pt tall; the control fills that height rather than
        // hugging one line of footnote, and the slop covers its narrow width. Nothing
        // visible changes — the label sits where it sat (design-system.md §10).
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={actionAccessibilityLabel}
          onPress={onPressAction}
          hitSlop={tight ? TIGHT_SLOP : theme.space[2]}
          style={tight ? undefined : styles.action}
        >
          <Text variant="footnote" tone="action">
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** LEADERBOARD at 200% text in the space a 320pt phone leaves it needs about 0.69. */
const FIT_FLOOR = 0.6;

/** A footnote line is about 18pt; 13pt above and below it makes the 44pt target. */
const TIGHT_SLOP = { top: 13, bottom: 13, left: theme.space[2], right: theme.space[2] };

const styles = StyleSheet.create({
  tight: { minHeight: 0, zIndex: 1 },
  fit: { flexShrink: 1 },
  wrap: { flexWrap: 'wrap', columnGap: theme.space[3] },
  row: {
    minHeight: theme.layout.minTapTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.layout.gutter,
  },
  action: { minHeight: theme.layout.minTapTarget, justifyContent: 'center' },
  exactCase: { textTransform: 'none' },
});
