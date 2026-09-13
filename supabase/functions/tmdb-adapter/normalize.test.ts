/**
 * The two normalizers Phase E added, and the one existing one they lean on.
 *
 * `personCredits` and the two certification readers are pure functions of a provider
 * payload, and each does something a reader of the calling code cannot verify by eye:
 * one deduplicates and re-ranks a list that arrives with duplicates in it by design,
 * and the others walk a shape whose empty entries outnumber its useful ones. The deduplication in particular is a correctness requirement
 * rather than tidiness — a repeated title makes `tmdb_upsert_titles` fail outright
 * with "ON CONFLICT DO UPDATE command cannot affect row a second time" — and that is
 * a failure the client would see as a person with no credits at all.
 *
 * `episodesOf` and `seasonTarget` joined them with the Episodes tab, and they are
 * here for a sharper reason: episode metadata is the only provider array that
 * reaches a screen without being written to Postgres first, so its parsing is the
 * only parsing in this file with no schema behind it to catch a bad shape.
 *
 * Run with `npm run functions:test`.
 */

import { assert, assertEquals } from '@std/assert';

import {
  MAX_EPISODES,
  MAX_WATCH_PROVIDERS,
  certificationOf,
  episodesOf,
  watchAvailability,
  watchRegionOf,
  fromMovieDetail,
  fromSeasonDetail,
  fromSearchResult,
  fromSeriesDetail,
  castSearchResults,
  personCredits,
  personRecord,
  ratingOf,
  seasonTarget,
  seasonsOf,
} from './normalize.ts';
import { genreNames, knownGenres, type TmdbPersonDetail } from './tmdb.ts';

const GENRES = new Map<number, string>([
  [28, 'Action'],
  [18, 'Drama'],
]);

// ---------------------------------------------------------------------------
// personCredits
// ---------------------------------------------------------------------------

const credit = (
  id: number,
  overrides: Partial<{
    media_type: 'movie' | 'tv';
    title: string;
    name: string;
    popularity: number;
    character: string;
    job: string;
  }> = {},
) => ({
  id,
  media_type: overrides.media_type ?? ('movie' as const),
  title: overrides.title ?? `Film ${id}`,
  name: overrides.name,
  popularity: overrides.popularity ?? 1,
  character: overrides.character,
  job: overrides.job,
  genre_ids: [28],
});

const person = (combined: TmdbPersonDetail['combined_credits']): TmdbPersonDetail => ({
  id: 1,
  name: 'Somebody',
  combined_credits: combined,
});

Deno.test('credits are ordered by provider popularity, most relevant first', () => {
  const { credits } = personCredits(
    person({
      cast: [
        credit(1, { popularity: 3, character: 'A' }),
        credit(2, { popularity: 90, character: 'B' }),
        credit(3, { popularity: 40, character: 'C' }),
      ],
    }),
    GENRES,
  );

  assertEquals(credits.map((entry) => entry.row.tmdb_id), [2, 3, 1]);
});

Deno.test('a title credited twice is stored once', () => {
  // Combined credits repeat titles freely — an actor who also produced appears in
  // both lists, and a two-role part appears twice in one. The upsert would then hit
  // the same row twice in one statement, which Postgres refuses outright.
  const { credits } = personCredits(
    person({
      cast: [credit(1, { character: 'Young Cobb' }), credit(1, { character: 'Cobb' })],
      crew: [credit(1, { job: 'Producer' })],
    }),
    GENRES,
  );

  assertEquals(credits.length, 1);
});

Deno.test('the acting credit wins over the crew one', () => {
  // Appearing in something is what a viewer recognises somebody for.
  const { credits } = personCredits(
    person({
      cast: [credit(1, { character: 'Cobb', popularity: 5 })],
      crew: [credit(1, { job: 'Producer', popularity: 500 })],
    }),
    GENRES,
  );

  assertEquals(credits[0].as, 'cast');
  assertEquals(credits[0].role, 'Cobb');
});

Deno.test('among two acting credits the more visible one decides the role', () => {
  // For a series this is the season with the most reach, which is also the entry
  // whose popularity should be deciding where the show sits in the list.
  const { credits } = personCredits(
    person({
      cast: [
        credit(1, { character: 'Guest', popularity: 2 }),
        credit(1, { character: 'Lead', popularity: 90 }),
      ],
    }),
    GENRES,
  );

  assertEquals(credits.length, 1);
  assertEquals(credits[0].role, 'Lead');
  assertEquals(credits[0].popularity, 90);
});

Deno.test('a crew credit falls back to its department when TMDB names no job', () => {
  const { credits } = personCredits(
    person({ crew: [{ ...credit(1), job: undefined, department: 'Sound' }] }),
    GENRES,
  );

  assertEquals(credits[0].role, 'Sound');
});

Deno.test('television keeps its own title field and becomes a series', () => {
  const { credits } = personCredits(
    person({
      cast: [
        {
          ...credit(7, { media_type: 'tv', character: 'Luke' }),
          title: undefined,
          name: 'Growing Pains',
        },
      ],
    }),
    GENRES,
  );

  assertEquals(credits[0].row.kind, 'series');
  assertEquals(credits[0].row.title, 'Growing Pains');
});

Deno.test('a credit with no media type is dropped rather than assumed', () => {
  // Unlike /recommendations there is no sensible kind to assume for a list that
  // deliberately mixes both, so a missing one drops the row.
  const { credits } = personCredits(
    person({ cast: [{ ...credit(1), media_type: undefined as never }] }),
    GENRES,
  );

  assertEquals(credits.length, 0);
});

