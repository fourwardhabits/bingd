import {
  keepPreviousData,
  useQueries,
  useQuery,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { queryKeys } from '@/lib/query';
import { productGenres } from '@/lib/media-metadata';
import { supabase } from '@/lib/supabase';
import {
  AdapterError,
  searchProviderWithPeople,
  type AdapterSearchResult,
  type CastSearchResult,
  type ProviderSearchPage,
} from '@/lib/tmdb-adapter';

import { titleKey } from './all-sections';

import {
  clearProviderCooldown,
  noteProviderRateLimited,
  PROVIDER_CACHE_MS,
  providerCooldownUntil,
  providerQueryOf,
} from './provider-budget';

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
 * budget, stated rather than assumed — `tmdb.max_requests_per_hour` is 120 and a settled
 * query costs one outbound attempt. So a session spending the whole allowance is one
 * making a distinct settled search roughly every thirty seconds for an hour without
 * repeating one. That is a real ceiling rather than a comfortable one, which is why
 * hitting it is *visible* — see `providerFailed` and what the Log screen does with it.
 *
 * **"One attempt" was not true until 2026-09-13.** Measured on staging, every search cost
 * three: the adapter fetched both genre lists on almost every invocation, because almost
 * every invocation met an isolate that had never fetched them. The allowance was forty
 * searches, which is the power-logger's report. The adapter now ships the genre table.
 *
 * Tuning the allowance itself is an `app_config` row, not a deploy, and it is a
 * founder call: the quota it protects is shared by every account.
 */
export const PROVIDER_DEBOUNCE_MS = 800;

/** Exact titles first, everything else in its given order. See the merge in `useTitleSearch`. */
function exactFirst<T extends { title: string }>(rows: T[], query: string): T[] {
  const key = titleKey(query);
  if (!key) return rows;
  const exact = rows.filter((row) => titleKey(row.title) === key);
  if (!exact.length) return rows;
  return [...exact, ...rows.filter((row) => titleKey(row.title) !== key)];
}

/** The later pages of a search, reduced to what the merge and the screen read. */
function combinePages(pages: UseQueryResult<ProviderSearchPage>[]) {
  const last = pages[pages.length - 1];
  return {
    data: pages.map((page) => page.data),
    fetching: pages.some((page) => page.isFetching),
    error: pages.find((page) => page.error)?.error ?? null,
    failedPages: pages.filter((page) => page.isError).map((page) => page.refetch),
    lastSettled: last === undefined || (last.isSuccess && !last.isFetching),
  };
}

/** One provider page, with a refusal noted against this hour's budget. */
async function providerPage(query: string, page: number): Promise<ProviderSearchPage> {
  try {
    const answer = await searchProviderWithPeople(query, PROVIDER_RESULTS, page);
    // Tolerates a bare title list, which is what a stubbed adapter hands back.
    return Array.isArray(answer)
      ? {
          titles: answer as AdapterSearchResult[],
          people: [] as CastSearchResult[],
          page,
          totalPages: 1,
        }
      : answer;
  } catch (cause) {
    if (cause instanceof AdapterError && cause.isRateLimit) noteProviderRateLimited();
    throw cause;
  }
}

/** One stable empty list, so a screen memoising on it does not recompute every render. */
const NO_PEOPLE: CastSearchResult[] = [];

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
export function useTitleSearch(
  input: string,
  {
    /**
     * Whether the provider pass may run at all.
     *
     * False while Search is narrowed to Users or Cast, where no title row is drawn: the
     * local pass is a table read and costs nothing worth saving, but a provider pass there
     * spent a TMDB request against the reader's hourly ceiling on every name they typed,
     * for a list nobody could see (2026-09-13).
     */
    wide = true,
  }: { wide?: boolean } = {},
) {
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
      const rpcRows = (data ?? []) as Omit<
        SearchResult,
        'genres' | 'runtime_minutes' | 'season_count'
      >[];
      if (!rpcRows.length) return [];

      const ids = rpcRows.map((row) => row.id);
      const seriesIds = rpcRows.filter((row) => row.kind === 'series').map((row) => row.id);

      const [{ data: metaRows, error: metaError }, { data: seasonRows, error: seasonError }] =
        await Promise.all([
          // `original_language` rides along for the product genre: an anime result
          // has to read Anime here for the same reason it does on the title page it
          // leads to (2026-08-30). `search_titles` returns neither column.
          supabase
            .from('media_items')
            .select('id, kind, genres, original_language, runtime_minutes')
            .in('id', ids),
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
        seasonCountBySeries.set(
          row.parent_id,
          (seasonCountBySeries.get(row.parent_id) ?? 0) + 1,
        );
      }

      return rpcRows.map((row) => {
        const meta = metaById.get(row.id);
        return {
          ...row,
          // A search result is a movie or a series, never a season, so there is no
          // parent to inherit from and the subject is the row itself.
          genres: meta
            ? productGenres({
                kind: meta.kind,
                genres: meta.genres,
                language: meta.original_language,
              })
            : [],
          runtime_minutes: meta?.runtime_minutes ?? null,
          season_count:
            row.kind === 'series' ? (seasonCountBySeries.get(row.id) ?? 0) : undefined,
        };
      });
    },
  });

  // Normalised for the provider alone: case and repeated spaces change nothing TMDB
  // answers, and used to change the cache key and so the charge. The local pass keeps the
  // query as typed, because `search_titles` ranks an exact match.
  const providerQuery = providerQueryOf(useDebounced(input.trim(), PROVIDER_DEBOUNCE_MS));
  const cooldownUntil = providerCooldownUntil();

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
   * What bounds the cost is not this gate and never was: the 800ms debounce, the
   * half-hour cache on the normalised query, and `tmdb.max_requests_per_hour` at 120 per
   * account, against which one settled query costs one request.
   *
   * **Two more, both 2026-09-13.** `wide` (see above), and the cooldown: once the server
   * has refused this hour, asking again before the hour turns cannot succeed, so the
   * provider waits for it and the screen says when that is.
   */
  const providerEnabled =
    wide &&
    cooldownUntil === null &&
    providerQuery === providerQueryOf(query) &&
    providerQuery.length >= MIN_QUERY_LENGTH;

  const provider = useQuery({
    queryKey: queryKeys.providerSearch(providerQuery, 1),
    enabled: providerEnabled,
    // Longer than the local pass. This one wrote rows to get its answer, and asking
    // again inside half an hour would rewrite the same rows to be told the same thing.
    staleTime: PROVIDER_CACHE_MS,
    // A provider failure is not worth three attempts: the local results are already on
    // screen, and the ceiling in api.md §9 counts every try.
    retry: false,
    queryFn: () => providerPage(providerQuery, 1),
  });

  /**
   * **Later pages, one at a time, only when asked for** (2026-09-14).
   *
   * The search used to end at TMDB's first page, so a title on page 3 could not be reached
   * by scrolling at all. Page 1 is still the only request a search makes; each further
   * page is requested by the screen when a reader who is scrolling reaches the end of the
   * list (`loadMorePages`), never on typing and never several at once.
   *
   * Each page is its own cached entry, keyed by the normalised query and the page, with
   * the same half-hour life as page 1, so backspacing to a query reuses every page already
   * read for it. The count of pages asked for belongs to one query: typing anything else
   * starts again from page 1.
   */
  const [morePages, setMorePages] = useState({ query: '', count: 0 });
  // A different query starts from page 1, and coming back to this one does too: its later
  // pages stay cached, and the reader's next scroll to the end reads them from there.
  if (morePages.query !== providerQuery && morePages.count !== 0) {
    setMorePages({ query: providerQuery, count: 0 });
  }
  const extraCount = morePages.query === providerQuery ? morePages.count : 0;
  const totalPages = provider.data?.totalPages ?? 1;
  const extra = useQueries({
    queries: Array.from({ length: extraCount }, (_, index) => {
      const page = index + 2;
      return {
        queryKey: queryKeys.providerSearch(providerQuery, page),
        enabled: providerEnabled && provider.data !== undefined && page <= totalPages,
        staleTime: PROVIDER_CACHE_MS,
        retry: false,
        queryFn: () => providerPage(providerQuery, page),
      };
    }),
    // A module-level function, so its identity is stable and React Query can keep the
    // combined result between renders instead of rebuilding it every time.
    combine: combinePages,
  });
  const nextPage = extraCount + 2;
  const hasMorePages = provider.data !== undefined && nextPage <= totalPages;
  const canLoadMore =
    providerEnabled &&
    hasMorePages &&
    !provider.isFetching &&
    extra.lastSettled &&
    !extra.error;

  // The latest provider answer, held across the keystrokes before the next one lands.
  // Adjusted during render rather than in an effect, which is React's pattern for state
  // derived from a changing input: no extra commit, and no frame showing the old value.
  const [held, setHeld] = useState(provider.data);
  if (provider.data && provider.data !== held) setHeld(provider.data);
  const heldPeople = held?.people ?? NO_PEOPLE;

  /** The server refused this hour, whether this query was the one refused or not. */
  // Not while this query's own answer is already held: a cached provider answer is still
  // shown during the cooldown, and calling that list "your catalogue only" would be false.
  const rateLimited =
    wide &&
    ((cooldownUntil !== null && provider.data === undefined) ||
      (provider.error instanceof AdapterError && provider.error.isRateLimit));

  const merged = useMemo(() => {
    const remote = provider.data?.titles ?? [];
    // Only while the provider key names the query on screen. In the debounce window after a
    // keystroke it still names the previous query, and that query's later pages under this
    // query's rows would be a wrong answer rather than an early one.
    const later =
      providerQuery === providerQueryOf(query)
        ? extra.data.flatMap((page) => page?.titles ?? [])
        : [];

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
    const local = result.isPlaceholderData && providerSettled ? [] : (result.data ?? []);
    if (!remote.length) return exactFirst(local, query);

    // Local ordering wins, because search_titles ranks exact and prefix matches
    // deliberately (20260814040000 §3) and TMDB's relevance does not know what the
    // user has already logged. Remote *content* wins for a row in both, because the
    // adapter just refreshed it — the local copy's poster is null and the remote
    // one's is not, and preferring local here is how a search would keep showing
    // blank artwork for a title it had only just fetched.
    const remoteById = new Map(remote.map((row) => [row.id, row]));
    const seen = new Set(local.map((row) => row.id));

    /**
     * **An exact title leads, then everything in its usual order** (2026-09-14).
     *
     * Applied to the first page only: the local rows and page 1 arrive before anything is
     * appended, so moving an exact title to the top happens as that answer lands and never
     * reorders rows a later page added beneath them. Only rows whose words are exactly the
     * query's move ("Don", not "Don't Look Up" or "Don 2"); the rest keep local order, then
     * TMDB's. Several exact titles keep that same order among themselves, year on the row.
     */
    const firstPage = exactFirst(
      [
        ...local.map((row) => remoteById.get(row.id) ?? row),
        ...remote.filter((row) => !seen.has(row.id)),
      ],
      query,
    );

    // Later pages are appended as they come, less anything already on the page: TMDB's
    // pages overlap, and the exact title page 1 recovered is on its page 3 as well.
    const shown = new Set(firstPage.map((row) => row.id));
    const appended = later.filter((row) => {
      if (shown.has(row.id)) return false;
      shown.add(row.id);
      return true;
    });

    return [...firstPage, ...appended];
  }, [
    query,
    providerQuery,
    extra.data,
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
     * Whether every title this query will get has arrived: the local pass has answered it (or
     * failed), and the provider has answered it, failed, or is not going to be asked (too
     * short, narrowed to Users or Cast, or the hour's budget spent).
     *
     * The All page draws Cast and Users below the title sections only once this is true, so
     * titles arriving later never push a section already on screen down under a reader's
     * thumb (independent review, 2026-09-14). Per query, not per session: the local pass
     * having answered some earlier query says nothing about this one.
     */
    titlesSettled:
      ((result.data !== undefined && !result.isPlaceholderData) || result.isError) &&
      (!wide ||
        cooldownUntil !== null ||
        providerQueryOf(query).length < MIN_QUERY_LENGTH ||
        (providerQuery === providerQueryOf(query) &&
          !provider.isFetching &&
          (provider.isFetched || provider.isError))),
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
      // A person pressing Try again is allowed to ask even inside the cooldown — see
      // `clearProviderCooldown` for the case only they can know about.
      // Only for the query on screen. Inside the debounce the provider key still names a
      // prefix the reader has typed past, and asking about it would be a charged request
      // for an answer nobody will see.
      if (!wide || providerQuery.length < MIN_QUERY_LENGTH) return;
      if (providerQuery !== providerQueryOf(query)) return;
      clearProviderCooldown();
      void provider.refetch();
    },
    /**
     * Asks again for a later page that failed, and for nothing else (independent review).
     *
     * `retry` refetches page 1, which for a later page's failure would spend a request on an
     * answer already on screen, possibly reorder it, and inside a cooldown walk straight into
     * a refusal that then described the whole list as "your catalogue only".
     */
    retryMorePages: () => {
      if (!extra.failedPages.length) return;
      clearProviderCooldown();
      for (const refetch of extra.failedPages) void refetch();
    },
    /** Whether TMDB has another page for this query, within the adapter's cap. */
    hasMorePages,
    /** A later page is on its way. */
    loadingMorePages: extra.fetching,
    /** A later page failed; `retry` asks for it again. */
    morePagesFailed: extra.error !== null,
    /** The later page was refused by this hour's budget, rather than failing some other way. */
    morePagesRateLimited: extra.error instanceof AdapterError && extra.error.isRateLimit,
    /** When a refused later page can be asked for again: the top of the next hour. */
    morePagesAvailableAt:
      extra.error instanceof AdapterError && extra.error.isRateLimit
        ? providerCooldownUntil()
        : null,
    /**
     * Asks for the next page, if there is one and nothing is already on its way. Returns
     * whether it asked. The screen calls this only when a reader scrolling reaches the end.
     */
    loadMorePages: () => {
      if (!canLoadMore) return false;
      setMorePages({ query: providerQuery, count: extraCount + 1 });
      return true;
    },
    /** The provider pass is supplementary, so it reports separately: local results are
     *  already on screen and must not be replaced by its spinner or its failure. */
    providerSearching: provider.isFetching,
    providerRateLimited: rateLimited,
    /**
     * The performers the provider named, for the Cast section under All.
     *
     * **The last answer's, until the next one lands.** The provider key lags the field by
     * its debounce, and dropping the performers on every keystroke made the Cast section
     * vanish and come back a second later while somebody refined a name, moving the rows
     * below it each time (independent review). They are safe to hold because they are
     * never shown ungated: `all-sections.ts` checks each against the query on screen, so
     * "leonardo dicaprio" narrowed to "leonardo" keeps DiCaprio, and a different search
     * entirely matches nobody and shows no section.
     */
    providerPeople: wide ? heldPeople : NO_PEOPLE,
    /** When wider search comes back, while it is rate limited; otherwise null. The next
     *  top of the hour, which is when the server's per-account window resets. */
    providerAvailableAt: rateLimited ? cooldownUntil : null,
    /** Any provider failure, rate limit included. An empty screen means two different
     *  things — the catalogue does not have it, or the lookup broke — and only this
     *  tells them apart. Without it a missing TMDB key looks exactly like a title
     *  that does not exist. */
    providerFailed: (wide && Boolean(provider.error)) || rateLimited,
    /** True once the provider has been asked and had nothing to add, which is the only
     *  state in which "nothing matches" is the whole truth. A failed request is not an
     *  answer: it used to set this, so an adapter that was down reported the catalogue
     *  as exhaustively searched. */
    providerExhausted:
      providerEnabled && provider.isFetched && !provider.isFetching && !provider.error,
  };
}

/** One season of a series, as every surface that lists them reads it. */
export type SeasonRow = {
  id: string;
  season_number: number;
  title: string;
  release_date: string | null;
  poster_path: string | null;
  /**
   * When the provider last wrote this row.
   *
   * Selected for the season-list freshness rule in `use-enrichment.ts` rather than for
   * anything drawn: `tmdb_upsert_seasons` stamps `fetched_at` on every row it writes, so
   * the **oldest** value across a series' seasons is when the list was last written
   * whole — which is the only thing that can say whether a season published since then
   * would be here.
   */
  fetched_at: string;
};

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
        .select('id, season_number, title, release_date, poster_path, fetched_at')
        .eq('parent_id', seriesId)
        .eq('kind', 'season')
        .order('season_number');
      if (error) throw error;
      return (data ?? []) as SeasonRow[];
    },
  });
}

/** The year, which is all a result row shows of a date. */
export const yearOf = (releaseDate: string | null) =>
  releaseDate ? Number(releaseDate.slice(0, 4)) : null;
