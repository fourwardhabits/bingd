import { useMemo } from 'react';

import { bandSizes, scoreFor } from '@/features/collection/score';
import { useRankedCollection } from '@/features/collection/use-collection';
import { posterUri } from '@/lib/images';
import { PosterShelf } from '@/ui/components';

import { useTrending } from './use-trending';

export type TrendingShelfProps = {
  userId: string;
  onPressTitle: (mediaItemId: string) => void;
  /**
   * Passed through to `PosterShelf`.
   *
   * The Feed draws this shelf's heading in its own content header row, opposite the
   * Feed/Leaderboard toggle, so the shelf must not draw it a second time. The shelf keeps
   * its accessible name either way.
   */
  showTitle?: boolean;
};

/**
 * "Trending now" above the social feed.
 *
 * **It fails silently, on purpose.** No skeleton, no error block, no empty state: if
 * the list cannot be read, the shelf is simply not there and the Feed is the Feed. An
 * error card at the top of the social feed would push the thing the user came for
 * below the fold in order to report a discovery strip they did not ask for, and a
 * skeleton would do the same thing for a second on every cold open. Nothing here is
 * the user's own data, so nothing here is worth interrupting them about.
 *
 * A stale list — past its six-hour TTL because the adapter's schedule slipped — is
 * shown as-is. It is what TMDB was featuring a few hours ago, which is what the shelf
 * claims to within a rounding error. Anything older than a week is dropped upstream in
 * `use-trending`, where "Trending now" stops being defensible.
 *
 * Films the viewer has ranked carry their own score, the same chip the Collection wall
 * uses. Trending TV is series-level and a series is never ranked (PRD §10), so those
 * tiles are bare — which is a property of the data, not a case handled here.
 */
export function TrendingShelf({ userId, onPressTitle, showTitle = true }: TrendingShelfProps) {
  const trending = useTrending();
  const ranked = useRankedCollection(userId, 'movies');

  const scores = useMemo(() => {
    const entries = ranked.data ?? [];
    // Band sizes come from the whole ranking, for the reason Profile records: a score
    // is only meaningful against every title in its band.
    const sizes = bandSizes(entries);
    return new Map(
      entries.map((entry) => [entry.mediaItemId, scoreFor(entry.bucket, entry.position, sizes)]),
    );
  }, [ranked.data]);

  const items = trending.data?.items ?? [];
  if (items.length === 0) return null;

  return (
    <PosterShelf
      title="Trending now"
      showTitle={showTitle}
      tiles={items.map((item) => ({
        id: item.mediaItemId,
        title: item.title,
        year: item.year,
        posterUri: posterUri(item.posterPath, 'card'),
        score: scores.get(item.mediaItemId) ?? null,
      }))}
      onPressTile={(tile) => onPressTitle(tile.id)}
    />
  );
}
