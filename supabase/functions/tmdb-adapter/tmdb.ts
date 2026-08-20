/**
 * The only place in Bingd that speaks to TMDB, and the only place the key is read.
 *
 * AD-8 makes that a structural claim rather than a convention: nothing else in the
 * repository imports this file, no client bundle contains the token, and swapping
 * providers means rewriting this module and `normalize.ts` and nothing else.
 *
 * Two credentials are accepted and the order of preference is deliberate.
 * `TMDB_ACCESS_TOKEN` is the v4 read access token and goes in a bearer header;
 * `TMDB_API_KEY` is the v3 key and goes in a query parameter. They authenticate the
 * same account, so the difference is entirely about where the secret ends up: a
 * query parameter is written to request logs, proxy logs and error traces, and a
 * header is not. Set the token and the key becomes dead configuration.
 *
 * Both are supported rather than just the better one because TMDB shows them
 * side by side on the same settings page, and a deployment that has only the key to
 * hand should work rather than fail with an error about which secret was expected.
 */

const BASE = 'https://api.themoviedb.org/3';

/**
 * TMDB is a hard dependency with no published SLA, so a request that has stopped
 * answering has to fail rather than hold an Edge Function invocation open until the
 * platform kills it — which would surface to the user as a timeout with no message.
 */
const REQUEST_TIMEOUT_MS = 8_000;

/** 429 is the only status worth retrying. A 404 will still be a 404. */
const MAX_RETRIES = 2;

export class TmdbError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TmdbError';
  }
}

function credential(): { header?: string; apiKey?: string } {
  const token = Deno.env.get('TMDB_ACCESS_TOKEN');
  if (token) return { header: `Bearer ${token}` };

  const key = Deno.env.get('TMDB_API_KEY');
  if (key) return { apiKey: key };

  // Loud, and at the first request rather than as an empty result set. A missing
  // credential here reads as "TMDB has no record of this film" everywhere downstream.
  throw new TmdbError(
    'Neither TMDB_ACCESS_TOKEN nor TMDB_API_KEY is set. Add one with `supabase secrets set`.',
    500,
  );
}

/**
 * Called immediately before every outbound attempt, and allowed to refuse.
 *
 * This exists because a *charged request* and an *HTTP request* were not the same
 * thing, and the per-user ceiling was counting the first while TMDB sees the second.
 * With `MAX_RETRIES = 2`, one charged unit could be three attempts — so a hundred and
 * twenty an hour was three hundred and sixty. Independent review found it twice: once
 * for the genre lists, and again here after the first fix charged the right number of
 * *logical* requests.
 *
 * Threaded as a parameter rather than kept in module state, because one isolate
 * serves several invocations at once and a module-level counter would charge one
 * user's retries to whoever happened to be next.
 *
 * Undefined for the service-role paths. `enrich`, `refresh` and `trending` are
 * operator jobs against no user's ceiling.
 */
export type Charge = () => Promise<void>;

