/**
 * The release observations `release_observe` receives (20260930000100).
 *
 * Pure functions of a TMDB payload. The SQL decides everything; what these must get right
 * is that nothing it needs is dropped and nothing it must not trust is invented: the
 * earliest date per release type, type 3 kept apart from type 2, a TBD season kept as a
 * null rather than left out, and Season 0 left out.
 *
 * Fixtures are trimmed TMDB response shapes (`/movie/{id}?append_to_response=release_dates`
 * and `/tv/{id}`). Run with `npm run functions:test`.
 */

import { assertEquals } from '@std/assert';

import {
  movieReleaseObservation,
  regionalReleases,
  seriesReleaseObservation,
} from './normalize.ts';
import type { TmdbMovieDetail, TmdbSeriesDetail } from './tmdb.ts';

const READ_AT = '2031-05-16T08:00:00.000Z';

const film = (over: Partial<TmdbMovieDetail> = {}): TmdbMovieDetail => ({
  id: 1,
  title: 'Opening Night',
  release_date: '2031-02-10',
  status: 'Post Production',
  release_dates: {
    results: [
      {
        iso_3166_1: 'US',
        release_dates: [
          { type: 1, release_date: '2031-02-10T00:00:00.000Z', certification: '' },
          { type: 2, release_date: '2031-05-02T00:00:00.000Z', certification: 'R' },
          { type: 3, release_date: '2031-05-16T00:00:00.000Z', certification: 'R' },
          { type: 3, release_date: '2031-06-20T00:00:00.000Z', certification: 'R' },
          { type: 4, release_date: '2031-07-01T00:00:00.000Z', certification: '' },
          { type: 5, release_date: '2031-08-01T00:00:00.000Z', certification: '' },
        ],
      },
      {
        iso_3166_1: 'GB',
        release_dates: [{ type: 3, release_date: '2031-05-09T00:00:00.000Z' }],
      },
    ],
  },
  ...over,
});

Deno.test('a film keeps its US release events, earliest per type, and only the US', () => {
  const obs = movieReleaseObservation('m-1', film(), READ_AT);
  assertEquals(obs, {
    media_item_id: 'm-1',
    kind: 'movie',
    status: 'Post Production',
    primary_date: '2031-02-10',
    read_at: READ_AT,
    regions: [
      { region: 'US', premiere: '2031-02-10', limited: '2031-05-02', theatrical: '2031-05-16', digital: '2031-07-01' },
    ],
  });
});

Deno.test('a film with no US entry still says so: every date null, the region present', () => {
  const obs = movieReleaseObservation('m-2', film({ release_dates: { results: [] } }), READ_AT);
  assertEquals(obs.regions, [
    { region: 'US', premiere: null, limited: null, theatrical: null, digital: null },
  ]);
});

Deno.test('limited-only stays limited: type 2 never becomes theatrical', () => {
  const [us] = regionalReleases({
    results: [{ iso_3166_1: 'US', release_dates: [{ type: 2, release_date: '2031-05-16T00:00:00.000Z' }] }],
  });
  assertEquals(us.theatrical, null);
  assertEquals(us.limited, '2031-05-16');
});

Deno.test('malformed release entries are skipped, not guessed', () => {
  const [us] = regionalReleases({
    results: [
      {
        iso_3166_1: 'US',
        release_dates: [
          { type: 3, release_date: '' },
          { type: 3, release_date: 'soon' },
          { type: 99, release_date: '2031-01-01T00:00:00.000Z' },
          // deno-lint-ignore no-explicit-any
          null as any,
          { release_date: '2031-01-01T00:00:00.000Z' },
        ],
      },
    ],
  });
  assertEquals(us, { region: 'US', premiere: null, limited: null, theatrical: null, digital: null });
});

Deno.test('a canceled film says Canceled, and a missing status is null', () => {
  assertEquals(movieReleaseObservation('m-3', film({ status: 'Canceled' }), READ_AT).status, 'Canceled');
  assertEquals(movieReleaseObservation('m-4', film({ status: undefined }), READ_AT).status, null);
});

const show = (over: Partial<TmdbSeriesDetail> = {}): TmdbSeriesDetail => ({
  id: 2,
  name: 'Tiered',
  status: 'Returning Series',
  in_production: true,
  next_episode_to_air: { season_number: 3, episode_number: 1, air_date: '2031-05-16' },
  seasons: [
    { id: 10, season_number: 0, name: 'Specials', air_date: '2028-12-01' },
    { id: 11, season_number: 1, air_date: '2029-01-01' },
    { id: 12, season_number: 2, air_date: '2030-01-01' },
    { id: 13, season_number: 3, air_date: '2031-05-16' },
    { id: 14, season_number: 4, air_date: '' },
  ],
  ...over,
});

Deno.test('a series keeps every normal season date, a TBD season as null, and drops Specials', () => {
  assertEquals(seriesReleaseObservation('s-1', show(), READ_AT), {
    media_item_id: 's-1',
    kind: 'series',
    status: 'Returning Series',
    in_production: true,
    read_at: READ_AT,
    seasons: [
      { season_number: 1, air_date: '2029-01-01' },
      { season_number: 2, air_date: '2030-01-01' },
      { season_number: 3, air_date: '2031-05-16' },
      { season_number: 4, air_date: null },
    ],
    next_episode: { season_number: 3, episode_number: 1, air_date: '2031-05-16' },
  });
});

Deno.test('an ended series with nothing next, and a payload missing the new fields', () => {
  const ended = seriesReleaseObservation('s-2', show({ status: 'Ended', in_production: false, next_episode_to_air: null }), READ_AT);
  assertEquals([ended.status, ended.in_production, ended.next_episode], ['Ended', false, null]);

  const bare = seriesReleaseObservation('s-3', { id: 3, name: 'Old Payload' }, READ_AT);
  assertEquals(bare, {
    media_item_id: 's-3',
    kind: 'series',
    status: null,
    in_production: null,
    read_at: READ_AT,
    seasons: [],
    next_episode: null,
  });
});
