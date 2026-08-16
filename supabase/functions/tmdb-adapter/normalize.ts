/**
 * TMDB's shapes into Bingd's.
 *
 * This is the layer AD-8 promises: "no other component knows TMDB's response
 * format." Everything past this file sees `media_items` columns, so replacing the
 * provider means rewriting this and `tmdb.ts` rather than tracing field names
 * through the client.
 *
 * Poster and backdrop paths are stored in TMDB's path form — `/qJ2tW6.jpg` — and
 * not as URLs, because the size belongs to the screen rendering it. `src/lib/images.ts`
 * is the other half of that decision.
 */

import type {
  TmdbMovieDetail,
  TmdbSearchResult,
  TmdbSeasonDetail,
  TmdbSeriesDetail,
} from './tmdb.ts';

/** The payload `tmdb_upsert_titles` accepts. */
export type TitleRow = {
  kind: 'movie' | 'series';
  tmdb_id: number;
  title: string;
  original_title: string | null;
  release_date: string | null;
  runtime_minutes: number | null;
  overview: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  original_language: string | null;
  genres: string[];
  popularity: number | null;
};

/** The payload `tmdb_upsert_seasons` accepts. */
export type SeasonRow = {
  season_number: number;
  tmdb_id: number | null;
  title: string | null;
  release_date: string | null;
  overview: string | null;
  poster_path: string | null;
};

/** TMDB sends '' for a date it does not have, and '' is not a date. */
const dateOrNull = (value: string | null | undefined) => (value ? value : null);

const textOrNull = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/**
 * A search-shaped result into a catalogue row.
 *
 * `assume` is the kind to use when the response does not say. /search/multi always
 * says, because it has to — the same page carries films, shows and people. The
 * single-kind endpoints do not have to and are inconsistent about it: /trending/movie
 * does in practice, /movie/{id}/recommendations does not at all.
 *
 * Without this the recommendations endpoint would return nothing whatsoever and look
 * like a title with no similar films, which is a silent empty rather than an error.
 * Passing the kind the caller *asked for* is also strictly more trustworthy than
 * reading it back off the response: a caller that requested /movie got films.
 *
 * `assume` is undefined for /search/multi, where a missing `media_type` means a
 * person and dropping the row is correct.
 */
export function fromSearchResult(
  result: TmdbSearchResult,
  genreNames: Map<number, string>,
  assume?: 'movie' | 'tv',
): TitleRow | null {
  const mediaType = result.media_type ?? assume;
  // /search/multi returns people too, and a person is not a catalogue row.
  if (mediaType !== 'movie' && mediaType !== 'tv') return null;

  const isMovie = mediaType === 'movie';
  const title = textOrNull(isMovie ? result.title : result.name);
  if (!title) return null;

  return {
    kind: isMovie ? 'movie' : 'series',
    tmdb_id: result.id,
    title,
    original_title: textOrNull(isMovie ? result.original_title : result.original_name),
    release_date: dateOrNull(isMovie ? result.release_date : result.first_air_date),
    // A search result carries neither runtime nor episode length. Null rather than
    // zero, so the upsert's coalesce keeps whatever a detail call already wrote.
    runtime_minutes: null,
    overview: textOrNull(result.overview),
    poster_path: result.poster_path ?? null,
    backdrop_path: result.backdrop_path ?? null,
    original_language: textOrNull(result.original_language),
    genres: (result.genre_ids ?? [])
      .map((id) => genreNames.get(id))
      .filter((name): name is string => Boolean(name)),
    popularity: result.popularity ?? null,
  };
}

export function fromMovieDetail(detail: TmdbMovieDetail): TitleRow {
  return {
    kind: 'movie',
    tmdb_id: detail.id,
    title: detail.title,
    original_title: textOrNull(detail.original_title),
    release_date: dateOrNull(detail.release_date),
    runtime_minutes: detail.runtime || null,
    overview: textOrNull(detail.overview),
    poster_path: detail.poster_path ?? null,
    backdrop_path: detail.backdrop_path ?? null,
    original_language: textOrNull(detail.original_language),
    genres: (detail.genres ?? []).map((genre) => genre.name),
    popularity: detail.popularity ?? null,
  };
}

