import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { bandSizes, projectedScore, scoreFor } from '@/features/collection/score';
import { useRankedCollection } from '@/features/collection/use-collection';
import { projectShows, type ShowProjection } from '@/features/collection/show-projection';
import { posterUri } from '@/lib/images';
import { compactName } from '@/lib/titles';
import {
  EmptyState,
  PosterGrid,
  SectionHeader,
  type SectionHeaderSize,
  SegmentedTabs,
  SkeletonRow,
} from '@/ui/components';
import { theme } from '@/ui/tokens';

type Filter = 'all' | 'movies' | 'tv_seasons';

export type TopRankedProps = {
  userId: string;
  /** Somebody else's name, for the empty state. Null on the viewer's own profile. */
  otherName?: string | null;
  onPressTitle: (mediaItemId: string) => void;
  /**
   * Opens the whole ranked list for one category (founder, 2026-08-29).
   *
   * Omitted by a caller with nowhere to send the reader, in which case no control is
   * drawn and the wall stays exactly what it was. Where it is supplied it still appears
   * only when there is genuinely more to see — see `seeAll`.
   */
  onSeeAll?: (category: 'movies' | 'tv_seasons') => void;
  /**
   * The heading's size: `large` on the reader's own Profile tab only (founder final
   * polish, 2026-11-04). Somebody else's profile draws this section too, and keeps the
   * standard 12pt heading.
   */
  headingSize?: SectionHeaderSize;
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
 * **All** is the default, and it is one list ordered by score.
 *
 * It used to order by `position` — rank inside its own category — on the argument that a
 * #1 season and a #1 film are both somebody's best, and that a mixed wall therefore
 * cannot be *ordered* at all (PRD §11). Positions genuinely are not comparable across
 * categories, but that was the wrong conclusion, because the thing the wall prints is not
 * a position: every tile carries a score, and a score is comparable. Ordering by position
 * put a 9.9 above a 10.0 whenever the two bands were different sizes, which is what
 * physical QA found on somebody else's profile — a *loved* band of 61 seasons beside one
 * of 44 films makes season #2 a 10.0 and film #2 a 9.9, and the interleave printed the
 * film first. A number on screen above a larger number on screen is wrong however it is
 * defended, and it was only ever invisible on profiles whose two bands happened to be
 * close in size.
 *
 * So All collects both categories, orders by the score each tile shows, and only then
 * takes the six. **Movies and TV still order themselves**, where position order and score
 * order are the same thing by construction.
 *
 * Scores are computed per category against that category's whole band, never against
 * the slice on screen. Scoring six titles against themselves would give all six a 10.
 */
export function TopRanked({
  userId,
  otherName,
  onPressTitle,
  onSeeAll,
  headingSize,
}: TopRankedProps) {
  const [filter, setFilter] = useState<Filter>('all');

  const movies = useRankedCollection(userId, 'movies');
  const seasons = useRankedCollection(userId, 'tv_seasons');
  // The whole shows (20261114000100). With the seasons they make one poster per series
  // (WS-TVC, `projectShows`): the explicit show score, else the ranked seasons' mean.
  const shows = useRankedCollection(userId, 'tv_shows');
  /** One entry per series, over the two whole pools: no request and no per-series work. */
  const series = useMemo(
    () => projectShows(seasons.data ?? [], shows.data ?? []),
    [seasons.data, shows.data],
  );

  const tiles = useMemo(() => {
    const movieRows = movies.data ?? [];
    const movieSizes = bandSizes(movieRows);

    const movieTile = (entry: (typeof movieRows)[number]) => ({
      id: entry.mediaItemId,
      // The canonical compact form, as every wall names a title.
      title:
        compactName({
          kind: entry.kind,
          title: entry.title,
          seriesTitle: entry.seriesTitle,
          seasonNumber: entry.seasonNumber,
        }) ?? entry.title,
      year: entry.year,
      posterUri: posterUri(entry.posterPath, 'card'),
      score: scoreFor(entry.bucket, entry.position, movieSizes),
      bucket: entry.bucket,
      season: null,
    });
    /**
     * **One tile per series** (WS-TVC): the series' poster and name, its effective score,
     * and the pill that says which kind of score it is — filled for an explicit show
     * ranking, outlined `AVG` for the mean of its ranked seasons. Seasons are never tiles.
     */
    const seriesTile = (p: ShowProjection) => ({
      id: p.seriesId,
      title: p.title,
      year: p.year,
      posterUri: posterUri(p.posterPath, 'card'),
      score: p.display,
      bucket: p.bucket,
      season: null,
      scoreSource: p.source,
      rankedSeasonCount: p.rankedSeasonCount,
    });

    if (filter === 'movies') return movieRows.slice(0, WALL).map(movieTile);
    // The projection is already in the Rating order: exact score, explicit first, then
    // position, title and id (`compareShowProjections`).
    if (filter === 'tv_seasons') return series.slice(0, WALL).map(seriesTile);

    // All: both categories as one list, ordered by the score the tile will print.
    //
    // Neither half is sliced before the sort: the defect this replaced was exactly a limit
    // applied before an order. A film is compared by its *unrounded* projection, so each
    // pool keeps its own ranked order (a #1 and a #2 both print 10.0 in a band of a
    // hundred); a series by its exact effective score, which is what its tile prints
    // before rounding. An exact tie falls to a fixed order — films, then series — and then
    // the id, never to which read resolved first.
    const all = [
      ...movieRows.map((row) => ({
        key: projectedScore(row.bucket, row.position, movieSizes),
        pool: 0,
        id: row.mediaItemId,
        tile: () => movieTile(row),
      })),
      ...series.map((p) => ({ key: p.score, pool: 1, id: p.seriesId, tile: () => seriesTile(p) })),
    ];
    return all
      .sort((a, b) => b.key - a.key || a.pool - b.pool || a.id.localeCompare(b.id))
      .slice(0, WALL)
      .map((entry) => entry.tile());
  }, [filter, movies.data, series]);

  const loading = movies.isPending || seasons.isPending || shows.isPending;
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
  const failed = movies.isError || seasons.isError || shows.isError;
  /** What the TV tab draws: one poster per series (WS-TVC). */
  const tvCount = series.length;
  const hasBoth = (movies.data?.length ?? 0) > 0 && tvCount > 0;

  /**
   * **See all, and only where there is more than the wall already shows.**
   *
   * A control that opens a list of exactly the six titles above it is a dead end, so the
   * category has to hold more than `WALL` before it is offered — which is the founder's
   * rule and also the honest one: the wall *is* the whole collection for most new
   * accounts.
   *
   * Which category it opens follows the filter the reader is already looking at. Under
   * **All** there is still no single answer: the wall is one ordered list, but the sheet
   * behind it is not — it is per category, because a *position* is only meaningful inside
   * its own ranking even though a score is not. So All opens whichever half actually has
   * more to show — Movies first when both qualify, which is the order the tabs are in.
   */
  const seeAll = (() => {
    if (!onSeeAll || failed || loading) return null;
    const movieCount = movies.data?.length ?? 0;
    const seasonCount = tvCount;
    if (filter === 'movies') return movieCount > WALL ? ('movies' as const) : null;
    if (filter === 'tv_seasons') return seasonCount > WALL ? ('tv_seasons' as const) : null;
    if (movieCount > WALL) return 'movies' as const;
    return seasonCount > WALL ? ('tv_seasons' as const) : null;
  })();

  return (
    <View style={styles.section}>
      <SectionHeader
        title="Top ranked"
        size={headingSize}
        actionLabel={seeAll ? 'See all' : undefined}
        onPressAction={seeAll ? () => onSeeAll?.(seeAll) : undefined}
      />

      {/* Offered only where both halves have something. Somebody who has ranked only
          films is not asked to choose between Movies and TV — the same rule the
          person page's filmography filter follows. */}
      {hasBoth ? (
        <View style={styles.tabs}>
          <SegmentedTabs
            options={[
              { id: 'all' as const, label: 'All' },
              { id: 'movies' as const, label: 'Movies' },
              { id: 'tv_seasons' as const, label: 'TV Shows' },
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
              void shows.refetch();
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
        <PosterGrid tiles={tiles} onPressTile={(tile) => onPressTitle(tile.id)} />
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