async function request<T>(
  path: string,
  params: Record<string, string> = {},
  charge?: Charge,
): Promise<T> {
  const auth = credential();

  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('language', 'en-US');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (auth.apiKey) url.searchParams.set('api_key', auth.apiKey);

  for (let attempt = 0; ; attempt += 1) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    // Before the attempt, so a caller at their ceiling is refused rather than
    // discovering it afterwards — and so a retry storm is charged as it happens.
    // Throwing here (RateLimited) leaves the loop and surfaces as BG429.
    if (charge) await charge();

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          ...(auth.header ? { Authorization: auth.header } : {}),
          Accept: 'application/json',
        },
        signal: timeout,
      });
    } catch (cause) {
      if (attempt < MAX_RETRIES) continue;
      throw new TmdbError(`TMDB request failed: ${(cause as Error).message}`, 504);
    }

    if (response.status === 429 && attempt < MAX_RETRIES) {
      // TMDB sends Retry-After in seconds. Absent, back off a beat rather than
      // immediately re-entering the limit we were just refused by.
      const wait = Number(response.headers.get('Retry-After') ?? '1');
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 5) * 1000));
      continue;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new TmdbError(
        `TMDB ${response.status} for ${path}${body ? `: ${body.slice(0, 200)}` : ''}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  }
}

// ---------------------------------------------------------------------------
// Genre names
//
// Search results carry genre_ids and detail responses carry full genre objects,
// so the two paths would otherwise disagree about what a film's genres are. The
// two lists are about forty rows that change perhaps yearly, so they are fetched
// once per isolate and kept. A cold start pays for it; nothing else does.
// ---------------------------------------------------------------------------

type GenreList = { genres: { id: number; name: string }[] };

let genreCache: Map<number, string> | null = null;

export async function genreNames(charge?: Charge): Promise<Map<number, string>> {
  // Charged only when it actually fetches, which is what threading the charger all
  // the way down buys: nothing upstream has to predict whether this isolate is warm.
  // A predicted count was the first fix and it was still wrong, because it counted
  // logical requests rather than attempts.
  if (genreCache) return genreCache;

  const [movie, tv] = await Promise.all([
    request<GenreList>('/genre/movie/list', {}, charge),
    request<GenreList>('/genre/tv/list', {}, charge),
  ]);

  const map = new Map<number, string>();
  for (const genre of [...movie.genres, ...tv.genres]) map.set(genre.id, genre.name);
  genreCache = map;
  return map;
}

// ---------------------------------------------------------------------------
// The four calls the adapter makes
// ---------------------------------------------------------------------------

export type TmdbSearchResult = {
  id: number;
  media_type: 'movie' | 'tv' | 'person';
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  original_language?: string;
  genre_ids?: number[];
  popularity?: number;
};

export type TmdbCredits = {
  cast?: { id: number; name: string; character?: string; profile_path?: string | null }[];
  crew?: { id: number; name: string; job?: string; department?: string }[];
};

/**
 * Trailers and clips, appended alongside credits since 2026-08-16.
 *
 * `key` is a site-specific id rather than a URL — YouTube's watch id, for the
 * overwhelming majority — for the same reason poster paths are stored as paths: the
 * URL form is a rendering decision, and storing one freezes it.
 */
export type TmdbVideos = {
  results?: {
    id: string;
    key: string;
    name: string;
    site: string;
    type: string;
    official?: boolean;
    published_at?: string;
  }[];
};

/**
 * What a title is rated, which TMDB publishes in two entirely different shapes.
 *
 * A **movie** has `release_dates`, a list per country of *release events* — theatrical,
 * digital, physical — each of which may carry a certification, and several of which
 * routinely carry an empty one. So finding a film's rating means walking a country's
 * releases and taking the first that has anything.
 *
 * A **series** has `content_ratings`, one flat rating per country. Simpler, and
 * deliberately a different type here rather than a union: the two are not the same
 * thing wearing different clothes, and a single type would need a comment explaining
 * which half applies.
 */
export type TmdbReleaseDates = {
  results?: {
    iso_3166_1: string;
    release_dates?: { certification?: string; type?: number; release_date?: string }[];
  }[];
};

export type TmdbContentRatings = {
  results?: { iso_3166_1: string; rating?: string }[];
};

export type TmdbMovieDetail = {
  id: number;
  title: string;
  original_title?: string;
  release_date?: string;
  runtime?: number | null;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  original_language?: string;
  genres?: { id: number; name: string }[];
  popularity?: number;
  credits?: TmdbCredits;
  videos?: TmdbVideos;
  release_dates?: TmdbReleaseDates;
};

export type TmdbSeriesDetail = {
  id: number;
  name: string;
  original_name?: string;
  first_air_date?: string;
  episode_run_time?: number[];
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  original_language?: string;
  genres?: { id: number; name: string }[];
  popularity?: number;
  credits?: TmdbCredits;
  videos?: TmdbVideos;
  content_ratings?: TmdbContentRatings;
  seasons?: {
    id: number;
    season_number: number;
    name?: string;
    air_date?: string | null;
    overview?: string;
    poster_path?: string | null;
    /**
     * How many episodes the season has, which TMDB publishes here and nowhere
     * cheaper. The season *detail* route does not carry a count — it carries the
     * episodes themselves — so this list, on a response the adapter already
     * fetches for its titles and its seasons, is where the number for
     * `media_items.episode_count` comes from (`20260820000400`).
     */
    episode_count?: number | null;
  }[];
};

export type TmdbSeasonDetail = {
  id: number;
  season_number: number;
  name?: string;
  air_date?: string | null;
  overview?: string;
  poster_path?: string | null;
  credits?: TmdbCredits;
  videos?: TmdbVideos;
  /**
   * The season's episodes, which this route returns in full and the series list
   * does not.
   *
   * Only ever counted, never stored: `media_items` has no episode table and the
   * feed's subheading wants `8 episodes` and nothing else. It is declared as the
   * empty shape on purpose, so that reading a field off one is a type error rather
   * than a facet somebody starts filling in here (`20260820000400`).
   */
  episodes?: Record<never, never>[];
};

export function searchMulti(
  query: string,
  charge?: Charge,
): Promise<{ results: TmdbSearchResult[] }> {
  return request(
    '/search/multi',
    { query, include_adult: 'false', page: '1' },
    charge,
  );
}

/**
 * What TMDB is featuring right now.
 *
 * The results are search-shaped — genre_ids rather than genre objects, no runtime —
 * so `fromSearchResult` normalizes them and the genre map is needed here too.
 *
 * This takes the kind rather than inferring it, and the caller passes that kind on to
 * `normalizeList` as the fallback for a missing `media_type`. TMDB does send one on
 * these responses; nothing here depends on it continuing to.
 */
export function trending(
  kind: 'movie' | 'tv',
  window: 'day' | 'week',
): Promise<{ results: TmdbSearchResult[] }> {
  return request(`/trending/${kind}/${window}`);
}

/**
 * What TMDB associates with one title.
 *
 * `/recommendations` rather than `/similar`, deliberately. TMDB's "similar" is
 * computed from shared keywords and genres; "recommendations" is derived from what
 * people who engaged with this title went on to engage with, and is much the better
 * of the two for the job here. The facet it lands in is called `similar` because that
 * is what the closed set in `20260813000400` already contains, and adding a name to
 * a check constraint is a migration for no behavioural gain.
 *
 * Results are search-shaped and carry **no** `media_type` at all, which is why the
 * caller must pass the kind it asked for.
 */
export function recommendations(
  kind: 'movie' | 'tv',
  id: number,
  charge?: Charge,
): Promise<{ results: TmdbSearchResult[] }> {
  return request(`/${kind}/${id}/recommendations`, {}, charge);
}

export function movieDetail(id: number, charge?: Charge): Promise<TmdbMovieDetail> {
  // One HTTP request, not three: `append_to_response` is TMDB's own mechanism for
  // exactly that, so credits, videos and the certification cost nothing beyond the
  // detail call that was being made anyway. A separate endpoint would be a second
  // charged request for data the first one hands over for free.
  //
  // `reviews` was appended here until 2026-08-17 and is not any more: the Reviews tab
  // is Bingd's own public Notes now, so TMDB's had no reader, and asking for data
  // nothing renders is a retention obligation for nothing (`20260817001000`).
  return request(
    `/movie/${id}`,
    { append_to_response: 'credits,videos,release_dates' },
    charge,
  );
}

export function seriesDetail(id: number, charge?: Charge): Promise<TmdbSeriesDetail> {
  // `content_ratings` rather than `release_dates`: a series is rated once per country
  // and a film is rated per release event. Different shapes, different endpoints, and
  // `normalize.ts` reads each with its own function rather than a union.
  return request(
    `/tv/${id}`,
    { append_to_response: 'credits,videos,content_ratings' },
    charge,
  );
}

export function seasonDetail(
  seriesId: number,
  seasonNumber: number,
  charge?: Charge,
): Promise<TmdbSeasonDetail> {
  // No reviews. TMDB has no season-level reviews endpoint, and /tv/{id}/reviews
  // returns reviews of the *series* — attributing those to "Season 2" would put
  // somebody's words about a whole show under the wrong heading. See the header of
  // 20260817000500.
  return request(
    `/tv/${seriesId}/season/${seasonNumber}`,
    { append_to_response: 'credits,videos' },
    charge,
  );
}

/**
 * A person and everything TMDB credits them on.
 *
 * `combined_credits` is one appended response rather than the two separate
 * /person/{id}/movie_credits and /tv_credits calls, for the same reason detail
 * appends credits: it is free where they would be two more charged requests.
 *
 * The entries are search-shaped — `media_type`, `genre_ids`, `poster_path`,
 * `release_date` or `first_air_date` — so `fromSearchResult` normalizes them
 * unchanged. What they carry *in addition* is the part that belongs to the pairing
 * rather than to the film: `character` for a cast credit, `job` for a crew one.
 */
export type TmdbPersonCreditEntry = TmdbSearchResult & {
  credit_id?: string;
  character?: string | null;
  job?: string | null;
  department?: string | null;
  episode_count?: number | null;
  vote_count?: number | null;
};

export type TmdbPersonDetail = {
  id: number;
  name: string;
  biography?: string | null;
  birthday?: string | null;
  deathday?: string | null;
  place_of_birth?: string | null;
  known_for_department?: string | null;
  profile_path?: string | null;
  popularity?: number;
  combined_credits?: {
    cast?: TmdbPersonCreditEntry[];
    crew?: TmdbPersonCreditEntry[];
  };
};

export function personDetail(id: number, charge?: Charge): Promise<TmdbPersonDetail> {
  return request(`/person/${id}`, { append_to_response: 'combined_credits' }, charge);
}
