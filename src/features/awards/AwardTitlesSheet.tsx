import { ScrollView, StyleSheet, View } from 'react-native';

import { posterUri } from '@/lib/images';
import { compactName } from '@/lib/titles';
import { Button, EmptyState, Sheet, Text, TitleRow } from '@/ui/components';
import { theme } from '@/ui/tokens';

import type { AwardProgress } from './progress';
import type { WatchedTitle } from './tracks';

export type AwardTitlesSheetProps = {
  award: AwardProgress;
  /** Exactly the titles the metric counted, from the same facts that produced it. */
  titles: readonly WatchedTitle[];
  onPressTitle: (mediaItemId: string) => void;
  onClose: () => void;
};

/**
 * What an award's number is made of.
 *
 * **The same argument as the goals drill-down, and the founder asked for the same
 * answer.** A row reading "84 / 200" is a claim about somebody's own collection that
 * they cannot check, and the first thing anybody does with a count they doubt is try to
 * enumerate it. Before this the only way was to scroll Collection and apply the award's
 * rule by hand — which for Passport Mode means knowing every title's original language.
 *
 * **Only where the number is genuinely a set of titles.** Twelve tracks have one; the
 * seven counting invites, reactions, mutual follows, recommendations, rankings, writing
 * and the watchlist do not, because Bingd has no privacy-safe surface listing who
 * reacted to what and building one for a badge would be a social analytics subsystem
 * arriving through a side door. Genre Gremlin has none either: its number is genres, and
 * a list of titles under "8 / 14" would be a list whose length disagrees with the count
 * above it.
 *
 * **There is no editing and nothing is excluded here.** A row is present exactly when
 * the metric counted it, from the same `AwardFacts` snapshot — not a second query that
 * happens to agree today. The way to change what is in this list is to change the
 * collection it came from, on the title's own screen, which is where every row leads.
 */
export function AwardTitlesSheet({
  award,
  titles,
  onPressTitle,
  onClose,
}: AwardTitlesSheetProps) {
  return (
    <Sheet visible onClose={onClose} label={`Titles that counted toward ${award.displayName}`}>
      <View style={styles.head}>
        <Text variant="title2">{award.displayName}</Text>
        <Text variant="footnote" tone="secondary">
          {/* The count, and then the goal it is counting toward — the same two facts the
              row carried, so opening it never looks like arriving at a different award. */}
          {titles.length === 1 ? '1 title counted.' : `${titles.length} titles counted.`}{' '}
          {award.detailLine}
        </Text>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {titles.length === 0 ? (
          <View style={styles.empty}>
            <EmptyState
              kind="nothingYet"
              compact
              title="Nothing counted yet"
              body="Log something that fits and it will appear here."
            />
          </View>
        ) : (
          titles.map((title) => (
            <TitleRow
              key={title.mediaItemId}
              // The show and the season, never a column of rows called "Season 2".
              title={
                compactName({
                  kind: title.kind,
                  title: title.title,
                  seriesTitle: title.seriesTitle,
                  seasonNumber: title.seasonNumber,
                }) ?? title.title
              }
              year={title.year}
              posterUri={posterUri(title.posterPath)}
              divided
              onPress={() => onPressTitle(title.mediaItemId)}
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
  // Bounded, so a thousand films does not push the Close control off a sheet that is
  // already capped at 90% of the screen. The same figure the goals drill-down uses.
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
