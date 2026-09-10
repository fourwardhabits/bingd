import { useQuery } from '@tanstack/react-query';

import { posterUri } from '@/lib/images';
import { supabase } from '@/lib/supabase';

/**
 * The first-run picker's supply of movies (`starter_movies`, 20260915000100).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACED, AND WHY IT IS NOT `useTrending`
 *
 * The picker used the Trending shelf's query. That is `provider_list_cache` — TMDB's
 * `trending.movie.day` and `trending.series.day`, mixed by `mixTrending` and cut to
 * `TRENDING_SHELF_SIZE` **before** the screen dropped the series — so the grid a new
 * reader was asked to choose five movies from held as few as five, and the founder ran it
 * out after four titles on a physical device.
 *
 * The shelf is not wrong for the Feed: "what is trending today" is a claim a shelf can
 * make, and a shelf is twelve rows by design. It is wrong here twice over. A picker's
 * supply has to outlast five choices with room to browse, and the first list somebody
 * sees in this product should be about *this product* rather than about a film database's
 * day. `starter_movies` answers the second half with the community's own scores and the
 * first by returning as many rows as it is asked for, falling back to catalogue
 * popularity when the platform has too few ranked titles to fill the ask.
 *
 * `useTrending` is untouched and the Feed still uses it.
 *
 * ---------------------------------------------------------------------------
 * TWO REQUESTS, AND THE SECOND ONE IS NOT A JOIN THIS COULD HAVE ASKED FOR
 *
 * The function returns ids and numbers, exactly as `top_rated_titles` does, because both
 * are `security definer` aggregates and neither should be in the business of deciding
 * which columns of the catalogue a caller may see. `media_items` is world-readable and
 * the metadata is fetched from it in one `in` — the same two-step `useTrending` and the
 * Top Rated wall both use.
 *
 * A row whose title has since been deleted is dropped rather than drawn as a blank
 * poster, and the picker's supply is long enough that losing one costs nothing.
 *
 * ---------------------------------------------------------------------------
 * KEYED BY ACCOUNT, WHICH LOOKS LIKE CATALOGUE DATA AND IS NOT
 *
 * `queryKeys.trending()` is deliberately not per-account: what TMDB is featuring is the
 * same list for everybody. This one is not. It excludes the caller's own rankings — so it
 * *changes as the flow runs*, which is the whole point — and it is filtered by blocks
 * like every other read that aggregates strangers. Two accounts on one device must not
 * share it.
 */

/** How many rows the picker asks for. */
const STARTER_LIMIT = 60;

export type StarterMovie = {
  /** A `media_items` id — the same id `set_bucket` and the ranking session take. */
  id: string;
  title: string;
  year: number | null;
  posterUri: string | null;
  /**
   * Which rule admitted this row: a community score, or catalogue popularity because
   * the platform had too few ranked titles to fill the ask. Carried so the screen can
   * say nothing at all about it and a report can still tell the two apart.
   */
  source: 'community' | 'popularity';
};

type StarterRow = {
  media_item_id: string;
  score: number | null;
  rating_count: number;
  min_ratings: number;
  source: string;
};

const yearOf = (date: string | null) => (date ? Number(date.slice(0, 4)) : null);

export function useStarterMovies(userId: string) {
  return useQuery({
    queryKey: ['onboarding-starter-movies', userId],
    /**
     * Re-read when the flow moves it. Every completed ranking removes a row from this
     * list, so a stale entry would offer back a movie the reader has just placed — which
     * `starter_movies` excludes precisely because picking it again is a step that cannot
     * advance. `invalidateAfterCollectionChange` does not name this key (it is not a
     * collection read), so the screen invalidates it itself; a short staleness is the
     * belt to that brace.
     */
    staleTime: 60_000,
    queryFn: async (): Promise<StarterMovie[]> => {
      const { data, error } = await supabase.rpc('starter_movies', {
        p_limit: STARTER_LIMIT,
      });
      if (error) throw error;

      const rows = (data ?? []) as StarterRow[];
      if (rows.length === 0) return [];

      const { data: titles, error: titlesError } = await supabase
        .from('media_items')
        .select('id, title, release_date, poster_path')
        .in(
          'id',
          rows.map((row) => row.media_item_id),
        );
      if (titlesError) throw titlesError;

      const byId = new Map((titles ?? []).map((row) => [row.id as string, row]));

      return rows.flatMap((row) => {
        const meta = byId.get(row.media_item_id);
        if (!meta) return [];
        return [
          {
            id: row.media_item_id,
            title: meta.title as string,
            year: yearOf(meta.release_date as string | null),
            posterUri: posterUri(meta.poster_path as string | null, 'card'),
            source: row.source === 'community' ? ('community' as const) : ('popularity' as const),
          },
        ];
      });
    },
  });
}
