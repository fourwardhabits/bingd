import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { bandSizes, scoreFor } from '@/features/collection/score';
import { useRankedCollection } from '@/features/collection/use-collection';
import { posterUri } from '@/lib/images';
import { compactName } from '@/lib/titles';
import { EmptyState, PosterGrid, SectionHeader, SegmentedTabs, SkeletonRow } from '@/ui/components';
import { theme } from '@/ui/tokens';

type Filter = 'all' | 'movies' | 'tv_seasons';

export type TopRankedProps = {
  userId: string;
  /** Somebody else's name, for the empty state. Null on the viewer's own profile. */
  otherName?: string | null;
  onPressTitle: (mediaItemId: string) => void;
};

/**
 * The best of somebody's collection, as one wall.
 *
 * **What this replaced showed the same information three times.** A poster wall of six,
 * then a Movies / TV segmented control, then the whole ranked list again as rows with a
 * score badge on each. A reader scrolling a profile met the same six films twice before
 * reaching anything new, and the list underneath was a second presentation of a thing
 * the wall had already said better. The founder's correction is one wall.
 *
 * The filter now changes the wall rather than switching to a different component.
 * **All** is the default and is the addition that made the rest coherent: movies and
 * seasons are separate rankings and a position only means anything inside its category
 * (PRD §11), so a mixed wall cannot be *ordered* — but it can show each category's best,
 * which is what somebody browsing a profile is looking for.
 *
 * Scores are computed per category against that category's whole band, never against
 * the slice on screen. Scoring six titles against themselves would give all six a 10.
 */
export function TopRanked({ userId, otherName, onPressTitle }: TopRankedProps) {
  const [filter, setFilter] = useState<Filter>('all');

  const movies = useRankedCollection(userId, 'movies');
  const seasons = useRankedCollection(userId, 'tv_seasons');

  const tiles = useMemo(() => {
    const movieRows = movies.data ?? [];
    const seasonRows = seasons.data ?? [];
    const movieSizes = bandSizes(movieRows);
    const seasonSizes = bandSizes(seasonRows);

    const toTile = (entry: (typeof movieRows)[number], sizes: ReturnType<typeof bandSizes>) => ({
      id: entry.mediaItemId,
      title:
        compactName({
          kind: entry.kind,
          title: entry.title,
          seriesTitle: entry.seriesTitle,
          seasonNumber: entry.seasonNumber,
        }) ?? entry.title,
      year: entry.year,
      posterUri: posterUri(entry.posterPath, 'card'),
      score: scoreFor(entry.bucket, entry.position, sizes),
      bucket: entry.bucket,
    });

    if (filter === 'movies') return movieRows.slice(0, WALL).map((row) => toTile(row, movieSizes));
    if (filter === 'tv_seasons') {
      return seasonRows.slice(0, WALL).map((row) => toTile(row, seasonSizes));
    }

    // All: each category's best, interleaved so the wall does not become "all the
    // films, then all the seasons" — which is the segmented control by another name.
    const top = [
      ...movieRows.slice(0, WALL).map((row) => ({ tile: toTile(row, movieSizes), rank: row.position })),
      ...seasonRows.slice(0, WALL).map((row) => ({ tile: toTile(row, seasonSizes), rank: row.position })),
    ];
    // By position within their own category, which is the only comparison that means
    // anything across the two — a #1 season and a #1 film are both somebody's best.
    return top.sort((a, b) => a.rank - b.rank).slice(0, WALL).map((entry) => entry.tile);
  }, [filter, movies.data, seasons.data]);

  const loading = movies.isPending || seasons.isPending;
  /**
   * Either half failing is the whole wall failing.
   *
   * `tiles` is built from `data ?? []`, so a read that came back an error produced an
   * empty wall and the empty wall said "Nothing ranked yet" — a sentence about how much
   * this person has ranked, printed because a request did not come back. On the founder's
   * own profile that was a wall of six titles reported as none.
   *
   * Not `&&`: half a wall is a ranking that silently omits somebody's best films, which
   * is the one thing a top-six cannot get wrong.
   */
  const failed = movies.isError || seasons.isError;
  const hasBoth = (movies.data?.length ?? 0) > 0 && (seasons.data?.length ?? 0) > 0;

  return (
    <View style={styles.section}>
      <SectionHeader title="Top ranked" />

      {/* Offered only where both halves have something. Somebody who has ranked only
          films is not asked to choose between Movies and TV seasons — the same rule the
          person page's filmography filter follows. */}
      {hasBoth ? (
        <View style={styles.tabs}>
          <SegmentedTabs
            options={[
              { id: 'all' as const, label: 'All' },
              { id: 'movies' as const, label: 'Movies' },
              { id: 'tv_seasons' as const, label: 'TV seasons' },
            ]}
            value={filter}
            onChange={setFilter}
          />
        </View>
      ) : null}

      {/* Error before loading, so one half failing while the other never settles cannot
          leave a skeleton on the screen for the rest of the session. */}
      {failed ? (
        <EmptyState
          kind="couldNotLoad"
          compact
          title="Could not load these rankings"
          body="Check your connection and try again."
          // Both, whichever one failed. They are one wall to the reader, and a retry that
          // repaired only the half that broke would redraw it against a stale other half.
          action={{
            label: 'Try again',
            onPress: () => {
              void movies.refetch();
              void seasons.refetch();
            },
          }}
        />
      ) : loading ? (
        <SkeletonRow count={3} />
      ) : tiles.length === 0 ? (
        <EmptyState
          kind="nothingYet"
          compact
          title="Nothing ranked yet"
          body={
            otherName
              ? `${otherName} has not ranked anything here yet.`
              : 'Rank a few titles and they will show up here.'
          }
        />
      ) : (
        <PosterGrid
          tiles={tiles}
          onPressTile={(tile) => onPressTitle(tile.id)}
        />
      )}
    </View>
  );
}

/** Six: two full rows of three. Three was a leftover from when this was a list. */
const WALL = 6;

const styles = StyleSheet.create({
  section: { paddingTop: theme.space[5], gap: theme.space[2] },
  tabs: { paddingBottom: theme.space[1] },
});
