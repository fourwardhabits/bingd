import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type SectionHeaderProps = {
  title: string;
  actionLabel?: string;
  onPressAction?: () => void;
  /**
   * Print the title exactly as given instead of upper-casing it.
   *
   * **One caller, and it is a brand exception the founder made deliberately**: the
   * profile's awards shelf reads `bingd. AWARDS`, because the product's name is
   * lower-case with a full stop and `BINGD. AWARDS` spells it wrong. Everything else on
   * every surface stays upper-cased, which is what makes this an exception rather than a
   * second style.
   *
   * The spoken name is `title` either way — uppercasing was always a style and never a
   * spelling, which is why `accessibilityLabel` has never been derived from it.
   */
  exactCase?: boolean;
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
  onPressAction,
  exactCase = false,
}: SectionHeaderProps) {
  return (
    <View
      style={styles.row}
      accessibilityRole="header"
      // Uppercasing is a style, not a spelling. Without this a screen reader
      // spells out "T O P  R A N K E D".
      accessibilityLabel={title}
    >
      <Text variant="sectionHeader" tone="action">
        {exactCase ? title : title.toUpperCase()}
      </Text>
      {actionLabel && onPressAction ? (
        <Pressable accessibilityRole="button" onPress={onPressAction}>
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
});
