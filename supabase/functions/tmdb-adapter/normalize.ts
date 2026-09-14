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
  TmdbEpisode,
  TmdbMovieDetail,
  TmdbPersonCreditEntry,
  TmdbPersonDetail,
  TmdbPersonSearchResult,
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
  /**
   * How many episodes the season has (`20260820000400`).
   *
   * Null is a real answer and the SQL coalesces on it, so a path that cannot know
   * the count leaves whatever the other path wrote. Never zero: a season TMDB
   * reports as empty has not aired, and `0 episodes` in a metadata line reads as a
   * fact about the show rather than an absence of data.
   */
  episode_count: number | null;
};

/** A count TMDB is willing to stand behind, or nothing. */
const countOrNull = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;

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
    // The series list is the only place TMDB publishes a per-season count.
    episode_count: countOrNull(season.episode_count),
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
    // This route sends no count, but it sends the episodes, so the count is exact
    // rather than inferred. Without it a season enriched only through its own route
    // — which is what `enrichOne` does for every season anchor — would never
    // acquire one, and the SQL's coalesce would have nothing to keep.
    //
    // Counted off the **raw** array rather than off `episodesOf`, which caps at
    // MAX_EPISODES: a 240-episode season still reports 240 here, so the cap stays a
    // rendering bound rather than becoming a claim about the show.
    episode_count: countOrNull(detail.episodes?.length),
  };
}

// ---------------------------------------------------------------------------
// Episodes
//
// Informational metadata for the season page's Episodes tab, and nothing else.
// Not persisted, not rankable, not loggable: PRD §10 keeps the rankable units at
// movies and TV seasons, and this is the recognition aid that helps somebody work
// out *which* season they watched.
// ---------------------------------------------------------------------------

/**
 * The most episodes one response will carry.
 *
 * A safety bound rather than a product limit. Ordinary seasons run six to
 * twenty-four; a daily soap or a long-running anime that the provider models as one
 * season can run into the hundreds, and an unbounded array is an unbounded response
 * out of an Edge Function. Two hundred trimmed episodes is roughly a hundred
 * kilobytes, which is the same order as the credits payload this file already
 * accepts, and it is far past anything the Episodes tab renders without the reader
 * asking for more.
 *
 * `episode_count` is counted off the raw array above, so a season longer than this
 * still reports its true length and the client can tell that it is seeing a prefix.
 */
export const MAX_EPISODES = 200;

/** One episode as the season page renders it. */
export type Episode = {
  episode_number: number;
  title: string | null;
  air_date: string | null;
  runtime_minutes: number | null;
  still_path: string | null;
  overview: string | null;
};

/**
 * A non-negative episode index, or nothing.
 *
 * Not `countOrNull`, which insists on a positive number. An episode numbered zero
 * is real — TMDB carries "Episode 0" pilots and prologues, usually in Specials —
 * and rejecting it would silently drop the one episode a reader is most likely to
 * be uncertain about.
 */
const indexOrNull = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;

/**
 * A season detail's episodes, trimmed to what the Episodes tab renders.
 *
 * Defensive at every step, because this is the one provider array whose elements
 * reach a screen without passing through Postgres first. `episodes` is typed
 * `unknown[]`, a non-array is treated as an absent list, and an element that is not
 * an object is skipped rather than spread.
 *
 * **An episode with no number is dropped.** The row is built around "3 · The Rains
 * of Castamere", and an episode that cannot say which one it is has nothing to
 * recognise it by. Every other field is allowed to be null and simply disappears
 * from the row.
 *
 * **Provider order is preserved and duplicates are kept.** TMDB returns episodes in
 * broadcast order, which is the order a reader scans; re-sorting on a number the
 * provider may have repeated would move rows around for no gain. A repeated number
 * is the provider's own data, and dropping the second one would lose an episode to
 * tidy up a display key. The client keys on position for that reason.
 */
export function episodesOf(detail: { episodes?: unknown }): Episode[] {
  if (!Array.isArray(detail.episodes)) return [];

  const episodes: Episode[] = [];
  for (const entry of detail.episodes) {
    if (!entry || typeof entry !== 'object') continue;

    const raw = entry as TmdbEpisode;
    const number = indexOrNull(raw.episode_number);
    if (number === null) continue;

    episodes.push({
      episode_number: number,
      title: textOrNull(raw.name),
      air_date: dateOrNull(raw.air_date),
      // A runtime of zero is TMDB's placeholder for an episode it has no length for,
      // which `countOrNull` already reads as nothing.
      runtime_minutes: countOrNull(raw.runtime),
      still_path: raw.still_path ?? null,
      overview: textOrNull(raw.overview),
    });

    if (episodes.length >= MAX_EPISODES) break;
  }

  return episodes;
}