Deno.test('at most sixty acting credits are kept, and the totals say how many there were', () => {
  const { credits, total, castTotal } = personCredits(
    person({
      cast: Array.from({ length: 300 }, (_, index) =>
        credit(index + 1, { popularity: index, character: 'Someone' }),
      ),
    }),
    GENRES,
  );

  assertEquals(credits.length, 60);
  assertEquals(total, 300);
  assertEquals(castTotal, 300);
  // The sixty kept are the sixty most popular, not the first sixty TMDB sent.
  assertEquals(credits[0].row.tmdb_id, 300);
});

Deno.test('a busy crew career cannot crowd acting credits out of the cap', () => {
  // The cap used to be forty across both halves, applied after the merge, so an actor
  // with a hundred popular producer credits kept no acting credits at all — on the page
  // Cast search sends people to so they can see what that actor has been in.
  const { credits, crewTotal } = personCredits(
    person({
      cast: Array.from({ length: 10 }, (_, index) =>
        credit(index + 1, { popularity: 1, character: 'Lead' }),
      ),
      crew: Array.from({ length: 100 }, (_, index) =>
        credit(1000 + index, { popularity: 500, job: 'Producer' }),
      ),
    }),
    GENRES,
  );

  assertEquals(credits.filter((entry) => entry.as === 'cast').length, 10);
  assertEquals(credits.filter((entry) => entry.as === 'crew').length, 30);
  assertEquals(crewTotal, 100);
});

Deno.test('a film they acted in and directed keeps its directing credit for the Crew half', () => {
  // One entry per title, because an older client keys its rows on the title. The crew
  // jobs ride along on the acting entry instead of being discarded by the collision.
  const { credits, castTotal, crewTotal } = personCredits(
    person({
      cast: [credit(1, { character: 'Walt Kowalski' })],
      crew: [credit(1, { job: 'Director' }), credit(1, { job: 'Producer' }), credit(1, { job: 'Director' })],
    }),
    GENRES,
  );

  assertEquals(credits.length, 1);
  assertEquals(credits[0].as, 'cast');
  assertEquals(credits[0].role, 'Walt Kowalski');
  assertEquals(credits[0].crewRole, 'Director, Producer');
  assertEquals(castTotal, 1);
  assertEquals(crewTotal, 1);
});

Deno.test('a crew-only title names every job, not just the most popular one', () => {
  const { credits } = personCredits(
    person({
      crew: [credit(4, { job: 'Writer', popularity: 1 }), credit(4, { job: 'Director', popularity: 9 })],
    }),
    GENRES,
  );

  assertEquals(credits[0].as, 'crew');
  assertEquals(credits[0].role, 'Writer, Director');
  assertEquals(credits[0].crewRole, 'Writer, Director');
});

Deno.test('an acting credit has no crew role when they held no crew job', () => {
  const { credits, crewTotal } = personCredits(
    person({ cast: [credit(1, { character: 'Cobb' })] }),
    GENRES,
  );

  assertEquals(credits[0].crewRole, null);
  assertEquals(crewTotal, 0);
});

Deno.test('appearing as oneself on a talk show or a ceremony is flagged, not dropped', () => {
  // Flagged rather than dropped, because the payload reaches clients that predate the
  // Cast/Crew split and those must keep rendering what they rendered before.
  const { credits, castTotal } = personCredits(
    person({
      cast: [
        // Late-night television: Talk genre.
        { ...credit(10, { media_type: 'tv', name: 'Late Show', character: 'Self', popularity: 99 }), title: undefined, genre_ids: [10767] },
        // A guest spot TMDB names no character for, on a talk show.
        { ...credit(12, { media_type: 'tv', name: 'Tonight', popularity: 97 }), title: undefined, character: undefined, genre_ids: [10767] },
        // An awards broadcast, which TMDB files with no genre at all.
        { ...credit(11, { media_type: 'tv', name: 'The Oscars', character: 'Himself - Nominee', popularity: 98 }), title: undefined, genre_ids: [] },
        // A real part.
        credit(13, { character: 'Jack Dawson', popularity: 1 }),
      ],
    }),
    GENRES,
  );

  assertEquals(credits.map((entry) => [entry.row.tmdb_id, entry.self]), [[10, true], [11, true], [12, true], [13, false]]);
  assertEquals(credits.every((entry) => entry.as === 'cast'), true);
  // The Cast half's count is performances.
  assertEquals(castTotal, 1);
});

Deno.test('a documentary or concert film as oneself is a performance credit', () => {
  // Free Solo is what Alex Honnold is in. Only television self-appearances are flagged.
  const { credits, castTotal } = personCredits(
    person({ cast: [{ ...credit(30, { character: 'Self' }), genre_ids: [99] }, { ...credit(31, { character: 'Himself' }), genre_ids: [99, 10402] }] }),
    GENRES,
  );

  assertEquals(credits.map((entry) => entry.self), [false, false]);
  assertEquals(castTotal, 2);
});

Deno.test('an unnamed part in a scripted series is still a performance', () => {
  // No character name is a talk-show pattern only on a talk show.
  const { credits } = personCredits(
    person({ cast: [{ ...credit(40, { media_type: 'tv', name: 'ER' }), title: undefined, character: undefined, genre_ids: [18] }] }),
    GENRES,
  );

  assertEquals(credits[0].self, false);
});

Deno.test('a scripted cameo as oneself keeps its credit', () => {
  // Bill Murray in Zombieland: a comedy, so playing yourself is a performance.
  const { credits } = personCredits(
    person({ cast: [{ ...credit(20, { character: 'Bill Murray' }), genre_ids: [35] }, { ...credit(21, { character: 'Himself' }), genre_ids: [35, 27] }] }),
    GENRES,
  );

  assertEquals(credits.map((entry) => entry.row.tmdb_id).sort(), [20, 21]);
  assertEquals(credits.some((entry) => entry.self), false);
});

