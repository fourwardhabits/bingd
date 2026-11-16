import { useQuery } from '@tanstack/react-query';
import { ScrollView, StyleSheet, View } from 'react-native';

import { posterUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';
import { Sheet, SheetDone, SkeletonRow, Text, TitleRow } from '@/ui/components';
import { theme } from '@/ui/tokens';

/**
 * Every title one watchlist post holds (`20261125000100`).
 *
 * The sheet the ranking sitting already opens, with the app's ordinary `TitleRow` inside
 * it: poster, name and year, and a tap goes to the title page. No reactions or comments
 * here — the conversation belongs to the post, and the post is behind this sheet.
 *
 * The members come from `watchlist_group_titles`, which applies the post's own visibility,
 * so this list can never show more than the Feed row itself would. In the order they were
 * saved, so the first is the title the row already named.
 */
export type WatchlistGroupTitle = {
  mediaItemId: string;
  kind: string | null;
  title: string;
  seasonNumber: number | null;
  year: number | null;
  posterPath: string | null;
  parentTitle: string | null;
};

const yearOf = (date: unknown): number | null => {
  if (typeof date !== 'string' || date.length < 4) return null;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) ? year : null;
};

export async function watchlistGroupTitles(eventId: string): Promise<WatchlistGroupTitle[]> {
  const { data, error } = await supabase.rpc('watchlist_group_titles', { p_event_id: eventId });
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  return rows.map((row: Record<string, unknown>) => ({
    mediaItemId: String(row.media_item_id),
    kind: (row.kind as string | null) ?? null,
    title: String(row.title ?? ''),
    seasonNumber: typeof row.season_number === 'number' ? row.season_number : null,
    year: yearOf(row.release_date),
    posterPath: (row.poster_path as string | null) ?? null,
    parentTitle: (row.parent_title as string | null) ?? null,
  }));
}

/** A season is named by its show, the way every other title row in the app names one. */
const rowTitle = (title: WatchlistGroupTitle) =>
  title.kind === 'season' && title.parentTitle ? title.parentTitle : title.title;

const rowSecondary = (title: WatchlistGroupTitle) =>
  title.kind === 'season' && title.seasonNumber ? `Season ${title.seasonNumber}` : undefined;

export function WatchlistGroupSheet({
  eventId,
  onPressTitle,
  onClose,
}: {
  eventId: string | null;
  /** Opens one member's title page. The caller closes the sheet first. */
  onPressTitle: (mediaItemId: string) => void;
  onClose: () => void;
}) {
  const { data, isPending } = useQuery({
    queryKey: ['watchlist-group', eventId],
    enabled: Boolean(eventId),
    queryFn: () => watchlistGroupTitles(eventId as string),
    // Read afresh every time the sheet opens (Codex, PR 310). A group keeps its id while it
    // grows, so the app-wide 60-second staleTime would reopen it on the members it had
    // before the post's count went up. The sheet is mounted only while open, so this is one
    // read per open and nothing in the background.
    staleTime: 0,
  });

  const titles = data ?? [];

  return (
    <Sheet visible={Boolean(eventId)} onClose={onClose} label="Added to their watchlist">
      <ScrollView contentContainerStyle={styles.scroll} testID="watchlist-group-scroll">
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
          <View testID="watchlist-group-rows">
            {titles.map((title) => (
              <TitleRow
                key={title.mediaItemId}
                title={rowTitle(title)}
                year={title.year}
                secondary={rowSecondary(title)}
                posterUri={posterUri(title.posterPath, 'card')}
                onPress={() => onPressTitle(title.mediaItemId)}
              />
            ))}
          </View>
        )}
      </ScrollView>
      <SheetDone onPress={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: theme.layout.gutter, paddingBottom: theme.space[3] },
});
