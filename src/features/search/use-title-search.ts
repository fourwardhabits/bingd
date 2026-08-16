import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { queryKeys } from '@/lib/query';
import { supabase } from '@/lib/supabase';
import { AdapterError, searchProvider } from '@/lib/tmdb-adapter';

export type SearchResult = {
  id: string;
  kind: 'movie' | 'series' | 'season';
  title: string;
  release_date: string | null;
  poster_path: string | null;
  provenance: 'tmdb' | 'wikidata' | 'manual';
  genres: string[];
  runtime_minutes: number | null;
  season_count?: number;
};

/**
 * Long enough that a fast typist makes one request rather than eight, short enough that
 * the list still moves while they type. `screens.md` §11 asks for something that feels
 * like filtering, and anything past ~250ms starts to feel like a request being sent.
 */
const DEBOUNCE_MS = 180;

/**
 * The provider waits longer than the local catalogue does.
 *
 * A local query is a table read on a server Bingd owns and costs a round trip. A
 * provider query costs a TMDB request against a quota shared by every user, and
 * spends one for each intermediate word a fast typist passes through on the way to
 * the one they meant. Half a second is past the point where someone is still
 * typing the same word.
 */
const PROVIDER_DEBOUNCE_MS = 500;

/** Below this every query matches half the catalogue and none of it is useful. */
const MIN_QUERY_LENGTH = 2;

/**
 * How many local results count as having answered the question.
 *
 * Not zero. The alpha catalogue is a few hundred Wikidata titles, so a search for
 * "dune" finds one film and misses the other, the series, and every season — and
 * a user who sees a single plausible row has no way to know the rest exist. Asking
 * the provider whenever the local answer is thin is the difference between a
 * catalogue that looks small and one that looks broken.
 */
const LOCAL_RESULTS_ENOUGH = 6;

export function useDebounced<T>(value: T, delay = DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return settled;
}

/**
 * Title search, in two passes.
 *
 * The first is `search_titles` (20260814040000) against the local catalogue: one round
 * trip to a table Bingd owns, fast enough to feel like filtering. `keepPreviousData` is
 * what makes it feel that way — without it every keystroke empties the list for the length
 * of a round trip, and a list that blinks between states reads as slower than one that lags
 * slightly behind.
 *
 * The second runs only when the first came back thin, and asks `tmdb-adapter` for titles
 * the local catalogue has never heard of. The adapter writes them into `media_items`
 * before answering, so what arrives is an ordinary catalogue row with an ordinary Bingd
 * id — there is no import step, and nothing downstream can tell the two apart. That is
 * also why the merge below can dedupe on `id`: a title that exists in both really is one
 * row, because the adapter upserted onto it.
 */