Deno.test('a talk-show tail cannot use the acting slots', () => {
  const { credits } = personCredits(
    person({
      cast: [
        ...Array.from({ length: 50 }, (_, index) => ({
          ...credit(500 + index, { media_type: 'tv', name: `Show ${index}`, character: 'Self', popularity: 900 }),
          title: undefined,
          genre_ids: [10767],
        })),
        ...Array.from({ length: 60 }, (_, index) => credit(1 + index, { character: 'Part', popularity: 1 })),
      ],
    }),
    GENRES,
  );

  assertEquals(credits.filter((entry) => entry.self).length, 10);
  assertEquals(credits.filter((entry) => !entry.self).length, 60);
});

Deno.test('a film they starred in and directed survives in Crew even past the acting cap', () => {
  const { credits } = personCredits(
    person({
      cast: [
        ...Array.from({ length: 60 }, (_, index) => credit(1 + index, { character: 'Lead', popularity: 100 })),
        credit(777, { character: 'Walt Kowalski', popularity: 1 }),
      ],
      crew: [credit(777, { job: 'Director', popularity: 1 })],
    }),
    GENRES,
  );

  const film = credits.find((entry) => entry.row.tmdb_id === 777);
  assertEquals(film?.crewRole, 'Director');
  assertEquals(credits.length, 61);
});

Deno.test('directing and writing are kept ahead of a long producing tail', () => {
  const { credits, crewTotal } = personCredits(
    person({
      crew: [
        ...Array.from({ length: 100 }, (_, index) => credit(1000 + index, { job: 'Executive Producer', popularity: 500 })),
        credit(1, { job: 'Director', popularity: 1 }),
        credit(2, { job: 'Screenplay', popularity: 1 }),
      ],
    }),
    GENRES,
  );

  const ids = credits.map((entry) => entry.row.tmdb_id);
  assert(ids.includes(1));
  assert(ids.includes(2));
  assertEquals(credits.length, 30);
  assertEquals(crewTotal, 102);
});

Deno.test('a job that only contains the word Director is not authorship', () => {
  const { credits } = personCredits(
    person({
      crew: [
        ...Array.from({ length: 40 }, (_, index) => credit(2000 + index, { job: 'Director of Photography', popularity: 500 })),
        credit(3, { job: 'Screenplay', popularity: 1 }),
      ],
    }),
    GENRES,
  );

  assert(credits.map((entry) => entry.row.tmdb_id).includes(3));
  assertEquals(credits.length, 30);
});

Deno.test('an empty crew job falls back to the department', () => {
  const { credits } = personCredits(
    person({ crew: [{ ...credit(1), job: '', department: 'Directing' } as never] }),
    GENRES,
  );

  assertEquals(credits[0].role, 'Directing');
  assertEquals(credits[0].crewRole, 'Directing');
});

// ---------------------------------------------------------------------------
// castSearchResults
// ---------------------------------------------------------------------------

Deno.test('Cast search keeps performers, in TMDB order, with what they are known for', () => {
  const results = castSearchResults(
    [
      {
        id: 6193,
        name: 'Leonardo DiCaprio',
        known_for_department: 'Acting',
        profile_path: '/leo.jpg',
        known_for: [
          { media_type: 'movie', title: 'Inception' },
          { media_type: 'movie', title: 'Titanic' },
          { media_type: 'movie', title: 'Inception' },
          { media_type: 'tv', name: 'Growing Pains' },
          { media_type: 'movie', title: 'The Revenant' },
        ],
      },
      { id: 999, name: 'Leonardo Somebody', known_for_department: 'Camera' },
      { id: 42, name: 'Leonardo Nam', known_for_department: 'Acting', profile_path: null },
    ],
    20,
  );

  assertEquals(results, [
    {
      id: 6193,
      name: 'Leonardo DiCaprio',
      profile_path: '/leo.jpg',
      known_for: ['Inception', 'Titanic', 'Growing Pains'],
    },
    { id: 42, name: 'Leonardo Nam', profile_path: null, known_for: [] },
  ]);
});

Deno.test('Cast search drops adult, nameless, malformed and repeated people, and honours the limit', () => {
  const results = castSearchResults(
    [
      { id: 1, name: 'A', known_for_department: 'Acting', adult: true },
      { id: 2, name: '  ', known_for_department: 'Acting' },
      { id: -3, name: 'C', known_for_department: 'Acting' },
      { id: 4, name: 'D', known_for_department: 'Acting' },
      { id: 4, name: 'D again', known_for_department: 'Acting' },
      { id: 5, name: 'E', known_for_department: 'Acting' },
      { id: 6, name: 'F', known_for_department: 'Acting' },
    ],
    2,
  );

  assertEquals(results.map((person) => person.id), [4, 5]);
});

// ---------------------------------------------------------------------------
// Genre names
// ---------------------------------------------------------------------------

Deno.test('genres a response actually carries cost no provider request when they are known', async () => {
  let charged = 0;
  const names = await genreNames(() => {
    charged += 1;
    return Promise.resolve();
  }, [28, 10765, 99]);

  assertEquals(charged, 0);
  assertEquals(names.get(28), 'Action');
  assertEquals(names.get(10765), 'Sci-Fi & Fantasy');
  assertEquals(names.get(99), 'Documentary');
});

Deno.test('an unknown genre id goes to the provider rather than being named wrongly', async () => {
  // No credential in the test environment, so reaching for the provider is observable as
  // a refusal. What matters is that the shipped table did not answer for an id it lacks.
  let answered = false;
  try {
    await genreNames(() => Promise.resolve(), [28, 424242]);
    answered = true;
  } catch {
    // Expected: the live lists were asked for.
  }
  assertEquals(answered, false);
});

