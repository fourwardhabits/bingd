import { useQuery } from '@tanstack/react-query';
import { ScrollView, StyleSheet, View } from 'react-native';

import type { RankingCategory } from '@/features/collection/use-collection';
import { RankedSummaryRow } from '@/features/ranking/RankedSummary';
import { supabase } from '@/lib/supabase';
import { Sheet, SheetDone, SkeletonRow, Text } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * Every title one Unranked sitting ranked (`20261020000100`).
 *
 * **The rows are the completion summary's**, deliberately and literally — same component,
 * so the private payoff and the public list cannot drift into two different ideas of what
 * a ranked title looks like. Poster and name on the left, the canonical standing as
 * subdued secondary text, and the **current score in the maroon `ScoreBadge` on the
 * right**: the score is what the rest of bingd puts in that position, on a feed row, in a
 * collection and on a title page, and an ordinal there would be the one surface that
 * disagreed.
 *
 * The position and the score are read **now** rather than taken from the post, so a title
 * reranked since the sitting shows where it actually sits.
 *
 * It scrolls, because a sitting has no ceiling.
 */
export type RankingBatchTitle = {
  mediaItemId: string;
  title: string;
  posterPath: string | null;
  position: number | null;
  score: number | null;
  bucket: string | null;
};

export async function rankingBatchTitles(eventId: string): Promise<RankingBatchTitle[]> {
  const { data, error } = await supabase.rpc('ranking_batch_titles', { p_event_id: eventId });
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  return rows.map((row: Record<string, unknown>) => ({
    mediaItemId: String(row.media_item_id),
    title: String(row.title ?? ''),
    posterPath: (row.poster_path as string | null) ?? null,
    position: typeof row.position === 'number' ? row.position : null,
    score: typeof row.score === 'number' ? row.score : Number(row.score) || null,
    bucket: (row.bucket as string | null) ?? null,
  }));
}

export function RankingBatchSheet({
  eventId,
  medium,
  onClose,
}: {
  eventId: string | null;
  /** Which list the standings are in, for the `#7 in Movies` label. */
  medium: RankingCategory;
  onClose: () => void;
}) {
  const { data, isPending } = useQuery({
    queryKey: ['ranking-batch', eventId],
    enabled: Boolean(eventId),
    queryFn: () => rankingBatchTitles(eventId as string),
  });

  const titles = data ?? [];

  return (
    <Sheet visible={Boolean(eventId)} onClose={onClose} label="Ranked in this sitting">
      <ScrollView contentContainerStyle={styles.scroll} testID="ranking-batch-scroll">
        {isPending ? (
          <>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </>
        ) : titles.length === 0 ? (
          <Text variant="body" tone="secondary">
            Nothing to show here.
          </Text>
        ) : (
          <View style={styles.rows}>
            {titles.map((title) => (
              <RankedSummaryRow key={title.mediaItemId} title={title} medium={medium} />
            ))}
          </View>
        )}
      </ScrollView>
      {/* It had none at all (founder QA, 2026-09-25): a long sitting fills the screen,
          and swipe-to-dismiss alone is a weak way out of something that large. */}
      <SheetDone onPress={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[3] },
  rows: { gap: theme.space[1] },
});
