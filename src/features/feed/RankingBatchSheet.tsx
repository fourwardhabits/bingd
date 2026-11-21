import { useQuery } from '@tanstack/react-query';
import { ScrollView, StyleSheet, View } from 'react-native';

import type { RankingCategory } from '@/features/collection/use-collection';
import { shouldMask, useWatched } from '@/features/collection/use-watched';
import { RankedSummaryRow } from '@/features/ranking/RankedSummary';
import { supabase } from '@/lib/supabase';
import { Sheet, SheetDone, SkeletonRow, SpoilerNote, Text } from '@/ui/components';
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
  /**
   * The title's own ladder (20261128000100). A group may span movies, shows and seasons
   * since then, so each standing is labelled by its own list; null from an older backend,
   * when the sheet's `medium` stands in as it always did.
   */
  category: RankingCategory | null;
};

const CATEGORIES: readonly RankingCategory[] = ['movies', 'tv_seasons', 'tv_shows'];

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
    category: CATEGORIES.includes(row.category as RankingCategory)
      ? (row.category as RankingCategory)
      : null,
  }));
}

/** One published review, as `public_notes` returns it. */
export type BatchReview = { text: string; hasSpoilers: boolean };

/**
 * **The author's reviews of a group's titles** (20261130000800).
 *
 * A reviewed first ranking now joins its half-hour group instead of posting a card of its
 * own, so its review is read here, under its own title. `public_notes` is the only
 * cross-user path to a note and answers only for what this reader may read (blocks,
 * private accounts, suspension, the note's own visibility), exactly as the standalone card
 * read it. At most fifty titles, the function's limit; a sheet rarely holds more, and a
 * title past that simply shows no review here (the title page still has it).
 */
export async function batchReviews(
  actorId: string,
  mediaItemIds: string[],
): Promise<Map<string, BatchReview>> {
  const out = new Map<string, BatchReview>();
  const ids = [...new Set(mediaItemIds)].slice(0, 50);
  if (!ids.length) return out;
  const { data, error } = await supabase.rpc('public_notes', {
    p_user_ids: [actorId],
    p_media_item_ids: ids,
    p_limit: 100,
  });
  if (error) throw error;
  for (const row of (Array.isArray(data) ? data : []) as Record<string, unknown>[]) {
    if (row.user_id !== actorId || typeof row.note !== 'string') continue;
    out.set(String(row.media_item_id), {
      text: row.note,
      hasSpoilers: row.has_spoilers === true,
    });
  }
  return out;
}

export function RankingBatchSheet({
  eventId,
  medium,
  actorId,
  viewerId,
  onClose,
}: {
  eventId: string | null;
  /** Which list the standings are in, for the `#7 in Movies` label. */
  medium: RankingCategory;
  /**
   * Whose group this is. Given (with `viewerId`), each title's published review is shown
   * under its row, masked for spoilers exactly as the Feed masks it.
   */
  actorId?: string;
  /** The reader, for the spoiler mask. */
  viewerId?: string;
  onClose: () => void;
}) {
  const { data, isPending } = useQuery({
    queryKey: ['ranking-batch', eventId],
    enabled: Boolean(eventId),
    queryFn: () => rankingBatchTitles(eventId as string),
    // Read afresh every time the sheet opens (Codex, PR 311). A published sitting can now
    // grow in place when a later sitting joins it (20261126000100), keeping its id, so the
    // app-wide 60-second staleTime would reopen it on the members it had before the post's
    // count went up. Mounted only while open: one read per open, nothing in the background.
    staleTime: 0,
  });

  const titles = data ?? [];
  const titleIds = titles.map((title) => title.mediaItemId);
  const reviews = useQuery({
    queryKey: ['ranking-batch-reviews', eventId, actorId, titleIds.join(',')],
    enabled: Boolean(eventId && actorId && titleIds.length),
    queryFn: () => batchReviews(actorId as string, titleIds),
    // As fresh as the titles: a review written since the sheet last opened shows at once.
    staleTime: 0,
  });
  const watched = useWatched(viewerId ?? '');

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
            {titles.map((title) => {
              const review = reviews.data?.get(title.mediaItemId) ?? null;
              return (
                <View key={title.mediaItemId}>
                  <RankedSummaryRow title={title} medium={title.category ?? medium} />
                  {review && actorId ? (
                    <View style={styles.review} testID="ranking-batch-review">
                      <SpoilerNote
                        text={review.text}
                        hasSpoilers={review.hasSpoilers}
                        masked={shouldMask({
                          hasSpoilers: review.hasSpoilers,
                          mediaItemId: title.mediaItemId,
                          viewerId: viewerId ?? '',
                          authorId: actorId,
                          watched: watched.data,
                        })}
                        numberOfLines={4}
                        titleForLabel={title.title}
                      />
                    </View>
                  ) : null}
                </View>
              );
            })}
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
  // Under its own row, aligned with the title's name rather than the poster.
  review: {
    paddingLeft: theme.poster.row.width + theme.space[3],
    paddingBottom: theme.space[2],
  },
});