Deno.test('the shipped genre table holds every name the catalogue has ever been given', () => {
  // The 36 distinct genre names staging's media_items held on 2026-09-13, across films
  // and series. A name here that the table lacks would be a genre a search now drops.
  const seen = [
    'Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family',
    'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance', 'Science Fiction',
    'TV Movie', 'Thriller', 'War', 'Western', 'Action & Adventure', 'Kids', 'News',
    'Reality', 'Sci-Fi & Fantasy', 'Soap', 'Talk', 'War & Politics',
  ];
  const names = new Set(knownGenres.values());
  for (const name of seen) assert(names.has(name), `missing ${name}`);
  assertEquals(knownGenres.size, 27);
});

Deno.test('a person with no credits at all is a person, not a failure', () => {
  const { credits, total } = personCredits(person({}), GENRES);

  assertEquals(credits.length, 0);
  assertEquals(total, 0);
});

// ---------------------------------------------------------------------------
// personRecord
// ---------------------------------------------------------------------------

Deno.test('a biography is truncated and flagged rather than silently cut', () => {
  const record = personRecord({
    id: 1,
    name: 'Somebody',
    biography: 'x'.repeat(4000),
    known_for_department: 'Acting',
  });

  assertEquals(record.biography?.length, 1200);
  assertEquals(record.biography_truncated, true);
  assertEquals(record.known_for, 'Acting');
});

Deno.test('an empty biography is null rather than an empty string', () => {
  // The screen renders the block only when there is one, and '' is truthy nowhere
  // useful and falsy in exactly the place that decides.
  const record = personRecord({ id: 1, name: 'Somebody', biography: '   ' });

  assertEquals(record.biography, null);
  assert(!record.biography_truncated);
});

// ---------------------------------------------------------------------------
// Certification
// ---------------------------------------------------------------------------

Deno.test('a film’s certification is the first non-empty one in the US list', () => {
  // TMDB lists a *release event* per country — theatrical, digital, physical — and
  // each carries its own certification, most of them empty. Taking `results[0]` or the
  // first entry gives '' for a great many films that are rated perfectly well.
  const value = certificationOf({
    results: [
      { iso_3166_1: 'GB', release_dates: [{ certification: '15' }] },
      {
        iso_3166_1: 'US',
        release_dates: [
          { certification: '', type: 1 },
          { certification: '', type: 2 },
          { certification: 'PG-13', type: 3 },
        ],
      },
    ],
  });

  assertEquals(value, 'PG-13');
});

Deno.test('a film with no US entry has no certification, rather than another country’s', () => {
  const value = certificationOf({ results: [{ iso_3166_1: 'FR', release_dates: [{ certification: '12' }] }] });

  assertEquals(value, null);
});

Deno.test('a film TMDB has not rated is null, never a fabricated NR', () => {
  // An invented rating is a claim about a film's content that nobody made.
  assertEquals(certificationOf({ results: [{ iso_3166_1: 'US', release_dates: [{ certification: '' }] }] }), null);
  assertEquals(certificationOf({ results: [] }), null);
  assertEquals(certificationOf(undefined), null);
});

Deno.test('a series is rated once per country, so it is a lookup rather than a walk', () => {
  const value = ratingOf({
    results: [
      { iso_3166_1: 'AU', rating: 'MA15+' },
      { iso_3166_1: 'US', rating: 'TV-MA' },
    ],
  });

  assertEquals(value, 'TV-MA');
});

Deno.test('a series with an empty US rating is null', () => {
  assertEquals(ratingOf({ results: [{ iso_3166_1: 'US', rating: '' }] }), null);
  assertEquals(ratingOf(undefined), null);
});

Deno.test('a detail row carries the certification and a search row carries none', () => {
  // The asymmetry is load-bearing: the upsert coalesces, so a search running after a
  // detail call must not blank what the detail wrote.
  const movie = fromMovieDetail({
    id: 1,
    title: 'Rated',
    release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'R' }] }] },
  });
  assertEquals(movie.certification, 'R');

  const searched = fromSearchResult({ id: 1, media_type: 'movie', title: 'Rated' }, GENRES);
  assertEquals(searched?.certification, null);
});

// ---------------------------------------------------------------------------
// episode_count (20260820000400)
//
// The founder's feed subheading counts a season in episodes and never in minutes,
// and the number has to come from somewhere. These pin *which* somewhere, because
// the two write paths read it from two different shapes and only one of them is
// obvious.
// ---------------------------------------------------------------------------

Deno.test('a season list carries the count TMDB publishes on it', () => {
  const [first, second] = seasonsOf({
    id: 1,
    name: 'Severance',
    seasons: [
      { id: 10, season_number: 1, name: 'Season 1', episode_count: 9 },
      { id: 11, season_number: 2, name: 'Season 2', episode_count: 10 },
    ],
  });

  assertEquals(first.episode_count, 9);
  assertEquals(second.episode_count, 10);
});

Deno.test('a season detail counts its own episodes, since the route sends no total', () => {
  // Without this, every season enriched through /tv/{id}/season/{n} — which is what
  // `enrichOne` does for a season anchor — would never acquire a count at all.
  const row = fromSeasonDetail({
    id: 11,
    season_number: 2,
    name: 'Season 2',
    episodes: [{}, {}, {}, {}, {}, {}, {}, {}],
  });

  assertEquals(row.episode_count, 8);
});

Deno.test('an unaired season is null rather than zero', () => {
  // Zero is not an absence of data, and "0 episodes" in a metadata line reads as a
  // fact about the show. The SQL coalesces on null, so this also stops an announced
  // season from blanking a count a later enrichment supplies.
  assertEquals(seasonsOf({ id: 1, name: 'X', seasons: [{ id: 2, season_number: 3, episode_count: 0 }] })[0].episode_count, null);
  assertEquals(seasonsOf({ id: 1, name: 'X', seasons: [{ id: 2, season_number: 3 }] })[0].episode_count, null);
  assertEquals(fromSeasonDetail({ id: 2, season_number: 3 }).episode_count, null);
  assertEquals(fromSeasonDetail({ id: 2, season_number: 3, episodes: [] }).episode_count, null);
});

