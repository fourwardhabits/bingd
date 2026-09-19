import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isConfident, needsWindow, pick, squash } from '../functions/letterboxd-import/match.mjs';

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

// ===========================================================================
// The Hamlet report (Android beta, 2026-09-18)
//
// Real TMDB records, as the production catalogue holds them:
//   843342   Hamlet   original "Hamlet"  2026-02-06   the film the person watched
//   1234733  Hamlet   original "Cătun"   2025-12-01   a Romanian film translated as "Hamlet"
//   1275052  Hamlet   original "Hamlet"  2024-05-10
//   1205709  Hamlet   original "Hamlet"  2024-02-27
//
// The production claim ledger shows the provider tier chose 1234733. A 2026 search cannot
// return it, so the export row read `Hamlet, 2025`, a year before TMDB's date for the real
// film, and the old single exact-year search never saw 843342 at all.
// ===========================================================================

const film = (id, release_date, original_title = 'Hamlet', title = 'Hamlet') => ({
  id, title, original_title, release_date,
});
const HAMLET_2026 = film(843342, '2026-02-06');
const CATUN_2025 = film(1234733, '2025-12-01', 'Cătun');
const HAMLET_2024A = film(1275052, '2024-05-10');
const HAMLET_2024B = film(1205709, '2024-02-27');

describe('pick, when the same title exists in adjacent years', () => {
  it('takes the exact-year film over an adjacent-year one, whichever came first', () => {
    const want = claim('Hamlet', 2026);
    assert.equal(pick(want, [CATUN_2025, HAMLET_2026]).id, 843342);
    assert.equal(pick(want, [HAMLET_2026, CATUN_2025]).id, 843342);
  });

  it('takes the exact-year film over a same-named, natively titled neighbour too', () => {
    const neighbour = film(1, '2025-03-01');
    assert.equal(pick(claim('Hamlet', 2026), [neighbour, HAMLET_2026]).id, 843342);
  });

  it('never lets a lone adjacent-year film win when the exact year has one', () => {
    // The old rule called this ambiguous at best; with only the neighbour visible it chose it.
    assert.notEqual(pick(claim('Hamlet', 2026), [CATUN_2025, HAMLET_2026])?.id, 1234733);
  });

  it('refuses the reported case: a translated title in the exact year, the native one beside it', () => {
    // `Hamlet, 2025` — the row as the export must have carried it. Nothing an export holds
    // says which of the two was meant, so neither is written.
    assert.equal(pick(claim('Hamlet', 2025), [CATUN_2025, HAMLET_2026]), null);
    assert.equal(
      pick(claim('Hamlet', 2025), [CATUN_2025, HAMLET_2026, HAMLET_2024A, HAMLET_2024B]),
      null,
    );
  });

  it('still takes a translated title when nothing natively titled is within a year', () => {
    // A foreign film exported under its English name is the ordinary case, not a suspect one.
    const parasite = film(496243, '2019-05-30', '기생충', 'Parasite');
    assert.equal(pick(claim('Parasite', 2019), [parasite]).id, 496243);
    const otherTranslation = film(7, '2020-01-01', 'Paraziták', 'Parasite');
    assert.equal(pick(claim('Parasite', 2019), [parasite, otherTranslation]).id, 496243);
  });

  it('treats an unknown original title as no evidence either way', () => {
    const noOriginal = { id: 9, title: 'Hamlet', release_date: '2026-02-06' };
    assert.equal(pick(claim('Hamlet', 2026), [CATUN_2025, noOriginal]).id, 9);
  });

  it('falls back to a single adjacent-year film when the exact year has none', () => {
    // Letterboxd's first-release year against a provider date one year later.
    assert.equal(pick(claim('Hamlet', 2025), [HAMLET_2026]).id, 843342);
    assert.equal(
      pick(claim('Slumdog Millionaire', 2008), [film(12405, '2009-01-09', 'Slumdog Millionaire', 'Slumdog Millionaire')]).id,
      12405,
    );
  });

  it('leaves two adjacent-year films unresolved when the exact year has none', () => {
    assert.equal(pick(claim('Hamlet', 2025), [HAMLET_2024A, HAMLET_2026]), null);
  });

  it('leaves two exact-year films unresolved, whatever their neighbours', () => {
    assert.equal(pick(claim('Hamlet', 2024), [HAMLET_2024A, HAMLET_2024B, CATUN_2025]), null);
  });

  it('counts a film returned by two searches once', () => {
    assert.equal(pick(claim('Hamlet', 2026), [HAMLET_2026, HAMLET_2026]).id, 843342);
  });

  it('is unchanged when the export had no year', () => {
    assert.equal(pick(claim('Hamlet', null), [HAMLET_2026, CATUN_2025]), null);
    assert.equal(pick(claim('Hamlet', null), [HAMLET_2026]).id, 843342);
  });
});

describe('needsWindow', () => {
  it('is settled by one natively titled exact-year film, so the common case is one request', () => {
    assert.equal(needsWindow(claim('Hamlet', 2026), [HAMLET_2026]), false);
  });

  it('asks the neighbouring years when the exact year has nothing', () => {
    assert.equal(needsWindow(claim('Hamlet', 2025), []), true);
    assert.equal(needsWindow(claim('Hamlet', 2025), [film(3, '2025-01-01', 'Hamlet 2', 'Hamlet 2')]), true);
  });

  it('asks the neighbouring years when the only exact-year film is a translated title', () => {
    // The reported import: this is the search that would have found 843342.
    assert.equal(needsWindow(claim('Hamlet', 2025), [CATUN_2025]), true);
  });

  it('does not bother when the exact year is already a remake', () => {
    assert.equal(needsWindow(claim('Hamlet', 2024), [HAMLET_2024A, HAMLET_2024B]), false);
  });

  it('never widens a row with no year', () => {
    assert.equal(needsWindow(claim('Hamlet', null), []), false);
  });

  it('decides the reported row safely once the window is asked', () => {
    const want = claim('Hamlet', 2025);
    const exactYear = [CATUN_2025];
    assert.equal(needsWindow(want, exactYear), true);
    const window = [...exactYear, HAMLET_2024A, HAMLET_2024B, HAMLET_2026];
    assert.equal(pick(want, window), null, 'unresolved, never Cătun');
  });
});
