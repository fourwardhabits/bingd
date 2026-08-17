import { ScrollView, StyleSheet, View } from 'react-native';

import { formatWatchDate } from '@/features/collection/dates';
import { posterUri } from '@/lib/images';
import { Button, EmptyState, Sheet, Text, TitleRow } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { GOAL_LABEL, type GoalCategory } from './goals';
import type { QualifyingWatch } from './use-goals';

export type GoalTitlesSheetProps = {
  category: GoalCategory;
  year: number;
  /** Exactly the rows that produced the count, in the order the query returned them. */
  titles: QualifyingWatch[];
  onPressTitle: (mediaItemId: string) => void;
  onClose: () => void;
};

/**
 * What the number on a progress bar is made of.
 *
 * **The founder's correction, and it is about trust rather than navigation.** A bar
 * reading "12 of 52" is a claim about the reader's own year that they cannot check, and
 * the first thing anybody does with a count they doubt is try to enumerate it. Before
 * this the only way to do that was to scroll a collection and apply four rules by hand.
 *
 * **There are no exclusions here and there is no editing.** A row is present exactly
 * when `qualifyingWatches` counted it, which is the same traversal that produced the
 * number — not a second query that agrees today. The way to change what is in this list
 * is to change the watch it came from, on the title's own screen, which is where every
 * row leads. A "don't count this one" control on this sheet would be a fifth rule
 * living in the UI, invisible to every other surface that counts the same watches.
 *
 * The four rules are restated in one line at the top, because the question this sheet
 * exists to answer is usually "why is *that* one not in here" — and the answer is
 * almost always a missing watch date.
 */
export function GoalTitlesSheet({
  category,
  year,
  titles,
  onPressTitle,
  onClose,
}: GoalTitlesSheetProps) {
  const noun = category === 'movies' ? 'films' : 'seasons';

  return (
    <Sheet
      visible
      onClose={onClose}
      label={`${GOAL_LABEL[category]} that counted toward your ${year} goal`}
    >
      <View style={styles.head}>
        <Text variant="title2">
          {GOAL_LABEL[category]} in {year}
        </Text>
        <Text variant="footnote" tone="secondary">
          {titles.length === 1
            ? `One ${category === 'movies' ? 'film' : 'season'} counted.`
            : `${titles.length} ${noun} counted.`}{' '}
          A title counts once, on the date you say you watched it — so anything without a
          watch date is not here.
        </Text>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {titles.length === 0 ? (
          <View style={styles.empty}>
            <EmptyState
              kind="nothingYet"
              compact
              title={`Nothing counted yet in ${year}`}
              body={`Log a ${category === 'movies' ? 'film' : 'season'} with a watch date and it will appear here.`}
            />
          </View>
        ) : (
          titles.map((watch) => (
            <TitleRow
              key={watch.mediaItemId}
              title={watch.title}
              posterUri={posterUri(watch.posterPath)}
              // The date is the whole reason the row is in this list, so it is what the
              // row says about itself rather than a genre or a runtime.
              secondary={watch.watchedOn ? `Watched ${formatWatchDate(watch.watchedOn)}` : null}
              divided
              onPress={() => onPressTitle(watch.mediaItemId)}
            />
          ))
        )}
      </ScrollView>

      <View style={styles.actions}>
        <Button label="Close" kind="secondary" onPress={onClose} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: {
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[2],
    paddingBottom: theme.space[3],
    gap: theme.space[1],
  },
  // Bounded so a year of watching does not push the Close control off a sheet that is
  // already capped at 90% of the screen.
  list: { maxHeight: 380 },
  listContent: { paddingBottom: theme.space[2] },
  empty: { paddingHorizontal: theme.layout.gutter },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: theme.layout.gutter,
    paddingTop: theme.space[3],
    paddingBottom: theme.space[2],
  },
});
