import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { theme } from '../tokens';
import { Text } from './Text';

export type SegmentOption<T extends string> = { id: T; label: string };

export type SegmentedTabsProps<T extends string> = {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
};

/**
 * The tabs under a screen's title (screens.md §5).
 *
 * Underline rather than a filled pill. The filled version competed with the
 * score badges in the list below it — two rounded, tinted shapes in the same
 * column of the screen, one of which carries meaning and one of which is
 * navigation. An underline is unmistakably chrome.
 *
 * **The row scrolls sideways when it does not fit, and only then.**
 *
 * This is a flex row with a fixed gap and no wrap, so a row wider than the screen ran
 * off the right edge and took its last tab with it — silently, because nothing here
 * clips visibly and nothing warns. A season page carries five tabs (Episodes, Cast,
 * Reviews, Videos, Details), which is past what a 320pt phone holds; so is a shorter
 * row once a reader raises their system text size, because the labels scale and the
 * gap does not.
 *
 * A `ScrollView` is the whole of the fix. When the tabs already fit, the content is
 * narrower than the viewport, it stays left-aligned, and nothing about the layout
 * changes — which is the property that matters, because every other screen using this
 * component was drawn against a row that fits. `alwaysBounceHorizontal={false}` is
 * part of that: without it iOS rubber-bands a row with nowhere to go, which would be
 * a new behaviour on screens that never asked for one.
 *
 * The `tablist` role stays on the inner row rather than moving to the scroll view, so
 * the accessibility tree keeps the shape it had: a list of tabs, not a scroll area
 * that happens to contain some.
 */
export function SegmentedTabs<T extends string>({ options, value, onChange }: SegmentedTabsProps<T>) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      alwaysBounceHorizontal={false}
      style={styles.scroll}
    >
      <View style={styles.row} accessibilityRole="tablist">
        {options.map((option) => {
          const selected = option.id === value;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => onChange(option.id)}
              style={styles.tab}
            >
              <Text variant="callout" tone={selected ? 'primary' : 'tertiary'}>
                {option.label}
              </Text>
              <View style={[styles.underline, selected && styles.underlineActive]} />
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // `flexGrow: 0` so the scroll view takes its height from the tabs. A ScrollView
  // otherwise expands into whatever a flexible parent offers it, which on the title
  // page is the rest of the screen.
  scroll: { flexGrow: 0 },
  row: {
    flexDirection: 'row',
    gap: theme.space[5],
    paddingHorizontal: theme.layout.gutter,
  },
  tab: {
    minHeight: theme.layout.minTapTarget,
    justifyContent: 'center',
    alignItems: 'center',
    gap: theme.space[1],
  },
  // Always present, so selecting a tab does not shift the row by two points.
  underline: {
    height: 2,
    alignSelf: 'stretch',
    borderRadius: theme.radius.full,
    backgroundColor: 'transparent',
  },
  underlineActive: { backgroundColor: theme.semantic.action },
});
