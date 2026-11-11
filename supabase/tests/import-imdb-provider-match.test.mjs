import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  catalogueSeries,
  decideFind,
  identityAgrees,
  imdbKind,
  imdbTitleType,
  needsWindowTv,
  pickTv,
} from '../functions/letterboxd-import/match.mjs';

/**
 * The IMDb half of the provider tier's decision rule (20261111000100):
 * `supabase/functions/letterboxd-import/match.mjs`, from `imdbTitleType` down.
 *
 * TMDB answers below are the documented `/find` shape (movie_results, tv_results,
 * tv_episode_results, tv_season_results, person_results), cut to the fields read.
 */

const claim = (over = {}) => ({
  row_id: 'r1',
  name: 'Heat',
  year: 1995,
  imdb_id: 'tt0113277',
  title_type: 'movie',
  original_title: null,
  ...over,
});

const film = (over = {}) => ({
  id: 949,
  title: 'Heat',
  original_title: 'Heat',
  release_date: '1995-12-15',
  ...over,
});
const show = (over = {}) => ({
  id: 1396,
  name: 'Breaking Bad',
  original_name: 'Breaking Bad',
  first_air_date: '2008-01-20',
  ...over,
});
const found = (over = {}) => ({
  movie_results: [],
  person_results: [],
  tv_results: [],
  tv_episode_results: [],
  tv_season_results: [],
  ...over,
});

describe('reading an IMDb type', () => {
  it('folds both spellings IMDb has used', () => {
    assert.equal(imdbTitleType('TV Mini Series'), 'tvminiseries');
    assert.equal(imdbTitleType('tvMiniSeries'), 'tvminiseries');
    assert.equal(imdbTitleType('Movie'), 'movie');
    assert.equal(imdbTitleType('TV Episode'), 'tvepisode');
  });

  it('calls anything unknown other, and other places nothing', () => {
    assert.equal(imdbTitleType('Hologram'), 'other');
    assert.equal(imdbTitleType(undefined), 'other');
    assert.equal(imdbKind('other'), null);
  });

  it('maps every type the founder sample holds to a destination, or to none', () => {
    const expected = {
      Movie: 'movie',
      'TV Movie': 'movie',
      Video: 'movie',
      Short: 'movie',
      'TV Special': 'movie',
      'TV Short': 'movie',
      'TV Series': 'series',
      'TV Mini Series': 'series',
      'TV Episode': null,
      'Video Game': null,
      'Music Video': null,
      'Podcast Series': null,
    };
    for (const [type, kind] of Object.entries(expected)) {
      assert.equal(imdbKind(imdbTitleType(type)), kind, type);
    }
  });
});

describe('identity', () => {
  it('agrees on title and year', () => {
    assert.equal(identityAgrees(claim(), film()), true);
  });

  it('agrees through the original title when the export used a localised one', () => {
    assert.equal(
      identityAgrees(
        claim({
          name: 'Das Leben der Anderen',
          original_title: 'Das Leben der Anderen',
          year: 2006,
        }),
        film({
          title: 'The Lives of Others',
          original_title: 'Das Leben der Anderen',
          release_date: '2006-03-23',
        }),
      ),
      true,
    );
  });

  it('refuses a wrong year (more than one out)', () => {
    assert.equal(identityAgrees(claim({ year: 1986 }), film()), false);
  });

  it('allows the one-year territory gap', () => {
    assert.equal(identityAgrees(claim({ year: 1996 }), film()), true);
  });

  it('refuses a different title', () => {
    assert.equal(identityAgrees(claim({ name: 'Cats' }), film()), false);
  });

  it('refuses a missing title', () => {
    assert.equal(identityAgrees(claim({ name: '' }), film()), false);
  });
});

