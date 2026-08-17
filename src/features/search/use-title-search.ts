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
 * the one they meant.
 *
 * **800ms, raised from 500 on 2026-08-16.** With the local-row gate gone (see
 * `providerEnabled`), this debounce is the main thing standing between exploratory
 * typing and the hourly ceiling, and independent review was right that at 500ms a
 * pause between words costs a request each: "spider" then "spiderman" was two. The
 * budget, stated rather than assumed — `tmdb.max_requests_per_hour` is 120, a settled
 * query costs one outbound attempt, and two more on an isolate cold enough to have
 * lost its genre map. So a session spending the whole allowance is one making a
 * distinct settled search roughly every thirty seconds for an hour without repeating
 * one. That is a real ceiling rather than a comfortable one, which is why hitting it
 * is now *visible* — see `providerFailed` and what the Log screen does with it.
 *
 * Tuning the allowance itself is an `app_config` row, not a deploy, and it is a
 * founder call: the quota it protects is shared by every account.
 */
const PROVIDER_DEBOUNCE_MS = 800;

/** Below this every query matches half the catalogue and none of it is useful. */
const MIN_QUERY_LENGTH = 2;

/**
 * How many titles to take from the provider.
 *
 * Twenty, which is both the server's cap and the size of one TMDB page — so this is
 * the number that discards nothing. It was twelve, and `/search/multi` returns twenty
 * results of which some are people; the adapter dropped the people and then threw away
 * everything past the twelfth of what remained. Those rows had already been fetched and
 * already been charged against the hourly ceiling. Nothing was bought by discarding
 * them.
 */
const PROVIDER_RESULTS = 20;

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
 * The second runs once the typing has settled, and asks `tmdb-adapter` for titles the
 * local catalogue has never heard of. It used to run only when the first came back thin;
 * see `providerEnabled` for why a row count turned out to be the wrong thing to gate on.
 * The adapter writes them into `media_items`
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
   * Two conditions. Both are about *when* to ask, and neither is about the local answer.
   *
   * The debounced values must agree, which is true once the user has paused for the
   * provider's half second — so the provider is never asked about a prefix somebody has
   * already typed past. And the query must clear the length floor.
   *
   * **There used to be a third: ask only when the local catalogue came back with fewer
   * than six rows.** That is the founder's `spiderman` report, and it is Bingd's bug
   * rather than TMDB's. The seeded catalogue held six Spider-Man films whose squashed
   * titles begin "spiderman" — enough to satisfy the gate exactly — so the provider was
   * never asked, and `Spider-Man: Brand New Day` was invisible no matter how popular it
   * was. Typing more of the name found it, because a narrower query matched nothing
   * locally and so was allowed through to TMDB. A search that gets *worse* as the user
   * types less of what they remember is precisely backwards.
   *
   * The gate's mistake was treating a count as evidence. The local catalogue is a cache
   * of TMDB, not a second opinion about it: six rows is not a statement that there are
   * six, and no row count can be, because the catalogue only ever holds what somebody
   * has already searched for. So the local pass now does what it is actually good at —
   * putting rows on screen in one round trip — and stops deciding whether the wider
   * search happens.
   *
   * What bounds the cost is not this gate and never was: the 500ms debounce, the
   * half-hour cache on the query string, and `tmdb.max_requests_per_hour` at 120 per
   * account, against which one settled query costs one request.
   */
  const providerEnabled =
    providerQuery === query && providerQuery.length >= MIN_QUERY_LENGTH;

  const provider = useQuery({
    queryKey: queryKeys.providerSearch(providerQuery),
    enabled: providerEnabled,
    // Longer than the local pass. This one wrote rows to get its answer, and asking
    // again inside half an hour would rewrite the same rows to be told the same thing.
    staleTime: 30 * 60_000,
    // A provider failure is not worth three attempts: the local results are already on
    // screen, and the ceiling in api.md §9 counts every try.
    retry: false,
    queryFn: () => searchProvider(providerQuery, PROVIDER_RESULTS),
  });

  const merged = useMemo(() => {
    const remote = provider.data ?? [];

    /**
     * Stale local rows are dropped the moment the provider *settles* on this query.
     *
     * `keepPreviousData` deliberately leaves the previous query's rows on screen while
     * the new local pass runs, which is what stops the list blinking on every keystroke.
     * With the provider no longer waiting for the local pass, though, it can settle on
     * query B while `result.data` still holds A's rows — and the merge would then put
     * A's films under the heading of a search for B. They are wrong rather than early.
     *
     * Settled means answered *or* failed, not "answered with rows". The first version of
     * this checked `remote.length`, which left A's films on screen whenever B's provider
     * request came back empty or errored — and in the error case the new footer would
     * then describe A's films as B's catalogue results. Independent review found that
     * second case after finding the first.
     *
     * The cost is a possible blink to empty in the window between the provider settling
     * and B's local rows arriving. That window is pathological rather than ordinary: the
     * local pass debounces at 180ms and the provider at 800, so local has almost always
     * answered first. Showing nothing briefly is in any case better than showing another
     * query's films as though they were this one's.
     */
    const providerSettled =
      providerEnabled && !provider.isFetching && (provider.isFetched || provider.isError);
    const local = result.isPlaceholderData && providerSettled ? [] : result.data ?? [];
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
  }, [
    result.data,
    result.isPlaceholderData,
    provider.data,
    provider.isFetching,
    provider.isFetched,
    provider.isError,
    providerEnabled,
  ]);

  return {
    ...result,
    /** True while the user has typed too little to search, which is not an empty result. */
    idle: !enabled,
    results: merged,
    /**
     * Retries **both** passes, which is what "Try again" has to mean.
     *
     * The screen used to call `refetch` from the spread above — the local query's, and
     * only the local query's. Every failure the retry button is offered for is a
     * *provider* failure: the local pass is a table read that had already succeeded, so
     * the button re-ran the half that worked and left the half that did not. It looked
     * like a retry and could not have fixed anything.
     *
     * `provider.refetch()` reruns even with `retry: false`, which governs automatic
     * attempts rather than deliberate ones.
     */
    retry: () => {
      void result.refetch();
      if (providerEnabled) void provider.refetch();
    },
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
