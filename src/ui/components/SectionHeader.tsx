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
   * `title` names something to browse. The default names a block of data. `editorial`
   * is the medium step between them: the serif at 18pt in Maroon, for a shelf that should
   * read as curated without weighing as much as a screen title (founder revision brief,
   * 2026-11-03: Trending now).
   */
  level?: 'label' | 'editorial' | 'title';
};

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
  level = 'label',
}: SectionHeaderProps) {
  const asTitle = level === 'title';
  const editorial = level === 'editorial';
  const exact = asTitle || editorial;
  return (
    <View
      style={styles.row}
      accessibilityRole="header"
      // Uppercasing is a style, not a spelling. Without this a screen reader
      // spells out "T O P  R A N K E D".
      accessibilityLabel={title}
    >
      {/* Shrinks and wraps beside the action, so at large text a long title takes a second
          line instead of pushing See all off the screen. */}
      <View style={styles.heading} testID="section-header-title">
      <Text
        variant={asTitle ? 'title2' : editorial ? 'title3' : 'sectionHeader'}
        tone={asTitle ? 'primary' : 'action'}
        // The token itself uppercases, so printing the title as given is not enough: the
        // style has to be undone as well, or the exception quietly does nothing.
        style={exact ? styles.exactCase : undefined}
      >
        {exact ? title : title.toUpperCase()}
      </Text>
      </View>
      {actionLabel && onPressAction ? (
        // The row is already 44pt tall; the control fills that height rather than
        // hugging one line of footnote, and the slop covers its narrow width. Nothing
        // visible changes — the label sits where it sat (design-system.md §10).
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={actionAccessibilityLabel}
          onPress={onPressAction}
          hitSlop={theme.space[2]}
          style={styles.action}
        >
          <Text variant="footnote" tone="action">
            {actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: theme.layout.minTapTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.layout.gutter,
  },
  heading: { flexShrink: 1, paddingRight: theme.space[3] },
  action: { flexShrink: 0, minHeight: theme.layout.minTapTarget, justifyContent: 'center' },
  exactCase: { textTransform: 'none' },
});
