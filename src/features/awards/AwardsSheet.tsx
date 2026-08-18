import { ScrollView, StyleSheet, View } from 'react-native';

import { diagnose } from '@/lib/diagnose';
import { Button, EmptyState, Sheet, SkeletonRow, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { AwardRow } from './AwardRow';
import { earnedSummary } from './progress';
import { useAwards } from './use-awards';

export type AwardsSheetProps = {
  userId: string;
  onClose: () => void;
};

/**
 * Bingd Awards.
 *
 * Presented as the goals are — a heading, a line of context, then a list of rows — so
 * that "Movies in 2026" and this read as two answers from the same product rather than
 * two features that arrived separately.
 *
 * **Every track is here, always, in the founder's order.** Earned first, then locked by
 * how close they are. Nothing is filtered and there is no control to filter with: twenty
 * rows is a scroll, and a filter over twenty rows is a control that costs more attention
 * than the thing it organises. The sort is the organisation.
 *
 * **There is nothing behind a row and nothing that fires when one is earned.** No
 * notification, no feed event, no share, no unlock ledger. An award is a reading of
 * canonical data taken when this sheet opens (`use-awards.ts`), which is what makes the
 * whole feature a client-side delight layer with no migration behind it — and what keeps
 * an award from ever disagreeing with the collection it describes.
 */
export function AwardsSheet({ userId, onClose }: AwardsSheetProps) {
  const awards = useAwards(userId);
  const list = awards.data?.awards ?? [];
  const summary = earnedSummary(list);

  return (
    <Sheet visible onClose={onClose} label="Bingd Awards">
      <View style={styles.head}>
        <Text variant="title2">Bingd Awards</Text>
        <Text variant="footnote" tone="secondary">
          {/* The summary when there is one, and an invitation when there is not.
              "0 awards earned" is a scoreline against somebody who has just arrived. */}
          {summary
            ? `${summary}. Keep watching and the rest will turn up.`
            : 'Watch, rank and talk about things. These fill themselves in.'}
        </Text>
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {awards.isPending ? (
          <View style={styles.state}>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </View>
        ) : null}

        {awards.isError ? (
          <View style={styles.state}>
            <EmptyState
              kind="couldNotLoad"
              compact
              title="Could not load your awards"
              body={diagnose(awards.error) ?? 'Something went wrong on the way to your collection.'}
              action={{ label: 'Try again', onPress: () => void awards.refetch() }}
            />
          </View>
        ) : null}

        {list.map((award) => (
          <AwardRow key={award.trackKey} award={award} />
        ))}
      </ScrollView>

      <View style={styles.foot}>
        <Button label="Done" onPress={onClose} />
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
  list: { flexGrow: 0 },
  listContent: { paddingBottom: theme.space[2] },
  state: { paddingHorizontal: theme.layout.gutter, gap: theme.space[3], paddingVertical: theme.space[2] },
  foot: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[3] },
});
