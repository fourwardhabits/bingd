import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { fontFamily, theme } from '../tokens';
import { Text } from './Text';

export type SegmentOption<T extends string> = {
  id: T;
  label: string;
  /**
   * What a screen reader hears instead of the label.
   *
   * Optional, and only supplied where the label carries a glyph that does not read as a
   * sentence — the review sort row's `Top ↓`, whose direction is visual and whose spoken
   * form is `Top, most helpful first`. That is rule 5 of the sort contract in `ui/sort.ts`:
   * the arrow is a two-state indicator, and a person who cannot see it is owed the words.
   * Every other caller passes nothing and is unchanged.
   */
  accessibilityLabel?: string;
};

/**
 * How loudly a tab row reads, and the two classes bingd. has.
 *
 * `secondary` — the default, and what every caller before 2026-09-06 got. Subordinate,
 * mutually-exclusive state *within* whatever universe is already selected: Watched and
 * Watchlist inside a collection, Cast and Reviews inside a title. `callout`, with the
 * unselected label in tertiary grey and a 2pt rule.
 *
 * `primary` — the control that switches the **primary content universe** being browsed.
 * Movies and TV on Collection and For You, and nothing else. It replaced a dropdown, so
 * it has to hold the position and the weight a screen title held: `title2`, ink when
 * selected, and a 3pt rule.
 *
 * `nav` — a page's own sections across the full width: Collection's Watched | Watchlist |
 * Unranked (founder, UI cohesion pass, 2026-11-06). Equal columns, each label centred;
 * the chosen one in Maroon over a thin Maroon rule the width of its word, the others in
 * secondary Ink. Inter Medium at 15pt, so it reads as navigation rather than as a title,
 * and no fill, outline or pill anywhere.
 *
 * **The distinction is semantic, not decorative** (founder addendum, 2026-09-06). A
 * reader should be able to tell "take me to this content" from "narrow what I am looking
 * at" without reading the labels, which is also why Search's All/Movies/TV/People stayed
 * filter *chips* and did not become either of these.
 */
export type SegmentedTabsVariant = 'primary' | 'secondary' | 'nav';

export type SegmentedTabsProps<T extends string> = {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /**
   * Defaults to `secondary`, which is exactly what every existing caller was drawn as
   * before this prop existed — so adding it changed no screen that did not ask.
   */
  variant?: SegmentedTabsVariant;
  /** Announced to screen readers as the name of the tab set. */
  accessibilityLabel?: string;
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
export function SegmentedTabs<T extends string>({
  options,
  value,
  onChange,
  variant = 'secondary',
  accessibilityLabel,
}: SegmentedTabsProps<T>) {
  const primary = variant === 'primary';

  if (variant === 'nav') {
    return (
      <View
        style={styles.navRow}
        accessibilityRole="tablist"
        accessibilityLabel={accessibilityLabel}
        testID="nav-tabs"
      >
        {options.map((option) => {
          const selected = option.id === value;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="tab"
              accessibilityLabel={option.accessibilityLabel}
              accessibilityState={{ selected }}
              onPress={() => onChange(option.id)}
              style={({ pressed }) => [styles.navTab, pressed && !selected && styles.navPressed]}
              testID={`nav-tab-${option.id}`}
            >
              {/* The rule is the word's width: a stretch inside a box that shrinks to the
                  label, so it underlines what is chosen rather than the whole column. */}
              <View style={styles.navLabelBox}>
                <Text
                  variant="callout"
                  tone={selected ? 'action' : 'secondary'}
                  numberOfLines={1}
                  // A long word at a large system text size shrinks a little before it
                  // would truncate; three columns on a 320pt phone are 96pt each.
                  adjustsFontSizeToFit
                  minimumFontScale={0.8}
                  style={styles.navLabel}
                >
                  {option.label}
                </Text>
                <View style={[styles.navRule, selected && styles.underlineActive]} />
              </View>
            </Pressable>
          );
        })}
      </View>
    );
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      alwaysBounceHorizontal={false}
      style={styles.scroll}
    >
      <View
        style={[styles.row, primary && styles.rowPrimary]}
        accessibilityRole="tablist"
        accessibilityLabel={accessibilityLabel}
      >
        {options.map((option) => {
          const selected = option.id === value;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="tab"
              accessibilityLabel={option.accessibilityLabel}
              accessibilityState={{ selected }}
              onPress={() => onChange(option.id)}
              style={styles.tab}
            >
              <Text
                variant={primary ? 'title2' : 'callout'}
                /**
                 * **Both peers read as peers.** The unselected primary tab is
                 * `secondary`, not `tertiary`: at `title2` the lighter grey makes the
                 * inactive side look disabled rather than merely not-current, and
                 * Movies and TV are equally important modes — the founder's rule that
                 * Movies must not be privileged for being first.
                 */
                tone={selected ? 'primary' : primary ? 'secondary' : 'tertiary'}
              >
                {option.label}
              </Text>
              <View
                style={[
                  styles.underline,
                  primary && styles.underlinePrimary,
                  selected && styles.underlineActive,
                ]}
              />
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
  /**
   * The primary row sits where a screen title used to and carries that weight, so it
   * gets a title's air above it and a wider gap between two large words. Not taller
   * overall than the dropdown it replaced: `MediumSelector` at `title` size drew a
   * `title1` line plus a chevron in this same band.
   */
  rowPrimary: { gap: theme.space[6], paddingTop: theme.space[2] },
  // Always present, so selecting a tab does not shift the row by two points.
  underline: {
    height: 2,
    alignSelf: 'stretch',
    borderRadius: theme.radius.full,
    backgroundColor: 'transparent',
  },
  // One point thicker under a much larger word, so the primary rule reads as the
  // heavier of the two when both rows are stacked on Collection.
  underlinePrimary: { height: 3 },
  underlineActive: { backgroundColor: theme.semantic.action },

  /** Full width, the gutters as its edges, the columns equal however many there are. */
  navRow: { flexDirection: 'row', paddingHorizontal: theme.layout.gutter },
  navTab: {
    flex: 1,
    flexBasis: 0,
    minHeight: theme.layout.minTapTarget,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: theme.space[1],
  },
  navLabelBox: { alignItems: 'stretch', gap: theme.space[1] + 2, maxWidth: '100%' },
  navLabel: { fontFamily: fontFamily.sansMedium, fontSize: 15, lineHeight: 20, textAlign: 'center' },
  // Always present, so choosing a tab does not move its word by two points.
  navRule: { height: 2, borderRadius: theme.radius.full, backgroundColor: 'transparent' },
  navPressed: { opacity: 0.6 },
});