// ---------------------------------------------------------------------------
// Which season to ask TMDB about
// ---------------------------------------------------------------------------

/**
 * The catalogue columns this file needs to name a season's provider route. Declared
 * structurally rather than imported from `store.ts`, which would pull supabase-js
 * into a module that is otherwise pure and testable without a network.
 */
type SeasonRowRef = {
  kind: string;
  parent_id: string | null;
  season_number: number | null;
};

type SeriesRowRef = { kind: string; tmdb_id: number | null };

export type SeasonTarget =
  | { ok: true; seriesTmdbId: number; seasonNumber: number }
  | { ok: false; reason: 'not_a_season' | 'malformed_season' | 'no_tmdb_id' };

/**
 * A season row and its parent into the two numbers `/tv/{series}/season/{n}` needs.
 *
 * **This is the whole reason the Episodes action is not a proxy.** Both numbers come
 * out of `media_items`; a caller supplies one Bingd uuid and no part of the outbound
 * URL. Pulled out of the handler so that the refusals below are covered by ordinary
 * tests rather than by reading the handler and believing it.
 *
 * Three distinct refusals, and they are not interchangeable:
 *
 *   not_a_season      A film or a series grouping. Episodes belong to a season, and
 *                     answering with an empty list would be indistinguishable from a
 *                     season the provider has published no episodes for.
 *   malformed_season  A season with no parent, no season number, or a parent that is
 *                     not a series. The column constraints do not enforce the last of
 *                     those, and this is about to ask a /tv question about whatever
 *                     the parent turns out to be.
 *   no_tmdb_id        A series the provider has no record of — the Wikidata seed
 *                     before enrichment reaches it.
 *
 * `season_number` is checked against null rather than for truthiness. Season 0 is
 * Specials, it is a real season, and `!0` would refuse it.
 */
export function seasonTarget(row: SeasonRowRef, parent: SeriesRowRef | null): SeasonTarget {
  if (row.kind !== 'season') return { ok: false, reason: 'not_a_season' };
  if (!row.parent_id || row.season_number === null) {
    return { ok: false, reason: 'malformed_season' };
  }
  if (!parent || parent.kind !== 'series') return { ok: false, reason: 'malformed_season' };
  if (!parent.tmdb_id) return { ok: false, reason: 'no_tmdb_id' };

  return { ok: true, seriesTmdbId: parent.tmdb_id, seasonNumber: row.season_number };
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
  /**
   * Every crew job they held on this title, or null for none.
   *
   * Present on a cast-won entry too, which is the point of it: one title is one entry
   * (an older client keys its rows on the title), so somebody who directed *and* starred
   * in a film is a cast entry — and without this the Crew half of their page would
   * silently omit the film they directed.
   */
  crewRole: string | null;
  /**
   * An appearance as themselves on a talk show, a news or reality programme, or a
   * broadcast ceremony — see `isSelfAppearance`. Still a cast entry, so a client that
   * predates the flag renders exactly what it rendered before; a current one leaves it
   * out of the Cast half unless it is all the person has.
   */
  self: boolean;
  /** The provider's own relevance signal, and the only ordering this list has. */
  popularity: number;
};

/**
 * How many credits are kept for one person, per half.
 *
 * A prolific character actor has several hundred, most of them a single episode of
 * something nobody is looking for. Writing all of them through `tmdb_upsert_titles`
 * would put hundreds of rows into the catalogue per person page — rows that then
 * appear in search, join the refresh queue, and carry a retention obligation — to
 * render a list nobody scrolls to the bottom of.
 *
 * **Per half, since Cast search (2026-09-13).** It was forty across cast and crew
 * together, and the cap was applied after the merge — so an actor with a busy producing
 * career could have their *acting* list cut short by producer credits, on the page Cast
 * search now sends people to so they can see what that actor has been in.
 *
 * - Sixty acting credits: five screens of "See more", past any filmography a reader
 *   works through by hand.
 * - Thirty titles with crew work, counted over *every* title with a crew job — including
 *   one an acting credit won — and chosen directing and writing first, so a producer's
 *   long tail cannot push out the films somebody directed.
 * - Ten self-appearances, on their own, so a talk-show tail cannot use acting slots.
 *
 * A title kept by any half is kept. The counts TMDB actually had travel alongside, so the
 * page can say what it is not showing.
 */
