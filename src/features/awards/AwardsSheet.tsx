import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { diagnose } from '@/lib/diagnose';
import { Button, EmptyState, Sheet, SkeletonRow, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

import { AwardRow } from './AwardRow';
import { AwardTitlesSheet } from './AwardTitlesSheet';
import { AWARD_TRACKS } from './tracks';
import { useAwards } from './use-awards';

export type AwardsSheetProps = {
  userId: string;
  /** Opens a title from a drill-down. Absent where the caller cannot navigate. */
  onPressTitle?: (mediaItemId: string) => void;
  onClose: () => void;
};

/**
 * Bingd Awards.
 *
 * Presented as the goals are — a heading, then a list of rows — so that "Movies in 2026"
 * and this read as two answers from the same product rather than two features that
 * arrived separately.
 *
 * **The heading is the name and nothing else.** It used to carry a line saying "6 awards
 * earned. Keep watching and the rest will turn up.", which the founder cut: a scoreline
 * at the top of a shelf turns the shelf into a report card, and the rows below already
 * say what is earned, one at a time, in the only place the number means anything.
 *
 * **Every track is here, always, in the founder's order.** The three that say what Bingd
 * is for are pinned at the top and never move; the other seventeen sit in fixed
 * category groups, earned above locked. Nothing is filtered and there is no control to
 * filter with: twenty rows is a scroll, and a filter over twenty rows costs more
 * attention than the thing it organises.
 *
 * **Nothing fires when an award is earned.** No notification, no feed event, no share,
 * no unlock ledger. An award is a reading of canonical data taken when this sheet opens
 * (`use-awards.ts`), which is what makes the whole feature a client-side delight layer
 * with no migration behind it — and what keeps an award from ever disagreeing with the
 * collection it describes.
 *
 * What a row *does* have behind it, as of this pass, is the list of titles that produced
 * its number — for the twelve tracks where that number is a set of titles. See
 * `AwardTitlesSheet`.
 */
export function AwardsSheet({ userId, onPressTitle, onClose }: AwardsSheetProps) {
  const awards = useAwards(userId);
  const list = awards.data?.awards ?? [];
  // Which row has been opened into its titles. Null is closed.
  const [inspecting, setInspecting] = useState<string | null>(null);

  const open = inspecting ? list.find((award) => award.trackKey === inspecting) : null;
  // Computed on demand rather than carried on every row: the contributors of a track
  // are the same array the metric filtered, and holding twelve of them on a list nobody
  // has tapped is twelve lists kept alive for a sheet that may never open.
  const openTitles =
    open && awards.data
      ? (AWARD_TRACKS.find((track) => track.key === open.trackKey)?.contributors?.(
          awards.data.facts,
        ) ?? [])
      : [];

  return (
    <Sheet visible onClose={onClose} label="Bingd Awards">
      <View style={styles.head}>
        <Text variant="title2">Bingd Awards</Text>
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
              body={
                diagnose(awards.error) ?? 'Something went wrong on the way to your collection.'
              }
              action={{ label: 'Try again', onPress: () => void awards.refetch() }}
            />
          </View>
        ) : null}

        {list.map((award) => (
          <AwardRow
            key={award.trackKey}
            award={award}
            // Pressable exactly where there is something behind it *and* somewhere for
            // a tapped title to go. Without a destination the drill-down would be a
            // list of rows that lead nowhere, which is the goals section's own rule.
            onPress={
              award.hasContributors && onPressTitle
                ? () => setInspecting(award.trackKey)
                : undefined
            }
          />
        ))}
      </ScrollView>

      <View style={styles.foot}>
        <Button label="Done" onPress={onClose} />
      </View>

      {/* The titles behind a number, from the same read that produced it — so the
            sheet cannot be open against a count it does not match.

            **Inside this sheet rather than beside it**, which was tried and is wrong.
            `Sheet` sets `accessibilityViewIsModal`, and two of them as siblings means
            the first one claims the accessibility tree and the second is hidden from it
            — the testing library reports exactly that, and on iOS VoiceOver behaves the
            same way. Nested, there is one modal context and the drill-down is part of
            it. */}
      {open && onPressTitle ? (
        <AwardTitlesSheet
          award={open}
          titles={openTitles}
          onPressTitle={(mediaItemId) => {
            setInspecting(null);
            onPressTitle(mediaItemId);
          }}
          onClose={() => setInspecting(null)}
        />
      ) : null}
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
  state: {
    paddingHorizontal: theme.layout.gutter,
    gap: theme.space[3],
    paddingVertical: theme.space[2],
  },
  foot: { paddingHorizontal: theme.layout.gutter, paddingTop: theme.space[3] },
});
