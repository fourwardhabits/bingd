import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decideFind,
  needsWindowOriginal,
  originalClaim,
  pick,
  pickOriginal,
  titleCorroboration,
  VERIFIED_YEAR_TOLERANCE,
  verifiedIdentityAgrees,
} from '../functions/letterboxd-import/match.mjs';

import {
  claim,
  film,
  findFor,
  found,
  show,
  VERIFIED_CASES,
  VERIFIED_TV_CASES,
} from './import-imdb-verified-cases.mjs';

/**
 * Founder QA, 2026-11-12 (spec §3, P0): IMDb rows whose right film was one tt id away ended
 * in "Couldn't match" (20261118000100).
 *
 * ROOT CAUSE, as the code read it: `decideFind` judged the single /find result for the
 * row's exact tt id with `identityAgrees`, which needs a squashed display title in common.
 * A regional title, a franchise prefix or subtitle, "&" for "and", or a show named
 * differently was therefore a `conflict`, and a conflict is final (`p_final: true`), so
 * the title search never ran either. `_import_provider_resolve` and Tier 1 applied the
 * same title rule in SQL.
 *
 * FIXTURES. TMDB 671 and 140607 are as staging (…rzyr) stores them (title, original title,
 * release date). TMDB 556574 (Hamilton) is reconstructed from public knowledge and was NOT
 * captured: this environment cannot reach TMDB, so the live /find for tt8503618 is left to
 * the coordinator's staging reimport (the batch answer now counts each branch). Every other
 * film below is a synthetic id (9000xx) with a public film's title shape; no import file,
 * user data or private title list is used.
 */

describe('a verified id outweighs a display title (the founder QA misses)', () => {
  for (const { label, row, hit } of VERIFIED_CASES) {
    it(`matches the one /find movie: ${label}`, () => {
      const decision = decideFind(row, found({ movie_results: [hit] }));
      assert.equal(decision.outcome, 'match');
      assert.equal(decision.kind, 'movie');
      assert.equal(decision.result.id, hit.id);
    });
  }

  for (const { label, row, hit } of VERIFIED_TV_CASES) {
    it(`matches the one /find show (reported as not added downstream): ${label}`, () => {
      const decision = decideFind(row, found({ tv_results: [hit] }));
      assert.equal(decision.outcome, 'match');
      assert.equal(decision.kind, 'series');
      assert.equal(decision.result.id, hit.id);
    });
  }

  it('records how the title corroborated it, as support and never as a veto', () => {
    for (const c of [...VERIFIED_CASES, ...VERIFIED_TV_CASES]) {
      const { corroboration } = decideFind(c.row, findFor(c));
      // Every founder class is a recognisable variant; none of them is squash-equal, which
      // is exactly why the old title rule refused them.
      assert.equal(corroboration, 'variant', c.label);
    }
  });

  it('matches a verified id whose title shares nothing, because the title never vetoes', () => {
    const decision = decideFind(
      claim({ name: 'Completely Different', year: 2010 }),
      found({ movie_results: [film(900010, 'Unrelated Display Name', '2010-04-01')] }),
    );
    assert.equal(decision.outcome, 'match');
    assert.equal(decision.corroboration, 'none');
  });
});