const MAX_CAST_CREDITS = 60;
const MAX_CREW_CREDITS = 30;
const MAX_SELF_CREDITS = 10;

/** How many distinct crew jobs one title's `crewRole` names before it stops. */
const MAX_CREW_JOBS = 3;

/** The crew jobs that are authorship, which a crew half keeps ahead of the rest. */
// Whole job titles, so "Director of Photography", "Casting Director" and "Story Editor"
// are not mistaken for authorship. `crewRole` joins jobs with ", ".
const AUTHORSHIP = /(^|, )(Director|Co-Director|Writer|Screenplay|Creator|Story|Novel|Author|Teleplay)(,|$)/;

/**
 * An appearance as oneself on a talk show, a news or reality programme, or an awards
 * broadcast — which TMDB files as a cast credit, and which is not what a list labelled
 * Cast promises.
 *
 * DiCaprio's combined cast credits are a long tail of `Self` on late-night television,
 * and at TV popularity those rank above most of his films. **Television only**, and three
 * conditions, all required: a series; the character is the person themselves, or is not
 * named at all (TMDB leaves it empty on most talk-show guest spots — measured on staging,
 * `The Tonight Show with Jay Leno` topped four of five actors' lists that way); and the
 * show is News, Reality, Talk or Documentary — or has no genre at all, which is how TMDB
 * files a ceremony. Deliberately narrow:
 *
 * - A documentary or concert *film* keeps its credit. *Free Solo* is what Alex Honnold is
 *   in, and *Stop Making Sense* is what David Byrne is in.
 * - A scripted cameo as yourself keeps its credit, because a comedy is a performance.
 *
 * Flagged, never dropped: see `PersonCreditEntry.self`.
 */
const SELF_APPEARANCE = /^\s*(self|himself|herself|themselves|themself)\b/i;
const NON_PERFORMANCE_TV_GENRES = new Set([99, 10763, 10764, 10767]);

function isSelfAppearance(entry: TmdbPersonCreditEntry): boolean {
  if (entry.media_type !== 'tv') return false;
  const character = textOrNull(entry.character);
  if (character && !SELF_APPEARANCE.test(character)) return false;
  const genres = entry.genre_ids ?? [];
  return genres.length === 0 || genres.some((id) => NON_PERFORMANCE_TV_GENRES.has(id));
}

/** Which credit a title is shown under when TMDB lists it more than once. */
const precedence = (entry: { as: 'cast' | 'crew'; self: boolean }) =>
  entry.as === 'crew' ? 0 : entry.self ? 1 : 2;

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
 * tidiness. A **performance** wins a collision, then a self-appearance, then crew work,
 * because appearing in something is what a viewer recognises somebody for; among two
 * credits of the same standing the more popular entry wins, which for a series is the
 * season with the most reach.
 *
 * WHAT IS DROPPED. Anything `fromSearchResult` refuses — a credit with no title, or
 * with a media_type that is neither movie nor tv. TMDB does send `media_type` on
 * combined credits, and unlike /recommendations there is no sensible kind to assume
 * for a list that deliberately mixes both, so a missing one drops the row. Nothing else:
 * a self-appearance is flagged, not dropped.
 *
 * CAPS. Applied to each half separately, after the merge — see `MAX_CAST_CREDITS`. What
 * survives is returned in one list in popularity order, one entry per title, which is
 * the shape every client already reads.
 */