// ---------------------------------------------------------------------------
// episodesOf — the Episodes tab's metadata
//
// This is the one provider array whose elements reach a screen without passing
// through Postgres on the way, so most of what follows is about what happens when
// the provider sends something other than the documented shape. Nothing here is
// stored: these objects are rendered and dropped.
// ---------------------------------------------------------------------------

/** The shape TMDB documents, with every field populated. */
const FULL_EPISODE = {
  episode_number: 9,
  name: 'The Rains of Castamere',
  air_date: '2013-06-02',
  runtime: 51,
  still_path: '/still9.jpg',
  overview: 'Robb presents himself to Walder Frey.',
};

Deno.test('an ordinary episode keeps the six fields the row renders', () => {
  const [episode] = episodesOf({ episodes: [FULL_EPISODE] });

  assertEquals(episode, {
    episode_number: 9,
    title: 'The Rains of Castamere',
    air_date: '2013-06-02',
    runtime_minutes: 51,
    still_path: '/still9.jpg',
    overview: 'Robb presents himself to Walder Frey.',
  });
});

Deno.test('nothing outside those six fields survives normalization', () => {
  // TMDB sends roughly twenty fields per episode. The type declares six, and this
  // pins that the rest are dropped rather than spread through to the client, which
  // is what keeps the response bounded and the provider payload out of the app.
  const [episode] = episodesOf({
    episodes: [
      {
        ...FULL_EPISODE,
        vote_average: 9.2,
        vote_count: 4310,
        production_code: 'GOT309',
        crew: [{ id: 1, name: 'David Nutter', job: 'Director' }],
        guest_stars: [{ id: 2, name: 'Michelle Fairley' }],
        show_id: 1399,
        id: 63067,
      },
    ],
  });

  assertEquals(Object.keys(episode).sort(), [
    'air_date',
    'episode_number',
    'overview',
    'runtime_minutes',
    'still_path',
    'title',
  ]);
});

Deno.test('a missing title is null rather than a fabricated one', () => {
  // The row falls back to "Episode 4" on the client. Inventing a name here would put
  // a title in the payload that TMDB never published.
  assertEquals(episodesOf({ episodes: [{ episode_number: 4 }] })[0].title, null);
  assertEquals(episodesOf({ episodes: [{ episode_number: 4, name: '' }] })[0].title, null);
  assertEquals(episodesOf({ episodes: [{ episode_number: 4, name: '   ' }] })[0].title, null);
});

Deno.test('a missing still is null, so the row draws no image at all', () => {
  assertEquals(episodesOf({ episodes: [{ episode_number: 1 }] })[0].still_path, null);
  assertEquals(
    episodesOf({ episodes: [{ episode_number: 1, still_path: null }] })[0].still_path,
    null,
  );
});

Deno.test('a missing overview is null and an empty one is not a synopsis', () => {
  assertEquals(episodesOf({ episodes: [{ episode_number: 1 }] })[0].overview, null);
  assertEquals(episodesOf({ episodes: [{ episode_number: 1, overview: '' }] })[0].overview, null);
});

Deno.test('a runtime TMDB does not have is null, and zero is not a runtime', () => {
  // Zero is the provider's placeholder for an episode it has no length for, and
  // "0 min" on a metadata line reads as a fact about the episode.
  assertEquals(episodesOf({ episodes: [{ episode_number: 1 }] })[0].runtime_minutes, null);
  assertEquals(
    episodesOf({ episodes: [{ episode_number: 1, runtime: 0 }] })[0].runtime_minutes,
    null,
  );
  assertEquals(
    episodesOf({ episodes: [{ episode_number: 1, runtime: null }] })[0].runtime_minutes,
    null,
  );
});

Deno.test('an air date TMDB does not have is null, because an empty string is not a date', () => {
  assertEquals(episodesOf({ episodes: [{ episode_number: 1 }] })[0].air_date, null);
  assertEquals(episodesOf({ episodes: [{ episode_number: 1, air_date: '' }] })[0].air_date, null);
  assertEquals(episodesOf({ episodes: [{ episode_number: 1, air_date: null }] })[0].air_date, null);
});

Deno.test('a future episode is kept, with the date TMDB published', () => {
  // The founder's decision: an unaired episode is shown, dated. Removing it would
  // make the list disagree with the season's own episode_count, which counts what
  // the provider publishes rather than what has aired.
  const [episode] = episodesOf({
    episodes: [{ episode_number: 8, name: 'Finale', air_date: '2099-01-01' }],
  });

  assertEquals(episode.air_date, '2099-01-01');
  assertEquals(episode.runtime_minutes, null);
  assertEquals(episode.still_path, null);
});

Deno.test('an episode with no number is dropped, since nothing identifies it', () => {
  const episodes = episodesOf({
    episodes: [
      { episode_number: 1, name: 'Real' },
      { name: 'Numberless' },
      { episode_number: null, name: 'Explicitly null' },
      { episode_number: 'two', name: 'A string' },
      { episode_number: Number.NaN, name: 'Not a number' },
      { episode_number: 2, name: 'Also real' },
    ],
  });

  assertEquals(
    episodes.map((episode) => episode.title),
    ['Real', 'Also real'],
  );
});

Deno.test('episode zero is kept, because Specials genuinely number from zero', () => {
  // `countOrNull` would refuse this. It is often the one episode a reader is least
  // sure about, so it gets its own non-negative check.
  const [episode] = episodesOf({ episodes: [{ episode_number: 0, name: 'Prologue' }] });

  assertEquals(episode.episode_number, 0);
  assertEquals(episode.title, 'Prologue');
});

