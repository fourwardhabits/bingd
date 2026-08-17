/**
 * The two normalizers Phase E added, and the one existing one they lean on.
 *
 * `reviewsFacet` and `personCredits` are pure functions of a provider payload, and
 * both do something a reader of the calling code cannot verify by eye: one truncates
 * and flags, the other deduplicates and re-ranks a list that arrives with duplicates
 * in it by design. The deduplication in particular is a correctness requirement
 * rather than tidiness — a repeated title makes `tmdb_upsert_titles` fail outright
 * with "ON CONFLICT DO UPDATE command cannot affect row a second time" — and that is
 * a failure the client would see as a person with no credits at all.
 *
 * Run with `npm run functions:test`.
 */

import { assert, assertEquals } from '@std/assert';

import {
  certificationOf,
  fromMovieDetail,
  fromSearchResult,
  personCredits,
  personRecord,
  ratingOf,
  reviewsFacet,
} from './normalize.ts';
import type { TmdbPersonDetail } from './tmdb.ts';

const GENRES = new Map<number, string>([
  [28, 'Action'],
  [18, 'Drama'],
]);

// ---------------------------------------------------------------------------
// reviewsFacet
// ---------------------------------------------------------------------------

Deno.test('a review keeps its author, rating and body', () => {
  const { results, total } = reviewsFacet({
    results: [
      {
        id: 'r1',
        author: 'wandering_cinephile',
        author_details: { rating: 8, avatar_path: '/a.jpg' },
        content: 'Rewards a second viewing.',
        created_at: '2011-02-04T12:00:00.000Z',
        url: 'https://www.themoviedb.org/review/r1',
      },
    ],
    total_results: 1,
  });

  assertEquals(results.length, 1);
  assertEquals(results[0].author, 'wandering_cinephile');
  assertEquals(results[0].rating, 8);
  assertEquals(results[0].content, 'Rewards a second viewing.');
  assertEquals(results[0].truncated, false);
  assertEquals(total, 1);
});

Deno.test('a review with no rating keeps none rather than being given one', () => {
  // A review with no rating and a review rated zero are different things, and
  // deriving a number for the first would be inventing an opinion.
  const { results } = reviewsFacet({
    results: [{ id: 'r1', author: 'someone', content: 'No stars from me.' }],
  });

  assertEquals(results[0].rating, null);
});

Deno.test('a long review is truncated, and says so', () => {
  const { results } = reviewsFacet({
    results: [{ id: 'r1', author: 'someone', content: 'x'.repeat(5000) }],
  });

  assertEquals(results[0].content.length, 2000);
  assertEquals(results[0].truncated, true);
});

Deno.test('an empty review is dropped rather than rendered as a blank card', () => {
  const { results } = reviewsFacet({
    results: [
      { id: 'r1', author: 'someone', content: '   ' },
      { id: 'r2', author: 'someone else', content: 'Actual words.' },
    ],
  });

  assertEquals(results.length, 1);
  assertEquals(results[0].id, 'r2');
});

Deno.test('at most eight reviews are stored', () => {
  const { results, total } = reviewsFacet({
    results: Array.from({ length: 20 }, (_, index) => ({
      id: `r${index}`,
      author: 'someone',
      content: 'Words.',
    })),
    total_results: 137,
  });

  assertEquals(results.length, 8);
  // What TMDB actually had travels alongside, so nothing downstream mistakes eight
  // for the whole count.
  assertEquals(total, 137);
});

Deno.test('a Gravatar avatar path is unwrapped rather than pasted onto the CDN base', () => {
  // TMDB sends `/https://secure.gravatar.com/avatar/…` — a leading slash in front of
  // an absolute URL. Left alone it 404s for a large fraction of authors.
  const { results } = reviewsFacet({
    results: [
      {
        id: 'r1',
        author: 'someone',
        author_details: { avatar_path: '/https://secure.gravatar.com/avatar/abc' },
        content: 'Words.',
      },
    ],
  });

  assertEquals(results[0].avatar_path, 'https://secure.gravatar.com/avatar/abc');
});

Deno.test('a TMDB avatar path stays a path', () => {
  const { results } = reviewsFacet({
    results: [
      {
        id: 'r1',
        author: 'someone',
        author_details: { avatar_path: '/portrait.jpg' },
        content: 'Words.',
      },
    ],
  });

  assertEquals(results[0].avatar_path, '/portrait.jpg');
});

Deno.test('an author with no display name falls back to their handle', () => {
  const { results } = reviewsFacet({
    results: [
      {
        id: 'r1',
        author: '',
        author_details: { username: 'handle_only' },
        content: 'Words.',
      },
    ],
  });

  assertEquals(results[0].author, 'handle_only');
});

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

Deno.test('at most forty credits are kept, and the total says how many there were', () => {
  const { credits, total } = personCredits(
    person({
      cast: Array.from({ length: 300 }, (_, index) =>
        credit(index + 1, { popularity: index, character: 'Someone' }),
      ),
    }),
    GENRES,
  );

  assertEquals(credits.length, 40);
  assertEquals(total, 300);
  // The forty kept are the forty most popular, not the first forty TMDB sent.
  assertEquals(credits[0].row.tmdb_id, 300);
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
