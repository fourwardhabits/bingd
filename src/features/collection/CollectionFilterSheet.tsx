import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { languageName } from '@/lib/language';
import { Button, Sheet, SortMenu, Text } from '@/ui/components';
import type { SortAxisSpec, SortState } from '@/ui/sort';
import { theme } from '@/ui/tokens';

import {
  emptyFilters,
  facetOptions,
  type CollectionFilters,
  type CollectionItem,
  type Decade,
} from './filters';
import { BUCKET_LABEL, type Bucket } from './score';

export type CollectionFilterSheetProps<Axis extends string = string> = {
  /** Every item *before* filtering, so the options describe the whole collection. */
  items: readonly CollectionItem[];
  /**
   * The filters currently applied, read once when the sheet opens.
   *
   * **This component must be mounted only while the sheet is open**, which is why
   * there is no `visible` prop. The draft is seeded by a `useState` initializer, and
   * an initializer runs on mount and never again — so a sheet that stayed mounted
   * would keep a draft the user abandoned: clear everything, cancel, reopen, and the
   * sheet would show no filters while the wall was still filtered, with Apply then
   * clearing them for real. The same defect in `GoalSheet` was found by independent
   * review on 2026-08-16, where it cost a stored goal rather than a filter.
   */
  value: CollectionFilters;
  /** Whether to offer rating filters — a watchlist has nothing ranked on it. */
  showBuckets: boolean;
  onApply: (next: CollectionFilters) => void;
  onClose: () => void;
  /**
   * **Sort, as the sheet's first section** — Collection's one Filter & Sort entry (founder,
   * UI cohesion pass, 2026-11-06). Absent for every other caller, whose sheet is unchanged.
   *
   * It applies as it always did: on the press, with no Apply. The sheet stays open so the
   * reader sees the order change and can press the same axis again to reverse it; only the
   * filters below wait for Apply, because only they ever did.
   */
  sort?: {
    axes: readonly SortAxisSpec<Axis>[];
    value: SortState<Axis>;
    onChange: (next: SortState<Axis>) => void;
    /** Pressing Shuffle while on it reshuffles. */
    onRepeatUndirected?: () => void;
  };
};

const BUCKETS: Bucket[] = ['loved', 'fine', 'not_for_me'];

/**
 * One filter sheet for every collection surface.
 *
 * Movies and TV, Watched and Watchlist, List and Wall all filter the same shape
 * through the same control — and the upcoming For You page is meant to reuse it
 * rather than grow a second one. What varies between surfaces is which facets have
 * anything to say, and that is decided from the data rather than by the caller:
 * a collection with no anime offers no Anime option, and a watchlist does not
 * show rating filters because nothing on it has a rating.
 *
 * **There is no Type section, and there was one until 2026-08-29.** It held Anime alone,
 * which implied a third medium beside Movies and TV that nothing in the app offers.
 * Anime is a genre now and arrives inside the Genre list with the rest;
 * `filters.ts` carries the reasoning and the one semantic that changed with it.
 *
 * Edits are local until Apply. A sheet that filtered live would re-sort the wall
 * under the reader while they were still choosing, and Clear all would have no
 * meaning distinct from unticking everything.
 */
