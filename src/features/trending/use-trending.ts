import { useQuery } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

import { isExpired, isTooOldToShow, mixTrending, type TrendingCandidate } from './trending';

/**
 * What TMDB is featuring, read straight out of `provider_list_cache`.
 *
 * There is no adapter call here and there must not be. `trending` is a `service_role`
 * action that spends four provider requests and eighty upserts per invocation
 * (api.md §`tmdb-adapter`); the cache table is world-readable precisely so that
 * opening the Feed costs one `select` against Postgres and nothing against the TMDB
 * quota. A client that could refresh the list would make the quota a function of how
 * many people pulled to refresh.
 *
 * The `day` lists, not `week`. "Trending now" over a seven-day window is a weaker
 * claim, and the six-hour TTL is what makes `day` viable at all. The `week` rows are
 * not waste: they are the popularity-fallback candidate source for recommendations.
 */

/** The two lists this shelf mixes. Both are `.day` — see above. */
const LIST_KEYS = ['trending.movie.day', 'trending.series.day'] as const;

const KIND_OF: Record<string, 'movie' | 'series'> = {
  'trending.movie.day': 'movie',
  'trending.series.day': 'series',
};

export type TrendingItem = TrendingCandidate & {
  title: string;
  year: number | null;
  posterPath: string | null;
};

export type TrendingShelfData = {
  items: TrendingItem[];
  /** Past its TTL but still worth showing — the adapter's schedule slipped. */
  stale: boolean;
};

const yearOf = (date: string | null) => (date ? Number(date.slice(0, 4)) : null);

export function useTrending() {
  return useQuery({
    // Not keyed by account. This is catalogue data, identical for everyone, so two
    // accounts on one device share it and a sign-out need not discard it — the same
    // reasoning `queryKeys.search` records.
    queryKey: ['trending', 'day'],
    // The list itself only changes when the adapter runs, every six hours. Refetching
    // it on every Feed mount would be a request per tab switch for a row that cannot
    // have changed.
    staleTime: 30 * 60_000,
    queryFn: async (): Promise<TrendingShelfData> => {
      const { data: lists, error } = await supabase
        .from('provider_list_cache')
        .select('list_key, payload, fetched_at, expires_at')
        .in('list_key', LIST_KEYS as unknown as string[]);
      if (error) throw error;

      const now = Date.now();
      const usable = (lists ?? []).filter(
        (row) => !isTooOldToShow(row.fetched_at as string, now),
      );
      if (usable.length === 0) return { items: [], stale: false };

      // Rank is the position within its own list, which is the order the adapter
      // wrote and the only trend signal the payload carries.
      const candidates: TrendingCandidate[] = [];
      for (const row of usable) {
        const kind = KIND_OF[row.list_key as string];
        if (!kind) continue;
        const ids = ((row.payload as { ids?: unknown })?.ids ?? []) as unknown[];
        ids.forEach((id, rank) => {
          if (typeof id === 'string') candidates.push({ mediaItemId: id, kind, rank, popularity: null });
        });
      }
      if (candidates.length === 0) return { items: [], stale: false };

      const { data: titles, error: titlesError } = await supabase
        .from('media_items')
        .select('id, title, release_date, poster_path, popularity, kind')
        .in(
          'id',
          candidates.map((candidate) => candidate.mediaItemId),
        );
      if (titlesError) throw titlesError;

      const byId = new Map((titles ?? []).map((row) => [row.id as string, row]));

      const items: TrendingItem[] = candidates.flatMap((candidate) => {
        const row = byId.get(candidate.mediaItemId);
        // A cached id whose title has since been deleted is dropped rather than
        // rendered as a blank poster. The payload holds ids on purpose so that the
        // metadata expires on its own clock; the cost is that the two can disagree.
        if (!row) return [];
        return [
          {
            ...candidate,
            popularity: (row.popularity as number | null) ?? null,
            title: row.title as string,
            year: yearOf(row.release_date as string | null),
            posterPath: (row.poster_path as string | null) ?? null,
          },
        ];
      });

      return {
        items: mixTrending(items),
        stale: usable.every((row) => isExpired(row.expires_at as string, now)),
      };
    },
  });
}
