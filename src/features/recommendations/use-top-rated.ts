import { useInfiniteQuery } from '@tanstack/react-query';

import type { CollectionItem } from '@/features/collection/filters';
import {
  MEDIA_METADATA_COLUMNS,
  resolveMetadata,
  type EmbeddedParent,
} from '@/lib/media-metadata';
import { supabase } from '@/lib/supabase';

import type { Medium } from './use-for-you';

/**
 * Top Rated: the catalogue in the community's order, a page at a time.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `useForYou` WITH A DIFFERENT SORT
 *
 * For You is a *recommendation*: a slate scored against this reader's own anchors, with
 * everything they have already watched subtracted, diversified, and rotated across
 * launches so the wall is not the same wall twice. Every one of those properties is
 * about the person looking.
 *
 * Top Rated is a *fact*, and the fact would be spoilt by all four. It is the score
 * `community_score` prints on a title page, asked about the catalogue rather than about
 * one row, and the whole claim it makes is that the order is everyone's rather than
 * yours. So there is no scoring here, no diversification, no rotation and no
 * subtraction — `top_rated_titles` (20260913000100) computes the order server-side and
 * this hook draws what it is given.
 *
 * **No client scoring model was added and none may be.** If this wall and the number on
 * a title page ever disagree, the database is where that gets fixed.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS KEYED BY ACCOUNT
 *
 * It looks like catalogue data and is not, for the one reason `useCommunityScore`
 * records: the population excludes accounts blocked in either direction, so two people
 * genuinely see different means for the same title — and a title can fall off the wall
 * entirely when a block takes its rating count below the threshold. A key on the medium
 * alone would let one account on a shared device read the other's wall.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CURSOR IS THE WHOLE SORT KEY
 *
 * `(score, rating_count, id)`, straight out of the last row of the previous page and
 * handed back unmodified. An offset into an aggregate that moves whenever anybody ranks
 * anything shows page two a row page one already had; the keyset cannot, because it
 * names the row it is continuing from. Same reasoning as `use-feed.ts`, one surface
 * over.
 *
 * The cursor is taken from the **raw RPC row**, not from the mapped item: the values the
 * server compares against have to be the values the server produced, and a numeric that
 * has been through `Number()` and back is not guaranteed to be one of them. This is the
 * rule PR #95 wrote down for the feed and it applies verbatim.
 */

/** One screenful and a bit. The server clamps anything larger. */
export const TOP_RATED_PAGE = 20;

/**
 * How many extra pages a filtered wall may pull in on its own before it stops.
 *
 * Filters run on the client here, deliberately — `applyFilters` already knows that a
 * season inherits its show's genres, that Anime is a predicate over language and
 * genres rather than a stored label, and that a person filter needs a credits index.
 * Re-expressing any of that in SQL would be a second implementation of product
 * semantics, which is exactly the drift `resolveMetadata` exists to prevent.
 *
 * The cost is that a narrow filter over a wide corpus can hide everything on page one,
 * so the screen asks for more pages until it has something to show. This bounds that:
 * ten pages is two hundred of the highest-rated titles in the catalogue, and a filter
 * that matches nothing in those is a filter with nothing to match.
 */
export const TOP_RATED_FILTER_PAGES = 10;

export type TopRatedItem = CollectionItem & {
  /** The community mean, exactly as `community_score` would report it for this title. */
  communityScore: number;
  /** How many public accounts it is the mean of. */
  ratingCount: number;
};

/** The cursor, as the server produced it. Never reconstructed from a mapped item. */
export type TopRatedCursor = {
  score: number | string;
  rating_count: number;
  media_item_id: string;
};

export type TopRatedPage = {
  items: TopRatedItem[];
  /** The last row of this page, or null when the wall ended here. */
  next: TopRatedCursor | null;
};

type RpcRow = {
  media_item_id: string;
  score: number | string;
  rating_count: number;
  min_ratings: number;
};

type MediaRow = {
  id: string;
  title: string;
  season_number: number | null;
  release_date: string | null;
  poster_path: string | null;
  runtime_minutes: number | null;
  kind: 'movie' | 'season' | 'series';
  genres: string[] | null;
  original_language: string | null;
  parent?: EmbeddedParent;
};