describe('tt8503618 Hamilton (2020): the control case', () => {
  const hamilton = claim({ name: 'Hamilton', year: 2020, imdb_id: 'tt8503618' });
  const hit = film(556574, 'Hamilton', '2020-07-03');

  it('a single movie /find hit with the same title and year matched before and after', () => {
    // Title strictness cannot explain Hamilton: this shape was already a match.
    const decision = decideFind(hamilton, found({ movie_results: [hit] }));
    assert.equal(decision.outcome, 'match');
    assert.equal(decision.corroboration, 'exact');
  });

  // The branches that could have settled it on its first provider pass, with no catalogue
  // write (staging: attempts = 1, not in media_items). Each stays a non-match on purpose.
  it('two movie results for the id stay ambiguous (duplicate TMDB titles, never guessed)', () => {
    const decision = decideFind(
      hamilton,
      found({ movie_results: [hit, film(900020, 'Hamilton', '2020-07-03')] }),
    );
    assert.equal(decision.outcome, 'ambiguous');
  });

  it('a /find answer only under tv_results is the other kind: conflict, never reclassified', () => {
    const decision = decideFind(
      hamilton,
      found({ tv_results: [show(900021, 'Hamilton', '2020-07-03')] }),
    );
    assert.deepEqual(decision, { outcome: 'conflict', reason: 'kind' });
  });

  it('a /find hit dated far from IMDb’s year is a year conflict', () => {
    const decision = decideFind(
      hamilton,
      found({ movie_results: [film(556574, 'Hamilton', '2016-06-26')] }),
    );
    assert.deepEqual(decision, { outcome: 'conflict', reason: 'year' });
  });

  it('a /find with nothing falls through to the title search', () => {
    assert.equal(decideFind(hamilton, found()).outcome, 'none');
  });
});

describe('what still contradicts a verified id', () => {
  it('the other kind: a Movie row whose id names a series is a conflict', () => {
    const decision = decideFind(
      claim(),
      found({ tv_results: [show(1396, 'Heat', '1995-12-15')] }),
    );
    assert.deepEqual(decision, { outcome: 'conflict', reason: 'kind' });
  });

  it('the other kind: a TV Series row whose id names a movie is a conflict', () => {
    const decision = decideFind(
      claim({ title_type: 'TV Series' }),
      found({ movie_results: [film(949, 'Heat', '1995-12-15')] }),
    );
    assert.deepEqual(decision, { outcome: 'conflict', reason: 'kind' });
  });

  it('two /find results of the expected kind are ambiguous', () => {
    const decision = decideFind(
      claim(),
      found({
        movie_results: [film(949, 'Heat', '1995-12-15'), film(950, 'Heat', '1995-12-15')],
      }),
    );
    assert.equal(decision.outcome, 'ambiguous');
  });

  it('two /find shows for a TV row are ambiguous too', () => {
    const decision = decideFind(
      claim({ title_type: 'TV Series' }),
      found({
        tv_results: [show(1, 'Heat', '1995-01-01'), show(2, 'Heat', '1995-01-01')],
      }),
    );
    assert.equal(decision.outcome, 'ambiguous');
  });

  it('an episode or a season is unsupported', () => {
    assert.equal(
      decideFind(claim(), found({ tv_episode_results: [{ id: 62085 }] })).outcome,
      'unsupported',
    );
    assert.equal(
      decideFind(claim(), found({ tv_season_results: [{ id: 3572 }] })).outcome,
      'unsupported',
    );
  });

  it('a year far outside tolerance is a conflict, whatever the title', () => {
    const decision = decideFind(
      claim({ name: 'Heat', year: 1995 }),
      found({ movie_results: [film(949, 'Heat', '1986-01-01')] }),
    );
    assert.deepEqual(decision, { outcome: 'conflict', reason: 'year' });
  });

  it('the tolerance is one year on a verified id, and two is already out', () => {
    assert.equal(VERIFIED_YEAR_TOLERANCE, 1);
    const at = (date) => verifiedIdentityAgrees(claim({ year: 2010 }), film(1, 'X', date));
    assert.equal(at('2009-12-31'), true);
    assert.equal(at('2011-01-01'), true);
    assert.equal(at('2008-12-31'), false);
    assert.equal(at('2012-01-01'), false);
  });

  it('an undated hit, or a row with no year, has nothing to disagree about', () => {
    assert.equal(verifiedIdentityAgrees(claim({ year: 2010 }), film(1, 'X', null)), true);
    assert.equal(
      verifiedIdentityAgrees(claim({ year: null }), film(1, 'X', '1950-01-01')),
      true,
    );
  });
});

