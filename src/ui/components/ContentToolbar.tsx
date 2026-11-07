import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

/**
 * **A browsing page's content toolbar**: its marquee title on the left gutter and its tools
 * on the right one (founder, marquee cohesion sprint, 2026-11-07).
 *
 *     Watched ▾                          ⚙ Filters   ▦ ☰
 *     Recommended ▾                                ⚙ Filters
 *
 * Collection and For You draw their top controls through this, so the two pages share one
 * height, one baseline and one padding rather than agreeing by hand.
 *
 * **The title never truncates.** When the row has no room for both (a 320pt phone with
 * "Watchlist", or a large text size), the tools wrap onto a line of their own and stay on
 * the right; only the secondary controls move.
 *
 * It is content, not chrome: the caller puts it at the head of whatever scrolls, so it
 * leaves with the content rather than standing over it.
 *
 * `edgeInset` is how far the last tool's own padding reaches past its glyph, so that glyph
 * lands on the gutter: 12pt for a 44pt icon cell around a 20pt glyph, 8pt for a text
 * action.
 */
export function ContentToolbar({
  title,
  children,
  edgeInset = theme.space[2],
  testID,
}: {
  title: ReactNode;
  children?: ReactNode;
  edgeInset?: number;
  testID?: string;
}) {
  return (
    <View style={[styles.row, { paddingRight: theme.layout.gutter - edgeInset }]} testID={testID}>
      <View style={styles.title}>{title}</View>
      {children ? <View style={styles.tools}>{children}</View> : null}
    </View>
  );
}

/**
 * **Filters, the compact action** (For You's since the nav cohesion sprint; Collection's
 * since the marquee cohesion sprint): the options glyph and the word, in secondary ink, a
 * 44pt target with no outline. With filters on it turns Maroon and counts them, and says
 * so to a screen reader as a selected state.
 *
 * The sort in force is not written beside it: the sheet it opens says that, one tap away.
 */
export function FiltersAction({
  activeCount,
  onPress,
  label = 'Filters',
  accessibilityLabel,
  accessibilityHint = 'Opens filters',
  testID,
}: {
  activeCount: number;
  onPress: () => void;
  /**
   * The word. "Filters" on For You; "Filters & Sort" on Collection, whose sheet holds the
   * sort as well (founder Preview QA, 2026-11-07).
   */
  label?: string;
  /** Defaults to "Filters" or "Filters, 2 on". */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}) {
  const on = activeCount > 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (on ? `Filters, ${activeCount} on` : 'Filters')}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={({ pressed }) => [styles.filters, pressed && styles.pressed]}
      testID={testID}
    >
      <Ionicons
        name="options-outline"
        size={theme.layout.icon.sm}
        color={on ? theme.semantic.action : theme.text.secondary}
      />
      <Text variant="subhead" tone={on ? 'action' : 'secondary'} numberOfLines={1}>
        {on ? `${label} · ${activeCount}` : label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space[2],
    minHeight: theme.layout.minTapTarget,
    paddingLeft: theme.layout.gutter,
    paddingTop: theme.space[2],
  },
  // Its own width, up to the whole row: a long title at a large text size wraps inside it.
  title: { flexShrink: 1, maxWidth: '100%' },
  // `auto` keeps the tools on the right gutter on the title's line and on a line of their own.
  // Never wider than the row: at the largest text sizes the tools wrap among themselves, right
  // aligned, so no target is pushed past the screen's edge (independent review 2).
  tools: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginLeft: 'auto',
    flexShrink: 1,
    maxWidth: '100%',
  },
  filters: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[1],
    minHeight: theme.layout.minTapTarget,
    paddingHorizontal: theme.space[2],
  },
  pressed: { opacity: 0.6 },
});