export function useTitleSearch(input: string) {
  const query = useDebounced(input.trim());
  const enabled = query.length >= MIN_QUERY_LENGTH;

  const result = useQuery({
    queryKey: queryKeys.search(query),
    enabled,
    placeholderData: keepPreviousData,
    // The catalogue is a table on the server; the same query a minute later has the same
    // answer. Refetching it costs a round trip and changes nothing.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<SearchResult[]> => {
      const { data, error } = await supabase.rpc('search_titles', {
        p_query: query,
        p_limit: 25,
      });
      if (error) throw error;
      const rpcRows = (data ?? []) as Omit<SearchResult, 'genres' | 'runtime_minutes' | 'season_count'>[];
      if (!rpcRows.length) return [];

      const ids = rpcRows.map((row) => row.id);
      const seriesIds = rpcRows.filter((row) => row.kind === 'series').map((row) => row.id);

      const [{ data: metaRows, error: metaError }, { data: seasonRows, error: seasonError }] =
        await Promise.all([
          supabase.from('media_items').select('id, genres, runtime_minutes').in('id', ids),
          seriesIds.length
            ? supabase
                .from('media_items')
                .select('id, parent_id')
                .eq('kind', 'season')
                .in('parent_id', seriesIds)
            : Promise.resolve({ data: [], error: null }),
        ]);

      if (metaError) throw metaError;
      if (seasonError) throw seasonError;

      const metaById = new Map((metaRows ?? []).map((row) => [row.id, row]));
      const seasonCountBySeries = new Map<string, number>();
      for (const row of seasonRows ?? []) {
        if (!row.parent_id) continue;
        seasonCountBySeries.set(row.parent_id, (seasonCountBySeries.get(row.parent_id) ?? 0) + 1);
      }

      return rpcRows.map((row) => {
        const meta = metaById.get(row.id);
        return {
          ...row,
          genres: meta?.genres ?? [],
          runtime_minutes: meta?.runtime_minutes ?? null,
          season_count: row.kind === 'series' ? seasonCountBySeries.get(row.id) ?? 0 : undefined,
        };
      });
    },
  });

  const providerQuery = useDebounced(input.trim(), PROVIDER_DEBOUNCE_MS);

  /**
   * Three conditions, and each one is load-bearing.
   *
   * The two debounced values must agree, or the provider is asked about a prefix the
   * user has already typed past. The local pass must have settled on real data rather
   * than the previous query's rows, which `keepPreviousData` would otherwise let stand
   * in for an answer. And it must have come back thin — a search that already worked
   * has no reason to spend a provider request.
   */
  const providerEnabled =
    providerQuery === query &&
    providerQuery.length >= MIN_QUERY_LENGTH &&
    !result.isPending &&
    !result.isPlaceholderData &&
    (result.data?.length ?? 0) < LOCAL_RESULTS_ENOUGH;

  const provider = useQuery({
    queryKey: queryKeys.providerSearch(providerQuery),
    enabled: providerEnabled,
    // Longer than the local pass. This one wrote rows to get its answer, and asking
    // again inside half an hour would rewrite the same rows to be told the same thing.
    staleTime: 30 * 60_000,
    // A provider failure is not worth three attempts: the local results are already on
    // screen, and the ceiling in api.md §9 counts every try.
    retry: false,
    queryFn: () => searchProvider(providerQuery, 12),
  });

  const merged = useMemo(() => {
    const local = result.data ?? [];
    const remote = provider.data ?? [];
    if (!remote.length) return local;

    // Local ordering wins, because search_titles ranks exact and prefix matches
    // deliberately (20260814040000 §3) and TMDB's relevance does not know what the
    // user has already logged. Remote *content* wins for a row in both, because the
    // adapter just refreshed it — the local copy's poster is null and the remote
    // one's is not, and preferring local here is how a search would keep showing
    // blank artwork for a title it had only just fetched.
    const remoteById = new Map(remote.map((row) => [row.id, row]));
    const seen = new Set(local.map((row) => row.id));

    return [
      ...local.map((row) => remoteById.get(row.id) ?? row),
      ...remote.filter((row) => !seen.has(row.id)),
    ];
  }, [result.data, provider.data]);

  return {
    ...result,
    /** True while the user has typed too little to search, which is not an empty result. */
    idle: !enabled,
    results: merged,
    /** The provider pass is supplementary, so it reports separately: local results are
     *  already on screen and must not be replaced by its spinner or its failure. */
    providerSearching: provider.isFetching,
    providerRateLimited: provider.error instanceof AdapterError && provider.error.isRateLimit,
    /** Any provider failure, rate limit included. An empty screen means two different
     *  things — the catalogue does not have it, or the lookup broke — and only this
     *  tells them apart. Without it a missing TMDB key looks exactly like a title
     *  that does not exist. */
    providerFailed: Boolean(provider.error),
    /** True once the provider has been asked and had nothing to add, which is the only
     *  state in which "nothing matches" is the whole truth. A failed request is not an
     *  answer: it used to set this, so an adapter that was down reported the catalogue
     *  as exhaustively searched. */
    providerExhausted:
      providerEnabled && provider.isFetched && !provider.isFetching && !provider.error,
  };
}

/** Seasons for a series, which is how a season is reached — search returns only films
 *  and series (PRD §26.2 AC 1, AC 2). `media_items` is world-readable, so this is a plain
 *  read rather than an RPC. */
export function useSeasons(seriesId: string | null) {
  return useQuery({
    queryKey: queryKeys.seasons(seriesId ?? ''),
    enabled: Boolean(seriesId),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('media_items')
        .select('id, season_number, title, release_date, poster_path')
        .eq('parent_id', seriesId)
        .eq('kind', 'season')
        .order('season_number');
      if (error) throw error;
      return (data ?? []) as {
        id: string;
        season_number: number;
        title: string;
        release_date: string | null;
        poster_path: string | null;
      }[];
    },
  });
}

/** The year, which is all a result row shows of a date. */
export const yearOf = (releaseDate: string | null) =>
  releaseDate ? Number(releaseDate.slice(0, 4)) : null;