describe('the title search stays strict (it proves nothing about the id)', () => {
  // The Hamlet report shape (import-provider-match.test.mjs): a translated title in the
  // exact year and a native one a year out. Nothing in a row can tell them apart.
  const hamletResults = [
    film(1234733, 'Hamlet', '2025-12-01', 'Cătun'),
    film(843342, 'Hamlet', '2026-02-06', 'Hamlet'),
  ];

  it('Hamlet/Cătun stays unresolved for an IMDb row on the title path', () => {
    const row = claim({ name: 'Hamlet', year: 2025 });
    assert.equal(pick({ name: row.name, year: row.year }, hamletResults), null);
  });

  it('The Beguiled 1971/2017 with no year stays unresolved, and popularity never decides', () => {
    const results = [
      { ...film(9000, 'The Beguiled', '2017-06-23'), popularity: 99 },
      { ...film(9001, 'The Beguiled', '1971-03-31'), popularity: 1 },
    ];
    assert.equal(pick({ name: 'The Beguiled', year: null }, results), null);
    // And with a year, the exact-year film, not the popular one.
    assert.equal(pick({ name: 'The Beguiled', year: 1971 }, results)?.id, 9001);
  });

  it('a display-title variant is NOT accepted by the title search', () => {
    const results = [film(671, "Harry Potter and the Philosopher's Stone", '2001-11-16')];
    assert.equal(
      pick({ name: 'Harry Potter and the Sorcerer’s Stone', year: 2001 }, results),
      null,
    );
  });
});

describe('the original-title search', () => {
  const row = claim({
    name: 'The Lives of Others',
    original_title: 'Das Leben der Anderen',
    year: 2006,
  });

  it('is made only when the row carries an original title that differs', () => {
    assert.deepEqual(originalClaim(row), {
      row_id: 'r1',
      name: 'Das Leben der Anderen',
      year: 2006,
    });
    assert.equal(originalClaim(claim()), null);
    assert.equal(originalClaim(claim({ original_title: 'HEAT' })), null);
    assert.equal(originalClaim(claim({ original_title: '  ' })), null);
  });

  it('judges a result by its original title, with the same strict pick', () => {
    const results = [film(582, 'The Lives of Others', '2006-03-23', 'Das Leben der Anderen')];
    assert.equal(pickOriginal(row, results)?.id, 582);
  });

  it('two films sharing the original title in the year stay unresolved', () => {
    const results = [
      film(582, 'The Lives of Others', '2006-03-23', 'Das Leben der Anderen'),
      film(583, 'Other Lives', '2006-05-01', 'Das Leben der Anderen'),
    ];
    assert.equal(pickOriginal(row, results), null);
  });

  it('a TV row is judged on the show’s original name', () => {
    const tvRow = claim({
      name: 'Money Heist',
      original_title: 'La casa de papel',
      year: 2017,
      title_type: 'TV Series',
    });
    const results = [show(71446, 'Money Heist', '2017-05-02', 'La casa de papel')];
    assert.equal(pickOriginal(tvRow, results, 'series')?.id, 71446);
  });

  it('asks the neighbouring years when the exact year has nothing', () => {
    assert.equal(needsWindowOriginal(row, []), true);
    assert.equal(needsWindowOriginal(claim(), []), false);
  });
});

describe('titleCorroboration (support only)', () => {
  const c = (name, title) => titleCorroboration({ name }, { title });

  it('reads the founder classes as variants', () => {
    assert.equal(c('Fathers & Daughters', 'Fathers and Daughters'), 'variant');
    assert.equal(c('Fyre', 'Fyre: The Greatest Party That Never Happened'), 'variant');
    assert.equal(c('The Divergent Series: Insurgent', 'Insurgent'), 'variant');
    assert.equal(
      c('Star Wars: Episode VII - The Force Awakens', 'Star Wars: The Force Awakens'),
      'variant',
    );
  });

  it('says exact for squash-equal titles and none for unrelated ones', () => {
    assert.equal(
      c('Spider-Man: Into the Spider-Verse', 'Spiderman Into the Spiderverse'),
      'exact',
    );
    assert.equal(c('Cats', 'The Godfather'), 'none');
    assert.equal(c('Up', 'Upgrade'), 'none');
  });
});