describe('a /find answer', () => {
  it('places the one movie the id names', () => {
    const decision = decideFind(claim(), found({ movie_results: [film()] }));
    assert.equal(decision.outcome, 'match');
    assert.equal(decision.kind, 'movie');
    assert.equal(decision.result.id, 949);
  });

  it('places the one series the id names, for a TV Series row', () => {
    const decision = decideFind(
      claim({ name: 'Breaking Bad', year: 2008, title_type: 'TV Series' }),
      found({ tv_results: [show()] }),
    );
    assert.equal(decision.outcome, 'match');
    assert.equal(decision.kind, 'series');
    assert.equal(decision.result.id, 1396);
  });

  it('places a mini-series on the canonical show', () => {
    const decision = decideFind(
      claim({ name: 'Chernobyl', year: 2019, title_type: 'TV Mini Series' }),
      found({
        tv_results: [
          show({
            id: 87108,
            name: 'Chernobyl',
            original_name: 'Chernobyl',
            first_air_date: '2019-05-06',
          }),
        ],
      }),
    );
    assert.equal(decision.outcome, 'match');
    assert.equal(decision.kind, 'series');
  });

  it('places a TV Movie on a movie, which is where TMDB files it', () => {
    const decision = decideFind(
      claim({ name: 'El Camino', year: 2019, title_type: 'TV Movie' }),
      found({
        movie_results: [
          film({
            id: 559969,
            title: 'El Camino',
            original_title: 'El Camino',
            release_date: '2019-10-11',
          }),
        ],
      }),
    );
    assert.equal(decision.outcome, 'match');
    assert.equal(decision.kind, 'movie');
  });

  it('never reclassifies: a Movie row whose id names a series is a conflict', () => {
    assert.equal(
      decideFind(claim(), found({ tv_results: [show({ name: 'Heat' })] })).outcome,
      'conflict',
    );
  });

  it('never reclassifies: a TV Series row whose id names a movie is a conflict', () => {
    assert.equal(
      decideFind(claim({ title_type: 'TV Series' }), found({ movie_results: [film()] }))
        .outcome,
      'conflict',
    );
  });

  it('reports an id that names an episode as unsupported', () => {
    assert.equal(
      decideFind(
        claim({ title_type: 'Movie' }),
        found({ tv_episode_results: [{ id: 62085, name: 'Pilot' }] }),
      ).outcome,
      'unsupported',
    );
  });

  it('reports an episode row as unsupported without reading the answer', () => {
    assert.equal(
      decideFind(claim({ title_type: 'TV Episode' }), found({ movie_results: [film()] }))
        .outcome,
      'unsupported',
    );
  });

  it('refuses a hit that disagrees with the row (conflicting ids)', () => {
    assert.equal(
      decideFind(
        claim({ name: 'Heat', year: 1995 }),
        found({
          movie_results: [
            film({ title: 'Cats', original_title: 'Cats', release_date: '2019-12-20' }),
          ],
        }),
      ).outcome,
      'conflict',
    );
  });

  it('leaves two results of the expected kind ambiguous', () => {
    assert.equal(
      decideFind(claim(), found({ movie_results: [film(), film({ id: 950 })] })).outcome,
      'ambiguous',
    );
  });

  it('says none when TMDB knows nothing about the id, so a title search may run', () => {
    assert.equal(decideFind(claim(), found()).outcome, 'none');
    assert.equal(decideFind(claim(), null).outcome, 'none');
  });
});

describe('the TV title search', () => {
  const tvClaim = { row_id: 'r', name: 'The Office', year: 2005 };

  it('picks the one show in the exact year over a namesake', () => {
    const us = show({
      id: 2316,
      name: 'The Office',
      original_name: 'The Office',
      first_air_date: '2005-03-24',
    });
    const uk = show({
      id: 2996,
      name: 'The Office',
      original_name: 'The Office',
      first_air_date: '2001-07-09',
    });
    assert.equal(pickTv(tvClaim, [uk, us])?.id, 2316);
  });

  it('never chooses by popularity: two shows in the year stay unresolved', () => {
    const a = show({
      id: 1,
      name: 'The Office',
      original_name: 'The Office',
      first_air_date: '2005-03-24',
      popularity: 900,
    });
    const b = show({
      id: 2,
      name: 'The Office',
      original_name: 'The Office',
      first_air_date: '2005-09-01',
      popularity: 1,
    });
    assert.equal(pickTv(tvClaim, [a, b]), null);
  });

  it('asks the neighbouring years when the exact year has nothing', () => {
    assert.equal(needsWindowTv(tvClaim, []), true);
  });

  it('writes the show, never a season, to the catalogue', () => {
    const item = catalogueSeries(show());
    assert.equal(item.kind, 'series');
    assert.equal(item.title, 'Breaking Bad');
    assert.equal(item.release_date, '2008-01-20');
    assert.equal('season_number' in item, false);
  });
});