export function fromSeriesDetail(detail: TmdbSeriesDetail): TitleRow {
  return {
    kind: 'series',
    tmdb_id: detail.id,
    title: detail.name,
    original_title: textOrNull(detail.original_name),
    release_date: dateOrNull(detail.first_air_date),
    // A series has no single runtime, so this holds the typical episode length —
    // which is what the number means to someone deciding whether to start a season.
    runtime_minutes: detail.episode_run_time?.[0] || null,
    overview: textOrNull(detail.overview),
    poster_path: detail.poster_path ?? null,
    backdrop_path: detail.backdrop_path ?? null,
    original_language: textOrNull(detail.original_language),
    genres: (detail.genres ?? []).map((genre) => genre.name),
    popularity: detail.popularity ?? null,
  };
}

export function seasonsOf(detail: TmdbSeriesDetail): SeasonRow[] {
  return (detail.seasons ?? []).map((season) => ({
    season_number: season.season_number,
    tmdb_id: season.id ?? null,
    // TMDB names an ordinary season "Season 4" already; the SQL falls back to the
    // same form, so a null here is safe rather than a row titled 'null'.
    title: textOrNull(season.name),
    release_date: dateOrNull(season.air_date),
    overview: textOrNull(season.overview),
    poster_path: season.poster_path ?? null,
  }));
}

export function fromSeasonDetail(detail: TmdbSeasonDetail): SeasonRow {
  return {
    season_number: detail.season_number,
    tmdb_id: detail.id ?? null,
    title: textOrNull(detail.name),
    release_date: dateOrNull(detail.air_date),
    overview: textOrNull(detail.overview),
    poster_path: detail.poster_path ?? null,
  };
}

/**
 * The `credits` facet, trimmed before it is stored.
 *
 * A raw TMDB credits payload for a large film is a few hundred kilobytes, and
 * `use-credits.ts` renders twelve cast members and one director. Storing the rest
 * would put megabytes into `media_cache` to display none of it — and every byte of
 * it is provider data carrying a retention obligation.
 */
export function creditsFacet(credits: { cast?: unknown[]; crew?: unknown[] } | undefined) {
  const cast = ((credits?.cast ?? []) as {
    id: number;
    name: string;
    character?: string;
    profile_path?: string | null;
  }[])
    .slice(0, 20)
    .map((person) => ({
      id: person.id,
      name: person.name,
      character: person.character ?? null,
      profile_path: person.profile_path ?? null,
    }));

  // Only the crew the title screen can actually name. Keeping the department as
  // well as the job is what lets use-credits.ts fall back when a title credits a
  // "Co-Director" and no plain "Director".
  const crew = ((credits?.crew ?? []) as {
    id: number;
    name: string;
    job?: string;
    department?: string;
  }[])
    .filter((person) => person.department === 'Directing' || person.department === 'Writing')
    .slice(0, 10)
    .map((person) => ({
      id: person.id,
      name: person.name,
      job: person.job ?? null,
      department: person.department ?? null,
    }));

  return { cast, crew };
}

/**
 * Trailers, cut down to the ones a title page would offer.
 *
 * YouTube only, because that is the only site the app can open reliably, and
 * trailers and teasers only — TMDB's `type` also covers featurettes, bloopers and
 * behind-the-scenes reels, which are not what someone deciding whether to watch
 * something is looking for.
 *
 * Official first, then newest. An unofficial upload of a trailer is usually a
 * re-encode of the official one, and the studio's is the one that stays up.
 */
export function videosFacet(videos: { results?: unknown[] } | undefined) {
  const results = ((videos?.results ?? []) as {
    id: string;
    key: string;
    name: string;
    site: string;
    type: string;
    official?: boolean;
    published_at?: string;
  }[])
    .filter(
      (video) =>
        video.site === 'YouTube' && (video.type === 'Trailer' || video.type === 'Teaser'),
    )
    .sort((a, b) => {
      if (Boolean(a.official) !== Boolean(b.official)) return a.official ? -1 : 1;
      return (b.published_at ?? '').localeCompare(a.published_at ?? '');
    })
    .slice(0, 6)
    .map((video) => ({
      id: video.id,
      key: video.key,
      name: video.name,
      site: video.site,
      type: video.type,
      official: Boolean(video.official),
    }));

  return { results };
}
