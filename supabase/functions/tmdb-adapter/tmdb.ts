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

async function request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const auth = credential();

  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('language', 'en-US');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (auth.apiKey) url.searchParams.set('api_key', auth.apiKey);

  for (let attempt = 0; ; attempt += 1) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

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

export async function genreNames(): Promise<Map<number, string>> {
  if (genreCache) return genreCache;

  const [movie, tv] = await Promise.all([
    request<GenreList>('/genre/movie/list'),
    request<GenreList>('/genre/tv/list'),
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
  seasons?: {
    id: number;
    season_number: number;
    name?: string;
    air_date?: string | null;
    overview?: string;
    poster_path?: string | null;
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
};

export function searchMulti(query: string): Promise<{ results: TmdbSearchResult[] }> {
  return request('/search/multi', {
    query,
    include_adult: 'false',
    page: '1',
  });
}

export function movieDetail(id: number): Promise<TmdbMovieDetail> {
  return request(`/movie/${id}`, { append_to_response: 'credits' });
}

export function seriesDetail(id: number): Promise<TmdbSeriesDetail> {
  return request(`/tv/${id}`, { append_to_response: 'credits' });
}

export function seasonDetail(seriesId: number, seasonNumber: number): Promise<TmdbSeasonDetail> {
  return request(`/tv/${seriesId}/season/${seasonNumber}`, {
    append_to_response: 'credits',
  });
}