Deno.test('a malformed entry is skipped rather than spread', () => {
  const episodes = episodesOf({
    episodes: [null, undefined, 'Episode 1', 42, true, [], { episode_number: 3, name: 'Real' }],
  });

  assertEquals(episodes.length, 1);
  assertEquals(episodes[0].title, 'Real');
});

Deno.test('episodes that are not an array read as no episodes, never a throw', () => {
  // A screen showing "No episodes listed" is a recoverable answer. A 500 out of the
  // adapter is not, and it would take the whole season page's enrichment with it.
  assertEquals(episodesOf({}), []);
  assertEquals(episodesOf({ episodes: undefined }), []);
  assertEquals(episodesOf({ episodes: null }), []);
  assertEquals(episodesOf({ episodes: 'nope' }), []);
  assertEquals(episodesOf({ episodes: 12 }), []);
  assertEquals(episodesOf({ episodes: { 0: { episode_number: 1 } } }), []);
  assertEquals(episodesOf({ episodes: [] }), []);
});

Deno.test('a repeated or out-of-order number is the provider data and is kept', () => {
  // Deduplicating would lose a real episode to tidy up a display key, and re-sorting
  // would move rows out of the broadcast order a reader scans. The client keys on
  // position for exactly this reason.
  const episodes = episodesOf({
    episodes: [
      { episode_number: 1, name: 'One' },
      { episode_number: 1, name: 'One again' },
      { episode_number: 5, name: 'Five' },
      { episode_number: 3, name: 'Three' },
    ],
  });

  assertEquals(
    episodes.map((episode) => episode.episode_number),
    [1, 1, 5, 3],
  );
  assertEquals(
    episodes.map((episode) => episode.title),
    ['One', 'One again', 'Five', 'Three'],
  );
});

Deno.test('a very long season is capped, and the cap takes the first episodes', () => {
  const raw = Array.from({ length: MAX_EPISODES + 60 }, (_, index) => ({
    episode_number: index + 1,
    name: `Episode ${index + 1}`,
  }));

  const episodes = episodesOf({ episodes: raw });

  assertEquals(episodes.length, MAX_EPISODES);
  assertEquals(episodes[0].episode_number, 1);
  assertEquals(episodes[MAX_EPISODES - 1].episode_number, MAX_EPISODES);
});

Deno.test('the cap bounds the response without shortening the season', () => {
  // episode_count is counted off the raw array, so a 260-episode season still
  // reports 260 while the payload carries 200. The cap is a rendering bound, never a
  // claim about the show.
  const raw = Array.from({ length: 260 }, (_, index) => ({ episode_number: index + 1 }));

  assertEquals(episodesOf({ episodes: raw }).length, MAX_EPISODES);
  assertEquals(fromSeasonDetail({ id: 1, season_number: 1, episodes: raw }).episode_count, 260);
});

Deno.test('the cap counts kept episodes, not scanned ones', () => {
  // A season whose first entries are malformed must still yield MAX_EPISODES real
  // ones. Breaking on the loop index rather than on the output length would return a
  // short list for a long season.
  const raw = [
    ...Array.from({ length: 20 }, () => null),
    ...Array.from({ length: MAX_EPISODES + 5 }, (_, index) => ({ episode_number: index + 1 })),
  ];

  assertEquals(episodesOf({ episodes: raw }).length, MAX_EPISODES);
});

Deno.test('a season detail carries episodes and a movie detail has no such field', () => {
  // Only the season route returns episodes. The movie normalizer produces a
  // catalogue row with no episode field at all, which is part of what stops an
  // episode ever becoming a media_items concept.
  const season = fromSeasonDetail({ id: 1, season_number: 2, episodes: [FULL_EPISODE] });
  assertEquals(season.episode_count, 1);
  assertEquals(episodesOf({ episodes: [FULL_EPISODE] }).length, 1);

  const movie = fromMovieDetail({ id: 2, title: 'Heat', runtime: 170 });
  assert(!('episodes' in movie));
  assert(!('episode_count' in movie));
});

Deno.test('a series detail returns its season list and never a season’s episodes', () => {
  // /tv/{id} carries `seasons` with per-season counts and no episode objects. A
  // series grouping page must not acquire an episode list by accident.
  const series = fromSeriesDetail({
    id: 1399,
    name: 'Game of Thrones',
    seasons: [{ id: 3624, season_number: 1, name: 'Season 1', episode_count: 10 }],
  });

  assert(!('episodes' in series));

  // Even handed the series payload, the episode normalizer finds nothing: `seasons`
  // is not `episodes`, and it does not go looking.
  assertEquals(
    episodesOf({
      seasons: [{ id: 3624, season_number: 1, episode_count: 10 }],
    } as { episodes?: unknown }),
    [],
  );
});

// ---------------------------------------------------------------------------
// seasonTarget — which season the adapter is allowed to ask about
//
// The security-relevant half of the `season-episodes` action. Both numbers in
// `/tv/{series}/season/{n}` come out of media_items; a caller supplies one Bingd
// uuid and no part of the outbound URL. These tests are what make that checkable
// rather than something a reviewer has to take on trust.
// ---------------------------------------------------------------------------

const SEASON_ROW = { kind: 'season', parent_id: 'series-uuid', season_number: 2 };
const SERIES_ROW = { kind: 'series', tmdb_id: 1399 };

Deno.test('a season resolves to its parent series id and its own number', () => {
  assertEquals(seasonTarget(SEASON_ROW, SERIES_ROW), {
    ok: true,
    seriesTmdbId: 1399,
    seasonNumber: 2,
  });
});

Deno.test('Specials resolves, because season zero is a real season', () => {
  assertEquals(seasonTarget({ ...SEASON_ROW, season_number: 0 }, SERIES_ROW), {
    ok: true,
    seriesTmdbId: 1399,
    seasonNumber: 0,
  });
});

