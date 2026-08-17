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
  TmdbContentRatings,
  TmdbMovieDetail,
  TmdbPersonCreditEntry,
  TmdbPersonDetail,
  TmdbReleaseDates,
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
  /**
   * The US content certification, where TMDB has one.
   *
   * Present on a detail row and null on a search row, and the asymmetry is
   * load-bearing: `tmdb_upsert_titles` coalesces, so a search running after a detail
   * call must not blank what the detail wrote.
   */
  certification: string | null;
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
    // A search response has no certification at all. Null rather than absent so the
    // shape is one thing, and the upsert coalesces so this cannot blank a detail write.
    certification: null,
  };
}

/**
 * The region whose certification Bingd shows.
 *
 * One region, chosen here rather than at read time, because V1 has one environment and
 * the adapter already hardcodes `language=en-US` on every request. The column that
 * stores this says the same thing (`20260817000900`), and both say it in the same
 * place a future regional Bingd would have to change.
 */
const CERTIFICATION_REGION = 'US';

/**
 * A film's certification, out of TMDB's `release_dates`.
 *
 * The shape is the awkward part and it is worth being explicit about. TMDB lists, per
 * country, a set of *release events* — theatrical, limited, digital, physical, TV —
 * and each event carries its own `certification` field. Most of them are `''`. A film
 * rated PG-13 typically has the rating on one or two of its five US events and an
 * empty string on the rest, so "take the first" is wrong and "take `results[0]`" is
 * wrong; the answer is the first **non-empty** certification in the region's list.
 *
 * Null when the region has no entry, or has one with nothing rated on it. Never a
 * fabricated `NR`: that is a claim about a film's content that nobody made.
 */
export function certificationOf(releases: TmdbReleaseDates | undefined): string | null {
  const region = (releases?.results ?? []).find(
    (entry) => entry.iso_3166_1 === CERTIFICATION_REGION,
  );

  for (const release of region?.release_dates ?? []) {
    const value = textOrNull(release.certification);
    if (value) return value;
  }

  return null;
}

/**
 * A series' certification, out of TMDB's `content_ratings`.
 *
 * One rating per country, so this is a lookup rather than a walk — which is why it is
 * its own function rather than a branch inside the one above. The two endpoints have
 * genuinely different shapes and a shared reader would be a union with a comment
 * explaining which half applies.
 */
