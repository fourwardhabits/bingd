import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { FilterIconButton } from './FilterIconButton';

/**
 * **A browsing page's content toolbar**: its marquee title on the left gutter and its tools
 * on the right one (founder, marquee cohesion sprint, 2026-11-07).
 *
 *     Watched ▾                                   ⚙   ▦ ☰
 *     Recommended ▾                                     ⚙
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
 * lands on the gutter: 12pt for a 44pt icon cell around a 20pt glyph (Filters is one since
 * FU1113-B), 8pt for a text action.
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
 * **Filters, the compact action** — icon-only since FU1113-B (2026-11-13).
 *
 * It renders `FilterIconButton`: the options glyph alone in a 44pt cell, Maroon with a
 * count when filters are on, and that state spoken. Its props are unchanged so every
 * caller went icon-only without an edit; `label` is now only what a screen reader hears
 * ("Filters & Sort" is said "Filters and sort").
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
  /** The spoken name. "Filters" on For You; "Filters & Sort" on Collection. Never printed. */
  label?: string;
  /** Overrides the spoken name entirely; it is then expected to state the count itself. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}) {
  return (
    <FilterIconButton
      activeCount={activeCount}
      onPress={onPress}
      accessibilityLabel={accessibilityLabel ?? spokenFilterLabel(label)}
      announceCount={accessibilityLabel == null}
      accessibilityHint={accessibilityHint}
      testID={testID}
    />
  );
}

/** "Filters & Sort" → "Filters and sort": how the word is said, not how it was printed. */
const spokenFilterLabel = (label: string) => {
  const [first, ...rest] = label.replace(/\s*&\s*/g, ' and ').split(' ');
  return [first, ...rest.map((word) => word.toLowerCase())].join(' ');
};

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
});