Deno.test('a film and a series grouping are refused rather than answered empty', () => {
  // Distinct from an empty list, which is what a season with no published episodes
  // looks like. The two must not produce the same reply.
  assertEquals(seasonTarget({ kind: 'movie', parent_id: null, season_number: null }, null), {
    ok: false,
    reason: 'not_a_season',
  });
  assertEquals(seasonTarget({ kind: 'series', parent_id: null, season_number: null }, null), {
    ok: false,
    reason: 'not_a_season',
  });
});

Deno.test('a season missing its parent or its number is refused', () => {
  assertEquals(seasonTarget({ ...SEASON_ROW, parent_id: null }, SERIES_ROW), {
    ok: false,
    reason: 'malformed_season',
  });
  assertEquals(seasonTarget({ ...SEASON_ROW, season_number: null }, SERIES_ROW), {
    ok: false,
    reason: 'malformed_season',
  });
});

Deno.test('a parent that is not a series is refused before any /tv request', () => {
  // parent_id is `not null` by constraint and is not constrained to *be* a series.
  // Without this the adapter would ask TMDB a /tv question about a film's id.
  assertEquals(seasonTarget(SEASON_ROW, { kind: 'movie', tmdb_id: 550 }), {
    ok: false,
    reason: 'malformed_season',
  });
  assertEquals(seasonTarget(SEASON_ROW, { kind: 'season', tmdb_id: 3624 }), {
    ok: false,
    reason: 'malformed_season',
  });
  assertEquals(seasonTarget(SEASON_ROW, null), { ok: false, reason: 'malformed_season' });
});

Deno.test('a series the provider has no record of is refused, not guessed at', () => {
  // The Wikidata seed before enrichment reaches it. Distinct from malformed, because
  // this row becomes answerable the moment the series is enriched.
  assertEquals(seasonTarget(SEASON_ROW, { kind: 'series', tmdb_id: null }), {
    ok: false,
    reason: 'no_tmdb_id',
  });
});

Deno.test('every field of the target comes from a catalogue row and nowhere else', () => {
  // The guarantee stated as a test: seasonTarget takes two catalogue rows and
  // nothing else, so there is no argument a caller could supply that reaches the URL.
  const target = seasonTarget(
    { kind: 'season', parent_id: 'p', season_number: 7 },
    { kind: 'series', tmdb_id: 4242 },
  );

  assert(target.ok);
  assertEquals(target.seriesTmdbId, 4242);
  assertEquals(target.seasonNumber, 7);
});

// ---------------------------------------------------------------------------
// Where to watch
//
// The third provider array that reaches a screen without being written to Postgres
// first, after episodes and the person payload, and the only one whose terms name a
// third party. Every assertion below is about a shape TMDB really sends: a service
// under two categories at once, a country bucket that exists with nothing in it, a
// market the response has never heard of.
// ---------------------------------------------------------------------------

/** Two markets, and one service in the first that is offered three different ways. */
const PROVIDERS = {
  results: {
    US: {
      link: 'https://www.themoviedb.org/movie/27205/watch?locale=US',
      flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/netflix.jpg' }],
      rent: [{ provider_id: 2, provider_name: 'Apple TV', logo_path: '/apple.jpg' }],
      buy: [
        { provider_id: 2, provider_name: 'Apple TV', logo_path: '/apple.jpg' },
        { provider_id: 10, provider_name: 'Amazon Video', logo_path: '/amazon.jpg' },
      ],
    },
    GB: {
      link: 'https://www.themoviedb.org/movie/27205/watch?locale=GB',
      flatrate: [{ provider_id: 39, provider_name: 'Now TV', logo_path: '/now.jpg' }],
    },
  },
};

Deno.test('reads exactly one country out of a response that carries every country', () => {
  const us = watchAvailability(PROVIDERS, 'US');
  const gb = watchAvailability(PROVIDERS, 'GB');

  assertEquals(us.region, 'US');
  assertEquals(
    us.providers.map((p) => p.name),
    ['Netflix', 'Apple TV', 'Amazon Video'],
  );
  assertEquals(
    gb.providers.map((p) => p.name),
    ['Now TV'],
  );
  // The link belongs to the market too. Serving the US page to a reader in Britain
  // would send them to a list of services they cannot subscribe to.
  assert(gb.link?.endsWith('locale=GB'));
});

Deno.test('a service offered two ways is one entry carrying both', () => {
  // Apple TV under rent *and* buy is TMDB's ordinary shape rather than an anomaly.
  // Two rows with the same logo and the same name reads as a rendering fault.
  const { providers } = watchAvailability(PROVIDERS, 'US');
  const apple = providers.find((p) => p.provider_id === 2);

  assertEquals(apple?.offers, ['rent', 'buy']);
  assertEquals(providers.filter((p) => p.provider_id === 2).length, 1);
});

Deno.test('the three offers keep their own categories rather than being flattened', () => {
  const { providers } = watchAvailability(PROVIDERS, 'US');

  assertEquals(providers.find((p) => p.name === 'Netflix')?.offers, ['stream']);
  assertEquals(providers.find((p) => p.name === 'Amazon Video')?.offers, ['buy']);
});

Deno.test('provider order is the provider list order, within stream then rent then buy', () => {
  // Each array arrives sorted by display_priority, which is that service's prominence
  // in that market and a better first-three than anything derivable here. A service
  // first seen under rent keeps its place when it turns up again under buy.
  assertEquals(
    watchAvailability(PROVIDERS, 'US').providers.map((p) => p.provider_id),
    [8, 2, 10],
  );
});

Deno.test('a country the response does not name comes back empty rather than borrowing one', () => {
  const answer = watchAvailability(PROVIDERS, 'JP');

  assertEquals(answer.region, 'JP');
  assertEquals(answer.providers, []);
  assertEquals(answer.link, null);
});

