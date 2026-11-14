import { ScrollView, StyleSheet, View } from 'react-native';

import { Option, Section } from '@/features/collection/CollectionFilterSheet';
import type { Decade } from '@/features/collection/filters';
import { DismissFooter, Sheet, SortMenu, Text } from '@/ui/components';
import type { SortAxisSpec } from '@/ui/sort';
import { theme } from '@/ui/tokens';

import type { FilmographyAxis, FilmographySort } from './filmography';

export type FilmographyFilterSheetProps = {
  /** `filmographyAxes`: Popular, Release date and, where TMDB scores exist, Highest rated (TMDB). */
  axes: readonly SortAxisSpec<FilmographyAxis>[];
  sort: FilmographySort;
  onSort: (next: FilmographySort) => void;
  /** `filmographyDecades` over the list on screen. Fewer than two: no Filter part at all. */
  decadeOptions: readonly { value: Decade; count: number }[];
  decades: readonly Decade[];
  onDecades: (next: Decade[]) => void;
  onClose: () => void;
};

const SECTION = theme.layout.section;

/**
 * **A filmography's Filters & Sort** (FU1113-C): the Collection's sheet grammar, over what
 * a credit actually carries.
 *
 * - **Sort**, first: Popular, Release date and Highest rated (TMDB) — `filmography.ts`'s
 *   axes and comparators, unchanged. It applies on the press and the sheet stays open, so
 *   a second press of Release date reverses it, as the Collection's sort does. The rating
 *   is TMDB's and is labelled so; nothing here orders by, or names, a bingd score.
 * - **Filter**: Decade only, the one facet a credit supports (`filmographyDecades`), drawn
 *   by the Collection sheet's own `Section` / `Option`. A decade applies on the press too:
 *   this sheet's foot is the quiet Close (`DismissFooter`) rather than Apply, so nothing in
 *   it waits to be confirmed.
 *
 * The standard browsing height (`size="standard"`), with the footer pinned under the
 * scroll region. Mounted only while open.
 */
export function FilmographyFilterSheet({
  axes,
  sort,
  onSort,
  decadeOptions,
  decades,
  onDecades,
  onClose,
}: FilmographyFilterSheetProps) {
  const toggle = (decade: Decade) =>
    onDecades(
      decades.includes(decade) ? decades.filter((one) => one !== decade) : [...decades, decade],
    );

  return (
    <Sheet
      visible
      onClose={onClose}
      label="Filters and sort the filmography"
      size="standard"
      footer={<DismissFooter onPress={onClose} testID="filmography-filter-close" />}
    >
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.content}
        testID="filmography-filter-scroll"
      >
        <View testID="filmography-sort-section">
          <Text variant="headline" accessibilityRole="header" style={styles.part}>
            Sort
          </Text>
          <SortMenu
            axes={axes}
            value={sort}
            onChange={onSort}
            // Stays open: the order changes behind the sheet, and a second press reverses.
            onClose={() => {}}
          />
        </View>

        {decadeOptions.length > 1 ? (
          <View testID="filmography-decade-section" style={styles.filter}>
            <Text variant="headline" accessibilityRole="header" style={styles.part}>
              Filter
            </Text>
            <Section title="Decade">
              {decadeOptions.map(({ value, count }) => (
                <Option
                  key={value}
                  label={value === 'earlier' ? 'Earlier' : value}
                  count={count}
                  selected={decades.includes(value)}
                  onPress={() => toggle(value)}
                />
              ))}
            </Section>
          </View>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // Fills the standard sheet's content area and scrolls inside it, above the footer.
  body: { flex: 1 },
  content: {
    paddingTop: SECTION.above,
    paddingBottom: theme.space[4],
    gap: SECTION.between,
  },
  part: { paddingHorizontal: theme.layout.gutter },
  // The Filter heading sits a heading's distance from its section, as on the Collection.
  filter: { gap: SECTION.headingToControls },
});