export function CollectionFilterSheet<Axis extends string = string>({
  items,
  value,
  showBuckets,
  onApply,
  onClose,
  sort,
}: CollectionFilterSheetProps<Axis>) {
  const [draft, setDraft] = useState<CollectionFilters>(value);

  const options = facetOptions(items);

  const toggle = <T,>(list: T[], entry: T): T[] =>
    list.includes(entry) ? list.filter((one) => one !== entry) : [...list, entry];

  return (
    <Sheet
      visible
      onClose={onClose}
      label={sort ? 'Filter and sort your collection' : 'Filter your collection'}
    >
      {sort ? (
        <View style={styles.sortSection} testID="collection-sort-section">
          <Text variant="headline" accessibilityRole="header" style={styles.part}>
            Sort
          </Text>
          <SortMenu
            axes={sort.axes}
            value={sort.value}
            onChange={sort.onChange}
            // Stays open: the order changes behind the sheet, and a second press reverses.
            onClose={() => {}}
            onRepeatUndirected={sort.onRepeatUndirected}
          />
        </View>
      ) : null}
      {sort ? (
        <Text variant="headline" accessibilityRole="header" style={[styles.part, styles.filterPart]}>
          Filter
        </Text>
      ) : null}
      <ScrollView style={sort ? styles.bodyWithSort : styles.body} contentContainerStyle={styles.content}>
        {showBuckets ? (
          <Section title="Rating">
            {BUCKETS.map((bucket) => (
              <Option
                key={bucket}
                label={BUCKET_LABEL[bucket]}
                selected={draft.buckets.includes(bucket)}
                onPress={() => setDraft({ ...draft, buckets: toggle(draft.buckets, bucket) })}
              />
            ))}
          </Section>
        ) : null}

        {options.genres.length ? (
          <Section title="Genre">
            {options.genres.map(({ value: genre, count }) => (
              <Option
                key={genre}
                label={genre}
                count={count}
                selected={draft.genres.includes(genre)}
                onPress={() => setDraft({ ...draft, genres: toggle(draft.genres, genre) })}
              />
            ))}
          </Section>
        ) : null}

        {options.decades.length ? (
          <Section title="Decade">
            {options.decades.map(({ value: decade, count }) => (
              <Option
                key={decade}
                label={decade === 'earlier' ? 'Earlier' : decade}
                count={count}
                selected={draft.decades.includes(decade)}
                onPress={() =>
                  setDraft({ ...draft, decades: toggle(draft.decades, decade as Decade) })
                }
              />
            ))}
          </Section>
        ) : null}

        {options.languages.length > 1 ? (
          <Section title="Language">
            {options.languages.map(({ value: code, count }) => (
              <Option
                key={code}
                // Never the raw code. "ja" is a database value, not a word.
                label={languageName(code) ?? code}
                count={count}
                selected={draft.languages.includes(code)}
                onPress={() => setDraft({ ...draft, languages: toggle(draft.languages, code) })}
              />
            ))}
          </Section>
        ) : null}
      </ScrollView>

      <View style={styles.actions}>
        <Button
          label="Clear all"
          kind="secondary"
          onPress={() => setDraft(emptyFilters())}
        />
        <Button label="Apply" onPress={() => onApply(draft)} />
      </View>
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text variant="sectionHeader" tone="action">
        {title.toUpperCase()}
      </Text>
      <View style={styles.options}>{children}</View>
    </View>
  );
}

function Option({
  label,
  count,
  selected,
  onPress,
}: {
  label: string;
  count?: number;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={count == null ? label : `${label}, ${count}`}
      onPress={onPress}
      style={({ pressed }) => [styles.option, selected && styles.selected, pressed && styles.pressed]}
    >
      <Text variant="callout" tone={selected ? 'inverse' : 'primary'}>
        {label}
      </Text>
      {count != null ? (
        <Text variant="caption" tone={selected ? 'inverse' : 'tertiary'}>
          {count}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Bounded, so a collection with thirty genres does not make the sheet the page.
  body: { maxHeight: 420 },
  // Shorter under the Sort section, so the sheet as a whole still fits a small phone.
  bodyWithSort: { maxHeight: 340 },
  sortSection: { paddingBottom: theme.space[2] },
  /** The two parts' names: Sort, then Filter, each on the gutter. */
  part: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[2] },
  filterPart: { paddingBottom: theme.space[3] },
  content: { paddingBottom: theme.space[4], gap: theme.space[5] },
  section: { gap: theme.space[2], paddingHorizontal: theme.layout.gutter },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[2],
    minHeight: theme.layout.control.chipHeight,
    paddingHorizontal: theme.space[3],
    borderRadius: theme.radius.control,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: theme.border.hairline,
    backgroundColor: theme.surface.raised,
  },
  selected: { backgroundColor: theme.semantic.action, borderColor: theme.semantic.action },
  actions: {
    flexDirection: 'row',
    gap: theme.space[3],
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
  },
  pressed: { opacity: 0.7 },
});