export function personCredits(
  detail: TmdbPersonDetail,
  genreNames: Map<number, string>,
): { credits: PersonCreditEntry[]; total: number; castTotal: number; crewTotal: number } {
  const cast = detail.combined_credits?.cast ?? [];
  const crew = detail.combined_credits?.crew ?? [];

  const best = new Map<string, PersonCreditEntry>();
  // Every distinct crew job per title, whichever credit wins the title.
  const jobs = new Map<string, string[]>();

  const consider = (entry: TmdbPersonCreditEntry, as: 'cast' | 'crew') => {
    const row = fromSearchResult(entry, genreNames);
    if (!row) return;

    const key = `${row.kind}:${row.tmdb_id}`;
    // `textOrNull` on each side of the fallback: TMDB sends `""` for a job it does not
    // have, and `??` alone would keep the empty string and never reach the department.
    const role =
      as === 'cast'
        ? textOrNull(entry.character)
        : (textOrNull(entry.job) ?? textOrNull(entry.department));

    if (as === 'crew' && role) {
      const held = jobs.get(key) ?? [];
      if (!held.includes(role) && held.length < MAX_CREW_JOBS) held.push(role);
      jobs.set(key, held);
    }

    const candidate: PersonCreditEntry = {
      row,
      role,
      as,
      crewRole: null,
      self: as === 'cast' && isSelfAppearance(entry),
      popularity: entry.popularity ?? 0,
    };

    const held = best.get(key);
    if (!held) {
      best.set(key, candidate);
      return;
    }

    // A performance beats a self-appearance beats crew work; within one standing, the
    // more visible entry wins. Without the second clause a series' least-watched season
    // would decide both the ordering and the role shown for the whole show.
    const rank = precedence(candidate) - precedence(held);
    if (rank > 0 || (rank === 0 && candidate.popularity > held.popularity)) {
      best.set(key, candidate);
    }
  };

  for (const entry of cast) consider(entry, 'cast');
  for (const entry of crew) consider(entry, 'crew');

  const ordered = [...best.entries()]
    .map(([key, entry]) => {
      const held = jobs.get(key);
      const crewRole = held?.length ? held.join(', ') : null;
      // A crew-won title names every job, not whichever one TMDB listed as most popular.
      return entry.as === 'crew'
        ? { ...entry, role: crewRole ?? entry.role, crewRole: crewRole ?? entry.role }
        : { ...entry, crewRole };
    })
    .sort((a, b) => b.popularity - a.popularity);

  const performances = ordered.filter((entry) => entry.as === 'cast' && !entry.self);
  const appearances = ordered.filter((entry) => entry.self);
  const crewWork = ordered.filter((entry) => entry.crewRole !== null);
  // Authorship first, then popularity: `sort` is stable, so within each group the
  // popularity order above survives.
  const crewKept = [...crewWork]
    .sort((a, b) => Number(AUTHORSHIP.test(b.crewRole ?? '')) - Number(AUTHORSHIP.test(a.crewRole ?? '')))
    .slice(0, MAX_CREW_CREDITS);

  const kept = new Set([
    ...performances.slice(0, MAX_CAST_CREDITS),
    ...appearances.slice(0, MAX_SELF_CREDITS),
    ...crewKept,
  ]);

  return {
    credits: ordered.filter((entry) => kept.has(entry)),
    total: ordered.length,
    // Performances only: the number the Cast half's caption states.
    castTotal: performances.length,
    // Titles with any crew job, including the ones an acting credit won — the same set
    // the Crew half of the page draws from.
    crewTotal: crewWork.length,
  };
}

// ---------------------------------------------------------------------------
// Cast search
// ---------------------------------------------------------------------------

/** One performer, as a Cast search result row draws them. */
export type CastSearchResult = {
  /** TMDB's person id — what `/person/{id}` routes on and `person_cache` is keyed by. */
  id: number;
  name: string;
  profile_path: string | null;
  /** Up to three titles TMDB says they are known for, to tell two namesakes apart. */
  known_for: string[];
  /**
   * TMDB's popularity for the person, or null. Carried so the All tab can leave out an
   * obscure namesake: within people it is comparable, and it is never compared with a
   * title's score or an account's.
   */
  popularity: number | null;
};

const MAX_KNOWN_FOR = 3;

/**
 * How strongly a performer's name answers a Cast query: 0 is the full name, 1 a name the
 * query starts (every typed word begins a different word of the name, the first typed word
 * the first name), 2 any other order of those words ("hanks" for Tom Hanks), 3 only the
 * letters run together ("leonardodi"), null no match at all.
 *
 * Words are matched by trying every assignment, not greedily: "j jackson" is Samuel L.
 * Jackson even though "j" alone would also begin "jackson" (independent review). Run-together
 * letters are the weakest match because they also join words the reader never meant as one:
 * "joel" runs into Joe Lo Truglio (independent review).
 *
 * **The gate, not a score.** Popularity orders people inside a strength and never lifts a
 * weaker one: a famous actor whose name does not begin with what was typed is not an answer
 * to it however famous they are. Words are compared through `titleKey`, so case, accents
 * and punctuation ("Jean-Claude", "Timothée") do not decide anything.
 */
