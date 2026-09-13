import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isConfident, pick, squash } from '../functions/letterboxd-import/match.mjs';

/**
 * The provider tier's confidence rule — `supabase/functions/letterboxd-import/match.mjs`.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS SUITE IS ABOUT
 *
 * A provider's result ordering is its opinion about relevance, not an identification.
 * "Take the first hit" is the obvious implementation and it is how a rating somebody gave
 * to *The Beguiled* (1971) ends up on *The Beguiled* (2017): same query, same title,
 * different film, and no error anywhere.
 *
 * So every case below is about refusing to guess. The local matcher applies the same rule
 * in SQL; this is the half that runs where SQL cannot reach.
 */

const claim = (name, year = null) => ({ row_id: 'r', name, year });
const result = (title, release_date = null, id = 1) => ({ id, title, release_date });

describe('squash', () => {
  it('agrees with media_squash on punctuation', () => {
    assert.equal(squash('Spider-Man: Into the Spider-Verse'), 'spidermanintothespiderverse');
    assert.equal(squash("Ocean's Eleven"), 'oceanseleven');
    assert.equal(squash('Coyote vs. Acme'), 'coyotevsacme');
  });

  it('folds diacritics the way media_fold does', () => {
    assert.equal(squash('Amélie'), squash('Amelie'));
    assert.equal(squash('Joker: Folie à Deux'), 'jokerfolieadeux');
  });

  it('keeps digits, so a year inside a title survives', () => {
    assert.equal(squash('Blade Runner 2049'), 'bladerunner2049');
  });

  it('does not fold a non-Latin title away to nothing', () => {
    assert.equal(squash('万引き家族'), '万引き家族');
  });
});

describe('isConfident', () => {
  it('accepts an exact title and year', () => {
    assert.equal(isConfident(claim('Shrek', 2001), result('Shrek', '2001-04-22')), true);
  });

  it('accepts a year one off, because release dates differ by territory', () => {
    // Slumdog Millionaire is 2008 on Letterboxd and 2009 in the UK.
    assert.equal(
      isConfident(claim('Slumdog Millionaire', 2008), result('Slumdog Millionaire', '2009-01-09')),
      true,
    );
  });

  it('refuses a year two off', () => {
    assert.equal(isConfident(claim('Shrek', 2001), result('Shrek', '2003-01-01')), false);
  });

  it('refuses a different title however good the provider thought the match was', () => {
    assert.equal(isConfident(claim('Shrek', 2001), result('Shrek 2', '2004-05-19')), false);
  });

  it('accepts a result with no release date on the title alone', () => {
    // An announced-but-undated film. There is nothing left to disagree about.
    assert.equal(isConfident(claim('The Odyssey', 2026), result('The Odyssey', null)), true);
  });

  it('accepts on title alone when the export had no year', () => {
    assert.equal(isConfident(claim('Shrek', null), result('Shrek', '2001-04-22')), true);
  });

  it('matches through punctuation and accents', () => {
    assert.equal(
      isConfident(claim('Joker: Folie a Deux', 2024), result('Joker: Folie à Deux', '2024-10-02')),
      true,
    );
  });

  it('refuses nonsense rather than throwing', () => {
    assert.equal(isConfident(null, result('Shrek')), false);
    assert.equal(isConfident(claim('Shrek'), null), false);
    assert.equal(isConfident(claim('Shrek', 2001), result(undefined)), false);
  });
});

describe('pick', () => {
  it('takes the one confident result', () => {
    const chosen = pick(claim('Shrek', 2001), [
      result('Shrek 2', '2004-05-19', 2),
      result('Shrek', '2001-04-22', 1),
    ]);
    assert.equal(chosen.id, 1);
  });

  it('refuses a remake rather than choosing by order', () => {
    // Two films, same title, a year apart. Whichever the provider ranked first, taking it
    // would put a film the person did not watch into their collection.
    const chosen = pick(claim('The Beguiled', 1971), [
      result('The Beguiled', '1971-03-31', 10),
      result('The Beguiled', '1971-06-01', 11),
    ]);
    assert.equal(chosen, null);
  });

  it('returns nothing when nothing is confident', () => {
    assert.equal(pick(claim('A Film Nobody Has', 2001), [result('Something Else', '2001-01-01')]), null);
  });

  it('returns nothing for an empty or absent result set', () => {
    assert.equal(pick(claim('Shrek', 2001), []), null);
    assert.equal(pick(claim('Shrek', 2001), null), null);
  });

  it('ignores a near-miss beside a genuine match', () => {
    const chosen = pick(claim('Barbie', 2023), [
      result('Barbie', '2023-07-19', 5),
      result('Barbie: Fairytopia', '2005-03-08', 6),
      result('Barbie Nutcracker', '2001-10-02', 7),
    ]);
    assert.equal(chosen.id, 5);
  });
});