Deno.test('a bucket that exists with nothing in it carries no watch-options link', () => {
  // TMDB sends the link on any bucket it has, including one whose offer arrays are
  // all empty. A page saying "not available anywhere" is not a watch option, and
  // offering it as one would be a row that leads nowhere.
  const answer = watchAvailability(
    { results: { US: { link: 'https://www.themoviedb.org/movie/1/watch?locale=US' } } },
    'US',
  );

  assertEquals(answer.providers, []);
  assertEquals(answer.link, null);
});

Deno.test('free and ad-supported offers are deliberately not read', () => {
  // Three categories, three headings. Folding Tubi in under Stream would say the same
  // thing about it as about Netflix, and inventing a fourth heading is not this
  // change's decision to make. Stated here so it is not read later as a bug: a title
  // carried only by a free or ad-supported service shows no block at all.
  const answer = watchAvailability(
    {
      results: {
        US: {
          link: 'https://example.invalid',
          free: [{ provider_id: 73, provider_name: 'Tubi', logo_path: '/tubi.jpg' }],
          ads: [{ provider_id: 300, provider_name: 'Pluto TV', logo_path: '/pluto.jpg' }],
        },
      },
    },
    'US',
  );

  assertEquals(answer.providers, []);
});

Deno.test('an entry that cannot say who it is is dropped rather than drawn blank', () => {
  const answer = watchAvailability(
    {
      results: {
        US: {
          flatrate: [
            null,
            'Netflix',
            { provider_name: 'No id' },
            { provider_id: 8 },
            { provider_id: 1.5, provider_name: 'Fractional' },
            { provider_id: 9, provider_name: '   ' },
            { provider_id: 337, provider_name: 'Disney Plus', logo_path: '' },
          ],
        },
      },
    },
    'US',
  );

  // Only the last survives, and its empty logo path becomes a null the row renders
  // around rather than an image URL ending in nothing.
  assertEquals(answer.providers.length, 1);
  assertEquals(answer.providers[0].name, 'Disney Plus');
  assertEquals(answer.providers[0].logo_path, null);
});

Deno.test('one country cannot return an unbounded list', () => {
  const many = Array.from({ length: MAX_WATCH_PROVIDERS + 15 }, (_, i) => ({
    provider_id: i + 1,
    provider_name: `Service ${i + 1}`,
    logo_path: `/${i}.jpg`,
  }));

  const answer = watchAvailability({ results: { US: { flatrate: many } } }, 'US');
  assertEquals(answer.providers.length, MAX_WATCH_PROVIDERS);
});

Deno.test('the cap counts services rather than offers', () => {
  // A service offered all three ways costs one of the forty, because the cap is
  // applied after deduplication. Otherwise a market with twenty services that each
  // rent and sell would be truncated at half its real length.
  const both = Array.from({ length: MAX_WATCH_PROVIDERS }, (_, i) => ({
    provider_id: i + 1,
    provider_name: `Service ${i + 1}`,
    logo_path: null,
  }));

  const answer = watchAvailability({ results: { US: { rent: both, buy: both } } }, 'US');
  assertEquals(answer.providers.length, MAX_WATCH_PROVIDERS);
  assertEquals(answer.providers[0].offers, ['rent', 'buy']);
});

Deno.test('a missing, malformed or absent response is an empty answer and never a throw', () => {
  // Availability is the one block on the title page allowed to fail without the page
  // failing with it, so every shape short of the expected one has to have an answer.
  for (const payload of [null, undefined, {}, { results: undefined }, { results: { US: null } }]) {
    const answer = watchAvailability(payload as never, 'US');
    assertEquals(answer.providers, []);
    assertEquals(answer.link, null);
  }
});

Deno.test('the region is a country code or the US default, and never reaches a URL', () => {
  // The one caller-supplied value in the request. It is used as an object key rather
  // than as part of the route, which is built from media_items alone, so this is
  // about answering a sensible question rather than about escaping. Anything that is
  // not two letters falls back, because a phone reporting a region TMDB has never
  // heard of should see the US list rather than an error on a title page.
  assertEquals(watchRegionOf('gb'), 'GB');
  assertEquals(watchRegionOf(' de '), 'DE');
  assertEquals(watchRegionOf(undefined), 'US');
  assertEquals(watchRegionOf(''), 'US');
  assertEquals(watchRegionOf('USA'), 'US');
  assertEquals(watchRegionOf('en-US'), 'US');
  assertEquals(watchRegionOf(42), 'US');
  assertEquals(watchRegionOf('../secrets'), 'US');
});

Deno.test('a watch-options link that is not TMDB over https is not offered at all', () => {
  // Checked rather than escaped, for the reason videoUri states on the client: this
  // string is handed to Linking.openURL on a phone. The shape is provider-owned and
  // has never varied, so a link that is not TMDB over https is not the page the row
  // claims to open, and not offering the row beats opening somewhere unexpected.
  const withLink = (link: unknown) =>
    watchAvailability(
      {
        results: {
          US: {
            link,
            flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/n.jpg' }],
          },
        },
      },
      'US',
    );

  assertEquals(withLink('https://www.themoviedb.org/movie/27205/watch?locale=US').link,
    'https://www.themoviedb.org/movie/27205/watch?locale=US');
  assertEquals(withLink('https://themoviedb.org/movie/27205/watch').link,
    'https://themoviedb.org/movie/27205/watch');

  for (const bad of [
    'http://www.themoviedb.org/movie/1/watch',
    'https://themoviedb.org.evil.example/movie/1',
    'https://evil.example/?x=www.themoviedb.org',
    'javascript:alert(1)',
    'not a url',
    '',
    null,
    42,
  ]) {
    assertEquals(withLink(bad).link, null, `refused: ${String(bad)}`);
    // And the providers survive the refusal — the list is the block, the link is an
    // extra, so losing one must not lose the other.
    assertEquals(withLink(bad).providers.length, 1);
  }
});