export function castNameMatch(name: string, query: string): 0 | 1 | 2 | 3 | null {
  const typed = titleKey(query).split(' ').filter(Boolean);
  const words = titleKey(name).split(' ').filter(Boolean);
  if (!typed.length || !words.length) return null;
  if (words.join('') === typed.join('')) return 0;

  // Can typed words from `from` on each begin a different, unused word of the name?
  const assignable = (from: number, used: boolean[]): boolean => {
    if (from === typed.length) return true;
    for (let at = 0; at < words.length; at++) {
      if (used[at] || !words[at].startsWith(typed[from])) continue;
      used[at] = true;
      const rest = assignable(from + 1, used);
      used[at] = false;
      if (rest) return true;
    }
    return false;
  };
  if (typed.length <= words.length) {
    if (words[0].startsWith(typed[0]) && assignable(1, words.map((_, index) => index === 0))) return 1;
    if (assignable(0, words.map(() => false))) return 2;
  }

  // A name typed without its spaces ("leonardodi", "delroy lindo" as "delroylindo").
  return words.join('').startsWith(typed.join('')) ? 3 : null;
}

/**
 * Cast rows for a query: TMDB's answer and the popular-performer index, ranked by name
 * first and popularity second.
 *
 * **Why the index exists** (measured 2026-09-14): /search/person ranks a name with a word
 * EQUAL to the query above every name that only starts with it, so "leo" returns 10,000
 * people named Leo and Leonardo DiCaprio is not in the first 200. The index is TMDB's
 * /person/popular, refreshed nightly (see 20260919000100); only its entries whose name
 * passes `castNameMatch` are considered, so it can add the person being typed toward and
 * nobody else. An index entry needs a word-level match (strength 0 to 2); letters that only
 * match run together are accepted from TMDB's own answer and never from the index.
 *
 * **Order.** Strength (exact name, then names the query starts, then other word orders),
 * then popularity (unknown counts as least), then where the person came from: TMDB's own
 * position, then the index's.
 *
 * **A one-word exact name leads only if somebody searches for it** (measured on staging
 * 2026-09-14). "emma", "scar" and "kean" are each the whole name of a performer at 0.3 to
 * 0.4, and as the strongest match those led Emma Stone, Scarlett Johansson and Keanu Reeves.
 * So a single typed word that is somebody's entire name counts as exact only at
 * `MONONYM_EXACT_MIN_POPULARITY`, the floor the All page already uses for a whole name
 * (Cher 1.4, Madonna 2.7); below it, it is one more name the query starts, ordered by
 * popularity. Two or more words that are a full name are specific enough to lead as typed. That last key makes the order total, so the same inputs
 * always give the same list. A TMDB result whose name does not pass the gate (TMDB also
 * matches aliases and other scripts) is kept, after every match, in TMDB's order — it is
 * the provider's answer, and dropping it would hide somebody searched for by another name.
 */
export function rankCast(
  query: string,
  provider: readonly CastSearchResult[],
  index: readonly CastSearchResult[],
  limit: number,
): CastSearchResult[] {
  const seen = new Set<number>();
  const ranked: { person: CastSearchResult; strength: number; order: number }[] = [];

  const oneWord = titleKey(query).split(' ').filter(Boolean).length === 1;
  const strengthOf = (person: CastSearchResult) => {
    const strength = castNameMatch(person.name, query);
    return strength === 0 && oneWord && (person.popularity ?? 0) < MONONYM_EXACT_MIN_POPULARITY
      ? 1
      : strength;
  };

  provider.forEach((person, order) => {
    if (seen.has(person.id)) return;
    seen.add(person.id);
    ranked.push({ person, strength: strengthOf(person) ?? UNMATCHED, order });
  });
  index.forEach((person, position) => {
    if (seen.has(person.id)) return;
    const strength = strengthOf(person);
    if (strength === null || strength > 2) return;
    seen.add(person.id);
    ranked.push({ person, strength, order: provider.length + position });
  });

  ranked.sort((a, b) => {
    if (a.strength !== b.strength) return a.strength - b.strength;
    if (a.strength !== UNMATCHED) {
      const popularity = (b.person.popularity ?? -1) - (a.person.popularity ?? -1);
      if (popularity !== 0) return popularity;
    }
    return a.order - b.order;
  });

  return ranked.slice(0, Math.max(limit, 0)).map((entry) => entry.person);
}

