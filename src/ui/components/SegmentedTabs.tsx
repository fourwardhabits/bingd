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
 * Unranked. **One segmented control** (founder, QA corrections, 2026-11-06), replacing the
 * underlined text tabs of the cohesion pass, which read as quieter than the Filter & Sort
 * row beneath them. One hairline-outlined track across the gutters, split into equal
 * segments — halves for two, thirds for three; the chosen segment filled Parchment with
 * its label in Maroon, the others in secondary Ink on the Paper ground. Inter Medium
 * throughout, so choosing does not change a word's width. It is `CompactSwitch`'s
 * grammar (outline, inset fill, `surface.sunken`) at the size of a page's primary
 * navigation: no separate pills, no heavy border, no new colour.
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
      <View style={styles.navRow}>
        <View
          style={styles.navTrack}
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
                style={styles.navTab}
                testID={`nav-tab-${option.id}`}
              >
                {({ pressed }) => (
                  <View
                    style={[
                      styles.navFill,
                      selected && styles.navFillSelected,
                      pressed && !selected && styles.navPressed,
                    ]}
                    testID={`nav-fill-${option.id}`}
                  >
                    <Text
                      variant="callout"
                      tone={selected ? 'action' : 'secondary'}
                      numberOfLines={1}
                      /**
                       * **One line, always.** A long word at a large system text size
                       * shrinks before it would truncate — three segments on a 320pt
                       * phone are about 92pt each — and the label's own growth stops at
                       * 1.5×, so the control keeps one row and the page keeps its
                       * posters. The tabs' meaning never depends on reading a word at
                       * 300%: the chosen one is also the filled one.
                       */
                      adjustsFontSizeToFit
                      minimumFontScale={0.7}
                      maxFontSizeMultiplier={NAV_MAX_SCALE}
                      style={styles.navLabel}
                    >
                      {option.label}
                    </Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
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

/** Hairline outline, the inset between the outline and a fill, and the label's ceiling. */
const NAV_STROKE = StyleSheet.hairlineWidth * 2;
const NAV_INSET = 3;
const NAV_MAX_SCALE = 1.5;

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

  /** Full width, the gutters as its edges. */
  navRow: { paddingHorizontal: theme.layout.gutter },
  // The one shared control: a hairline outline around every segment, as CompactSwitch
  // draws its own, and the segments equal however many there are.
  navTrack: {
    flexDirection: 'row',
    paddingHorizontal: NAV_INSET / 2,
    borderRadius: theme.radius.card,
    borderWidth: NAV_STROKE,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.base,
  },
  // Each segment is its whole slice of the track, 44pt tall, so the target is the fill
  // and the inset around it; at a large text size it grows with its word.
  navTab: {
    flex: 1,
    flexBasis: 0,
    minHeight: theme.layout.minTapTarget,
    paddingVertical: NAV_INSET,
    paddingHorizontal: NAV_INSET / 2,
  },
  navFill: {
    flexGrow: 1,
    borderRadius: theme.radius.card - NAV_INSET,
    paddingHorizontal: theme.space[2],
    alignItems: 'center',
    justifyContent: 'center',
  },
  navFillSelected: { backgroundColor: theme.surface.sunken },
  navLabel: { fontFamily: fontFamily.sansMedium, fontSize: 15, lineHeight: 20, textAlign: 'center' },
  navPressed: { opacity: 0.6 },
});