const yearOf = (date: string | null) => (date ? Number(date.slice(0, 4)) : null);

export const topRatedKey = (userId: string, medium: Medium) =>
  ['top-rated', userId, medium] as const;

async function readPage(medium: Medium, cursor: TopRatedCursor | null): Promise<TopRatedPage> {
  const { data, error } = await supabase.rpc('top_rated_titles', {
    p_medium: medium,
    p_limit: TOP_RATED_PAGE,
    p_after_score: cursor?.score ?? null,
    p_after_count: cursor?.rating_count ?? null,
    p_after_id: cursor?.media_item_id ?? null,
  });
  if (error) throw error;

  const rows = (Array.isArray(data) ? data : []) as RpcRow[];
  if (rows.length === 0) return { items: [], next: null };

  /**
   * The catalogue read, separate and world-readable — the shape `useGroupPicks` already
   * uses. `media_items` has no row security, so the aggregate function has no business
   * projecting title text as well: it would be a definer function returning columns any
   * client can select for itself.
   */
  const { data: media, error: mediaError } = await supabase
    .from('media_items')
    .select(
      `id, title, season_number, release_date, poster_path, runtime_minutes, kind, ${MEDIA_METADATA_COLUMNS}`,
    )
    .in(
      'id',
      rows.map((row) => row.media_item_id),
    );
  if (mediaError) throw mediaError;

  const byId = new Map(
    ((media ?? []) as unknown as MediaRow[]).map((row) => [row.id, row]),
  );

  // The server's order is the total order and is preserved exactly: this walks the RPC's
  // rows, never the catalogue read's, which PostgREST returns in whatever order it likes.
  const items: TopRatedItem[] = [];
  for (const row of rows) {
    const meta = byId.get(row.media_item_id);
    // A catalogue row deleted between the two reads is a skipped tile rather than a
    // crash. The cursor below still comes from the RPC, so the walk does not lose its
    // place because one title went missing.
    if (!meta) continue;
    const descriptive = resolveMetadata(meta);
    items.push({
      mediaItemId: row.media_item_id,
      title: meta.title,
      seriesTitle: descriptive.seriesTitle,
      seasonNumber: meta.season_number ?? null,
      kind: meta.kind,
      year: yearOf(meta.release_date),
      posterPath: meta.poster_path,
      genres: descriptive.genres,
      language: descriptive.language,
      runtimeMinutes: meta.runtime_minutes,
      // Nothing on this wall has been ranked *by this reader*, so the two fields the
      // filter sheet reads for its rating controls are null and the sheet is told not
      // to offer them — the same contract the For You wall has.
      score: null,
      bucket: null,
      watchedOn: null,
      addedAt: null,
      communityScore: Number(row.score),
      ratingCount: row.rating_count,
    });
  }

  // `rows` is non-empty by the guard above, so this is the last row and not a maybe.
  const last = rows[rows.length - 1]!;
  return {
    items,
    // A short page is the end of the wall: the server returned everything it had for
    // this cursor. A full page might be the end too, and the next request finding
    // nothing is how that is discovered — one empty round trip at the bottom of a wall
    // nobody has ever scrolled to is a better trade than a count query per page.
    next:
      rows.length < TOP_RATED_PAGE
        ? null
        : {
            score: last.score,
            rating_count: last.rating_count,
            media_item_id: last.media_item_id,
          },
  };
}

export function useTopRated(userId: string, medium: Medium, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: topRatedKey(userId, medium),
    enabled: enabled && Boolean(userId),
    /**
     * Five minutes, the number `useCommunityScore` already uses for the same aggregate.
     * A community mean moves when *other* people rank, which is not something this
     * reader's own activity should be refetching a wall over.
     */
    staleTime: 5 * 60_000,
    initialPageParam: null as TopRatedCursor | null,
    queryFn: ({ pageParam }) => readPage(medium, pageParam),
    getNextPageParam: (last) => last.next,
  });
}