/** The strength of a TMDB result the name gate did not pass: after every match. */
const UNMATCHED = 4;

/** The popularity a one-word whole name needs to lead as exact. See `rankCast`. */
const MONONYM_EXACT_MIN_POPULARITY = 1;

/**
 * The popular-performer index row's payload, as far as it can be trusted.
 *
 * The adapter wrote it, but it is read back from a world-readable table on every search,
 * so a malformed entry is skipped rather than allowed to reach a response. The shape is
 * exactly a `CastSearchResult`.
 */
export function peopleIndexEntries(payload: unknown): CastSearchResult[] {
  const people = (payload as { people?: unknown } | null)?.people;
  if (!Array.isArray(people)) return [];

  const out: CastSearchResult[] = [];
  for (const entry of people as Record<string, unknown>[]) {
    if (!entry || typeof entry !== 'object') continue;
    const id = entry.id;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || !name) continue;
    out.push({
      id,
      name,
      profile_path: typeof entry.profile_path === 'string' ? entry.profile_path : null,
      known_for: Array.isArray(entry.known_for)
        ? (entry.known_for as unknown[]).filter((title): title is string => typeof title === 'string').slice(0, MAX_KNOWN_FOR)
        : [],
      popularity:
        typeof entry.popularity === 'number' && Number.isFinite(entry.popularity) ? entry.popularity : null,
    });
  }
  return out;
}

/**
 * /search/person into Cast rows: performers only, in TMDB's own order.
 *
 * **Performers only**, by `known_for_department === 'Acting'`. The control is labelled
 * Cast, so a cinematographer who shares a name with an actor is not an answer to it —
 * and TMDB's department is the provider's own statement of what somebody is known for,
 * which is the question a result row has to answer. A director who acts now and again
 * is still reachable from any title they appear in, through the cast strip.
 *
 * **Adult results are dropped** even though the request already asks TMDB not to send
 * them, because the flag on the row is the thing that is actually true.
 *
 * Nothing here is written anywhere. A search result is a pointer to a person page, and
 * the page's own `person` action is what caches a filmography.
 */