export function ratingOf(ratings: TmdbContentRatings | undefined): string | null {
  const region = (ratings?.results ?? []).find(
    (entry) => entry.iso_3166_1 === CERTIFICATION_REGION,
  );

  return textOrNull(region?.rating);
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
    certification: certificationOf(detail.release_dates),
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
    certification: ratingOf(detail.content_ratings),
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

// ---------------------------------------------------------------------------
// Reviews
//
// `reviewsFacet` lived here for one day. TMDB's review endpoint is another site's
// members writing about a film, and the founder's correction is that a tab called
// Reviews on a social product should be Bingd's own — so it is `title_reviews` over
// public Notes now, and this had no reader. `20260817001000` deletes the stored rows
// and narrows the facet set back, because provider data nothing renders is a retention
// obligation under PRD §19 for nothing.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** How much biography is kept. Long enough to be a paragraph, short enough not to be a book. */
const MAX_BIOGRAPHY_CHARS = 1_200;

/**
 * The person half of a `person_cache` payload.
 *
 * Everything here is what a reader who has just tapped a face wants before they
 * start scrolling a filmography: who this is, what they are known for, and enough
 * biography to place them. Nothing here is viewer-relative and nothing here is
 * private — it is the same catalogue metadata TMDB publishes on a public page.
 */
export function personRecord(detail: TmdbPersonDetail) {
  const biography = textOrNull(detail.biography);

  return {
    name: detail.name,
    profile_path: detail.profile_path ?? null,
    known_for: textOrNull(detail.known_for_department),
    biography: biography ? biography.slice(0, MAX_BIOGRAPHY_CHARS) : null,
    biography_truncated: Boolean(biography && biography.length > MAX_BIOGRAPHY_CHARS),
    birthday: dateOrNull(detail.birthday),
    deathday: dateOrNull(detail.deathday),
    place_of_birth: textOrNull(detail.place_of_birth),
  };
}

/** What one credit contributes beyond the title row itself. */
export type PersonCreditEntry = {
  /** The normalized catalogue row, for `tmdb_upsert_titles`. */
  row: TitleRow;
  /** Their character, or their crew job. Null when TMDB names neither. */
  role: string | null;
  /** Which list it came from, so the client can say "Acting" versus "Directing". */
  as: 'cast' | 'crew';
  /** The provider's own relevance signal, and the only ordering this list has. */
  popularity: number;
};

/**
 * How many credits are kept for one person.
 *
 * A prolific character actor has several hundred, most of them a single episode of
 * something nobody is looking for. Writing all of them through `tmdb_upsert_titles`
 * would put hundreds of rows into the catalogue per person page — rows that then
 * appear in search, join the refresh queue, and carry a retention obligation — to
 * render a list nobody scrolls to the bottom of.
 *
 * Forty is two screens of "See more" past the twelve the page opens with, and it is
 * enough that the Movies and TV filters both have something in them for anyone whose
 * career spans both. The count TMDB actually had travels alongside as `credit_total`,
 * so the page can say what it is not showing rather than implying this is everything.
 */
const MAX_CREDITS = 40;

/**
 * A person's combined credits into catalogue rows, most relevant first.
 *
 * ORDERING. Provider popularity, descending. It is not a perfect proxy for "what you
 * know them from" — nothing available here is — but it is the signal TMDB's own
 * "Known For" is built on, it is already carried on every entry, and the alternative
 * of ordering by date puts an unreleased project above the film someone tapped the
 * face in. Undated and unpopular rows sort last rather than first, for the reason the
 * old person page sorted them last: an unenriched row above somebody's best-known
 * work reads as a bug.
 *
 * DEDUPLICATION. Combined credits repeat titles freely — an actor who also produced
 * appears in both lists, a series appears once per season they were credited on, and
 * a two-role part appears twice. The upsert would then hit the same row twice in one
 * statement, which Postgres refuses outright ("ON CONFLICT DO UPDATE command cannot
 * affect row a second time"), so this is a correctness requirement rather than
 * tidiness. The **cast** credit wins a collision, because appearing in something is
 * what a viewer recognises somebody for; among two cast credits the more popular
 * entry wins, which for a series is the season with the most reach.
 *
 * WHAT IS DROPPED. Anything `fromSearchResult` refuses — a credit with no title, or
 * with a media_type that is neither movie nor tv. TMDB does send `media_type` on
 * combined credits, and unlike /recommendations there is no sensible kind to assume
 * for a list that deliberately mixes both, so a missing one drops the row.
 */
export function personCredits(
  detail: TmdbPersonDetail,
  genreNames: Map<number, string>,
): { credits: PersonCreditEntry[]; total: number } {
  const cast = detail.combined_credits?.cast ?? [];
  const crew = detail.combined_credits?.crew ?? [];

  const best = new Map<string, PersonCreditEntry>();

  const consider = (entry: TmdbPersonCreditEntry, as: 'cast' | 'crew') => {
    const row = fromSearchResult(entry, genreNames);
    if (!row) return;

    const key = `${row.kind}:${row.tmdb_id}`;
    const candidate: PersonCreditEntry = {
      row,
      role: textOrNull(as === 'cast' ? entry.character : (entry.job ?? entry.department)),
      as,
      popularity: entry.popularity ?? 0,
    };

    const held = best.get(key);
    if (!held) {
      best.set(key, candidate);
      return;
    }

    // Cast beats crew outright; within one kind of credit, the more visible entry
    // wins. Without the second clause a series' least-watched season would decide
    // both the ordering and the role shown for the whole show.
    if (held.as === 'crew' && as === 'cast') best.set(key, candidate);
    else if (held.as === as && candidate.popularity > held.popularity) best.set(key, candidate);
  };

  for (const entry of cast) consider(entry, 'cast');
  for (const entry of crew) consider(entry, 'crew');

  const ordered = [...best.values()].sort((a, b) => b.popularity - a.popularity);

  return { credits: ordered.slice(0, MAX_CREDITS), total: ordered.length };
}