export function castSearchResults(
  results: readonly TmdbPersonSearchResult[],
  limit: number,
): CastSearchResult[] {
  const out: CastSearchResult[] = [];
  const seen = new Set<number>();

  for (const result of results) {
    if (!Number.isSafeInteger(result.id) || result.id <= 0) continue;
    if (result.adult === true) continue;
    if (result.known_for_department !== 'Acting') continue;
    const name = textOrNull(result.name);
    if (!name) continue;
    if (seen.has(result.id)) continue;
    seen.add(result.id);

    const knownFor: string[] = [];
    for (const title of result.known_for ?? []) {
      const label = textOrNull(title.title ?? title.name);
      if (label && !knownFor.includes(label)) knownFor.push(label);
      if (knownFor.length >= MAX_KNOWN_FOR) break;
    }

    out.push({
      id: result.id,
      name,
      profile_path: result.profile_path ?? null,
      known_for: knownFor,
      popularity:
        typeof result.popularity === 'number' && Number.isFinite(result.popularity)
          ? result.popularity
          : null,
    });
    if (out.length >= limit) break;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Where to watch
//
// Availability, from JustWatch by way of TMDB. Reference metadata for one block on
// one screen: never stored, never written into the catalogue, and — like episodes —
// normalized down to the handful of fields a row actually draws before it leaves
// this file. The raw response names every country TMDB knows; what comes out of here
// names one.
// ---------------------------------------------------------------------------

/**
 * The country to answer for when the caller does not name a usable one.
 *
 * A **US beta default**, and it is a stated limitation rather than a claim that
 * availability is global. The device's own region is the first choice and reaches
 * this file as `p_region`; this is what happens when the phone reports nothing, or
 * reports something that is not a country code. Region *selection* — a reader in a
 * market the device is not set to, a traveller — is deferred, and recorded as
 * deferred in `docs/reference/tmdb-integration.md`.
 */
export const DEFAULT_WATCH_REGION = 'US';

/**
 * A safety bound on one country's list.
 *
 * The block draws three logos and the sheet a scrolling list; forty is far past
 * anything a market publishes and exists so the response cannot be unbounded. It
 * is applied after deduplication, so a service offering all three of stream, rent
 * and buy costs one of the forty rather than three.
 */
export const MAX_WATCH_PROVIDERS = 40;

/** How a title can be watched. Three, and TMDB's `flatrate` is Bingd's `stream`. */
export type WatchOffer = 'stream' | 'rent' | 'buy';

/** One service, and every way this title is offered on it. */
export type WatchProvider = {
  provider_id: number;
  name: string;
  /** TMDB's path form, like every other image in the schema. Null renders as initials. */
  logo_path: string | null;
  /** In the order stream, rent, buy. Never empty — an entry with no offer is dropped. */
  offers: WatchOffer[];
};

export type WatchAvailability = {
  /** The country actually answered for, which may not be the one asked about. */
  region: string;
  /**
   * TMDB's own watch-options page for this title in this region, or null.
   *
   * The **only** link this feature has. TMDB's payload carries no per-service deep
   * link, so a provider logo opens nothing: manufacturing `netflix.com/title/…`
   * from a provider name would be a guess presented as a destination.
   */
  link: string | null;
  providers: WatchProvider[];
};

/**
 * The three arrays read, in the order the sheet groups them.
 *
 * `free` and `ads` are deliberately not read. The founder's brief names three
 * categories and the sheet has three headings; folding an ad-supported service in
 * under "Stream" would put Tubi beside Netflix and say the same thing about both,
 * and inventing a fourth heading is not this tranche's decision to make. Recorded
 * rather than quietly dropped — it is the reason a title available only on Tubi
 * shows no block at all.
 */
const OFFER_SOURCES = [
  ['stream', 'flatrate'],
  ['rent', 'rent'],
  ['buy', 'buy'],
] as const;

/**
 * TMDB's own watch-options page, or nothing.
 *
 * Checked rather than escaped, for the reason `videoUri` states on the client: this
 * string is about to be handed to `Linking.openURL` on a phone, and the shape is
 * provider-owned data that has never varied. A link that is not an `https` URL on
 * themoviedb.org is not the page this row claims to open, so the row simply is not
 * offered — which is a better outcome than opening somewhere unexpected.
 *
 * Done here rather than on the client because this file is the boundary AD-8 puts
 * around the provider: nothing downstream should have to know what TMDB sends.
 */
function watchOptionsLink(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  return host === 'themoviedb.org' || host === 'www.themoviedb.org' ? value : null;
}

/**
 * A country code, or the default.
 *
 * Two letters, upper-cased. This is the one value in the request the caller
 * controls, and it is used as an **object key** rather than as part of a URL — the
 * route is built entirely from `media_items` — so the check is about answering a
 * sensible question rather than about escaping. Anything else falls back rather
 * than failing: a phone reporting a region TMDB has never heard of should see the
 * US list, not an error on a title page.
 */
export function watchRegionOf(region: unknown): string {
  if (typeof region !== 'string') return DEFAULT_WATCH_REGION;
  const upper = region.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(upper) ? upper : DEFAULT_WATCH_REGION;
}

/**
 * One country's availability, out of a response that carries every country.
 *
 * **Deduplicated across categories, and that is the point of the shape.** Apple TV
 * routinely appears under both `rent` and `buy`, and two rows with the same logo and
 * the same name reads as a rendering fault. One entry carrying `['rent', 'buy']`
 * lets the sheet list it under both headings and the compact row count it once.
 *
 * Provider order is TMDB's, within the category order above: they arrive sorted by
 * `display_priority`, which is the provider's prominence in that market, and that is
 * a better first-three than anything derivable here. A service first seen under
 * `rent` keeps that position when it later turns up under `buy`.
 *
 * Defensive at every step, because these elements reach a screen without passing
 * through Postgres: a non-object is skipped, an entry with no numeric id or no name
 * is dropped rather than drawn as a blank row, and a missing `logo_path` is a null
 * the row renders around.
 */
export function watchAvailability(
  payload: { results?: Record<string, unknown> } | null | undefined,
  region: unknown,
): WatchAvailability {
  const resolved = watchRegionOf(region);
  const bucket = payload?.results?.[resolved] as
    | { link?: unknown; flatrate?: unknown; rent?: unknown; buy?: unknown }
    | undefined;

  if (!bucket || typeof bucket !== 'object') {
    return { region: resolved, link: null, providers: [] };
  }

  const byId = new Map<number, WatchProvider>();

  for (const [offer, key] of OFFER_SOURCES) {
    const entries = bucket[key];
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;

      const raw = entry as { provider_id?: unknown; provider_name?: unknown; logo_path?: unknown };
      const id =
        typeof raw.provider_id === 'number' && Number.isSafeInteger(raw.provider_id)
          ? raw.provider_id
          : null;
      const name = textOrNull(typeof raw.provider_name === 'string' ? raw.provider_name : null);
      if (id === null || !name) continue;

      const held = byId.get(id);
      if (held) {
        // The categories are visited in a fixed order and each at most once, so a
        // repeat within one array is the only way this can already be present —
        // which is the provider's own data and not something to add twice.
        if (!held.offers.includes(offer)) held.offers.push(offer);
        continue;
      }

      if (byId.size >= MAX_WATCH_PROVIDERS) continue;
      byId.set(id, {
        provider_id: id,
        name,
        logo_path: typeof raw.logo_path === 'string' && raw.logo_path ? raw.logo_path : null,
        offers: [offer],
      });
    }
  }

  return {
    region: resolved,
    // Present only alongside real availability. TMDB sends the link on a bucket that
    // exists, and a bucket can exist with every offer array empty — a page saying
    // "not available anywhere" is not a watch option.
    link: byId.size > 0 ? watchOptionsLink(bucket.link) : null,
    providers: [...byId.values()],
  };
}

// ---------------------------------------------------------------------------
// Exact titles in search
// ---------------------------------------------------------------------------

/**
 * A title reduced to what a person means by "the same name": case, accents, surrounding
 * whitespace and punctuation folded away, words kept apart.
 *
 * Deliberately not fuzzier than that. "Don't" is `don t`, not `don`; "Don 2" is not "Don";
 * "Dune: Part Two" is `dune part two`. Two titles share a key only when a reader would call
 * them the same words.
 */
export function titleKey(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Titles named exactly what was searched for, first; everything else in the provider's order.
 *
 * TMDB's search ranks by a popularity-weighted relevance that does not privilege an exact
 * name. On 2026-09-14, "Don" put the Shah Rukh Khan film at position 47 of /search/multi,
 * behind *Don Juan*, *Don Jon* and a page of *Don't …*. A stable partition, never a
 * re-score: exact matches keep TMDB's order among themselves (two films called *Signs*
 * stay in the provider's order, with the year on the row to tell them apart), and so does
 * everything after them.
 */
export function exactTitleFirst<T extends { title: string }>(rows: readonly T[], query: string): T[] {
  const key = titleKey(query);
  if (!key) return [...rows];
  const exact = rows.filter((row) => titleKey(row.title) === key);
  if (!exact.length) return [...rows];
  return [...exact, ...rows.filter((row) => titleKey(row.title) !== key)];
}

/**
 * Whether one extra request is worth making to find a title named exactly what was typed.
 *
 * Narrow on purpose, because every other search costs one request. Three conditions:
 *
 * 1. **Page 1 has no exact match.** A popular exact title is already there ("Her", "Up",
 *    "Signs" all lead page 1).
 * 2. **TMDB has more pages.** A one-page answer is the whole answer.
 * 3. **A page-1 title contains every word of the query as a whole word.** That is the
 *    failure's shape: the query is a real word that longer, more popular titles are built
 *    from ("Don" inside *Don Juan*, *Don't Look Up*). A half-typed word ("incepti") matches
 *    no whole word and does not qualify, so an unfinished query never spends the extra
 *    request.
 * 4. **Not only filler words.** "the", "a", "of" on the way to a longer title contain
 *    nothing a title could be named; a query made of nothing else never qualifies.
 *
 * The client caches page 1 for half an hour, so whatever qualifies spends its extra request
 * once per reader per query, not once per keystroke.
 */
/** Words that name nothing on their own, in the languages most titles here are searched in. */
const FILLER_WORDS = new Set([
  'a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to',
  'with', 'my', 'me', 'we', 'you', 'la', 'le', 'les', 'el', 'los', 'las', 'de', 'der', 'die',
  'das', 'un', 'une',
]);

export function wantsExactRecovery(
  query: string,
  rows: readonly { title: string }[],
  totalPages: number,
): boolean {
  const key = titleKey(query);
  if (!key || totalPages <= 1) return false;
  const words = key.split(' ');
  if (words.every((word) => FILLER_WORDS.has(word))) return false;
  if (rows.some((row) => titleKey(row.title) === key)) return false;
  return rows.some((row) => {
    const titleWords = new Set(titleKey(row.title).split(' '));
    return words.every((word) => titleWords.has(word));
  });
}
