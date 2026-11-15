/**
 * Whether a provider result is the film a staged row is about.
 *
 * ---------------------------------------------------------------------------
 * PLAIN JAVASCRIPT, ON PURPOSE
 *
 * This is the only part of the provider tier that makes a *decision*, and it is therefore
 * the only part worth testing hard. Deno is not installed on the founder's machine, so a
 * `.ts` module beside `index.ts` would be reviewed and never executed — and an untested
 * matching predicate is precisely the thing that quietly puts the wrong film in somebody's
 * collection.
 *
 * So it is `.mjs` with no imports: Deno loads it beside `index.ts`, and `node --test` runs
 * its suite directly. Nothing about it needs a runtime.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, AND WHY IT IS NOT "TAKE THE FIRST RESULT"
 *
 * A provider's ordering is its opinion about relevance, not an identification. Accepting
 * the top hit unchecked is how a rating somebody gave to *The Beguiled* (1971) lands on
 * *The Beguiled* (2017) — same title, same query, different film, and nothing anywhere
 * says it went wrong.
 *
 * So the provider tier applies the same test the local tier does: the squashed titles must
 * be equal, and the years must agree within one. Among the results that pass, an exact
 * year outranks an adjacent one, and anything the evidence cannot separate is left
 * unresolved rather than broken by popularity (`pick`, and `20260924000100` for SQL).
 */

/**
 * The folding `media_squash` applies in SQL, restated so both sides of a comparison agree.
 *
 * Diacritics are folded with the same table `media_fold` uses, then everything that is not
 * a letter or a digit is removed — which is what makes `Spider-Man: Into the Spider-Verse`
 * and `Spiderman Into the Spiderverse` the same string, and why `Blade Runner 2049` keeps
 * its digits.
 */
export function squash(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[áàâäãåāąăæ]/g, 'a')
    .replace(/[çćč]/g, 'c')
    .replace(/[đďð]/g, 'd')
    .replace(/[éèêëēęě]/g, 'e')
    .replace(/[ğ]/g, 'g')
    .replace(/[íìîïīı]/g, 'i')
    .replace(/[łľ]/g, 'l')
    .replace(/[ñńň]/g, 'n')
    .replace(/[óòôöõøōőœ]/g, 'o')
    .replace(/[řŕ]/g, 'r')
    .replace(/[šśşß]/g, 's')
    .replace(/[ťțþ]/g, 't')
    .replace(/[úùûüūůű]/g, 'u')
    .replace(/[ýÿ]/g, 'y')
    .replace(/[žźż]/g, 'z')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * One result, judged against one claim.
 *
 * The year tolerance is ±1 for the reason the local tier has it: Letterboxd records the
 * first release year and a provider's `release_date` may be another territory's, so
 * *Slumdog Millionaire* is 2008 on one side and 2009 on the other and is the same film.
 *
 * A result with no release date passes on the title alone — that is how an
 * announced-but-undated film resolves, and there is nothing left to disagree about once
 * the squashed titles are equal.
 */
export function isConfident(claim, result) {
  if (!claim || !result) return false;
  if (squash(result.title) !== squash(claim.name)) return false;
  if (claim.year === null || claim.year === undefined) return true;

  const year = result.release_date ? Number(String(result.release_date).slice(0, 4)) : NaN;
  if (!Number.isFinite(year)) return true;

  return Math.abs(year - claim.year) <= 1;
}

/** A result's release year, or null when it has no usable date. */
function yearOf(result) {
  const year = result?.release_date ? Number(String(result.release_date).slice(0, 4)) : NaN;
  return Number.isFinite(year) ? year : null;
}

/**
 * Whether a result's *original* title is the name the export used (true), a different one
 * (false), or unknown (null).
 *
 * The one field that tells a film called "Hamlet" apart from a film merely *translated* as
 * "Hamlet". Unknown is its own answer, never a guess: it neither vetoes a candidate nor
 * counts against one, which is how every result without the field behaved before this rule.
 */
function originalNameAgrees(claim, result) {
  const original = typeof result?.original_title === 'string' ? squash(result.original_title) : '';
  if (original === '') return null;
  return original === squash(claim.name);
}

/**
 * The single result the evidence supports, or null.
 *
 * ---------------------------------------------------------------------------
 * THE HAMLET REPORT (2026-09-18), AND WHY "EXACTLY ONE" WAS NOT ENOUGH
 *
 * The rule used to be "exactly one confident result". That is only a uniqueness test if the
 * results are every film the rule would have accepted, and they were not: `search` asked
 * TMDB for `primary_release_year` equal to the export's year, so a film one year out never
 * came back at all, while `isConfident` would have accepted it. Uniqueness was being judged
 * over a truncated set.
 *
 * A real Android beta import paid for it. The production claim ledger records the provider
 * tier placing a Letterboxd "Hamlet" on TMDB 1234733 — the Romanian *Cătun* (2025-12-01),
 * whose English title is a translation of the word — when the film meant was TMDB 843342,
 * *Hamlet*, primary release 2026-02-06. A 2026 search cannot return *Cătun*, so the row must
 * have carried 2025 — a year earlier than TMDB's, the festival/territory gap the tolerance
 * exists for. The 2025 search could not see the real film, and the one "Hamlet" it did
 * return was the only survivor, so it was "confident".
 *
 * ---------------------------------------------------------------------------
 * THE ORDER NOW
 *
 * With a year:
 *   1. An exact-year result wins over adjacent-year ones, however the provider ordered them.
 *      Two or more exact-year results are left unresolved — unless exactly one of them has
 *      the exported name as its original title and every other one is known to be a
 *      translation (1b, below).
 *   2. **Except** when that exact-year film is a translated title (its original title is
 *      not the exported name) and a film whose original title *is* that name sits in the
 *      adjacent year. That is the Hamlet shape exactly, and nothing in an export can tell
 *      which of the two was meant — so it is left unresolved rather than guessed.
 *   3. With no exact-year result, a single adjacent-year (or undated) result is the
 *      territory/festival-year fallback the ±1 tolerance always existed for. More than one
 *      is unresolved.
 *
 * With no year: exactly one title match, as before.
 *
 * Popularity is never consulted, and neither is the provider's order.
 *
 * ---------------------------------------------------------------------------
 * 1b. THE SAME-YEAR NAMESAKE (staging, 2026-09-19)
 *
 * Rule 2's mirror image. A real staging import of `Past Lives, 2023` came back unresolved:
 * TMDB holds two 2023 films titled "Past Lives" — 666277, whose original title is "Past
 * Lives", and 1164820, a Filipino film whose original title is "Nagligad nga Kinabuhi". Two
 * exact-year results was a remake to the old rule, and to the one before it.
 *
 * It is not a remake. One of them bears the exported name natively; the other only in
 * translation. So when exactly one exact-year result's original title is the exported name
 * and every other exact-year result's original title is known and different, that one wins.
 * Two native matches is a genuine remake, and an unknown original title could be a second
 * native match — both stay unresolved.
 */
export function pick(claim, results) {
  if (!Array.isArray(results)) return null;

  // The window can be three searches; one film never counts twice.
  const seen = new Set();
  const confident = results.filter((r) => {
    if (!isConfident(claim, r)) return false;
    if (typeof r.id === 'number') {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
    }
    return true;
  });

  if (claim.year === null || claim.year === undefined) {
    return confident.length === 1 ? confident[0] : null;
  }

  const exact = confident.filter((r) => yearOf(r) === claim.year);
  const others = confident.filter((r) => yearOf(r) !== claim.year);

  if (exact.length > 1) {
    // 1b. Exactly one native original title, every other one known to be a translation.
    const native = exact.filter((r) => originalNameAgrees(claim, r) === true);
    const translations = exact.filter((r) => originalNameAgrees(claim, r) === false);
    return native.length === 1 && translations.length === exact.length - 1 ? native[0] : null;
  }

  if (exact.length === 1) {
    const translated = originalNameAgrees(claim, exact[0]) === false;
    const nativeElsewhere = others.some((r) => originalNameAgrees(claim, r) === true);
    return translated && nativeElsewhere ? null : exact[0];
  }

  return others.length === 1 ? others[0] : null;
}

/**
 * Whether the exact-year answer alone cannot settle the claim, so the adjacent years must
 * be asked for too.
 *
 * Ordinarily it can: one exact-year film whose original title is not known to differ from
 * the exported name wins over anything the neighbouring years hold (`pick`, rule 1), and
 * several exact-year films are either settled among themselves by their original titles
 * (rule 1b) or a remake no neighbour can resolve. So the common case stays one request.
 *
 * It cannot when there is no exact-year film (the fallback needs the neighbours) or when
 * the only one is a translated title (a native-titled neighbour would veto it, rule 2).
 */
export function needsWindow(claim, results) {
  if (!claim || claim.year === null || claim.year === undefined) return false;
  const exact = (Array.isArray(results) ? results : []).filter(
    (r) => isConfident(claim, r) && yearOf(r) === claim.year,
  );
  if (exact.length > 1) return false;
  if (exact.length === 0) return true;
  return originalNameAgrees(claim, exact[0]) === false;
}

/** A string the catalogue can store, or null. TMDB sends '' for "nothing here". */
const textOrNull = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);

/**
 * The catalogue row for a confident result, carrying everything the search already paid for.
 *
 * **The poster is the reason this exists** (physical QA, staging, 2026-09-12). The upsert
 * used to send only the id, title and date, so every film the provider tier placed entered
 * `media_items` as a stub: fourteen of one founder's twenty-four imported films showed an
 * initials tile in Collection until each title page was opened and its detail call filled
 * the row in. `/search/movie` had returned `poster_path` for every one of them, and the
 * catalogue adapter's own search path (`normalize.ts` `fromSearchResult`) already keeps it.
 *
 * So this costs no request: it is the same response, no longer thrown away. Runtime,
 * genres and certification are not in a search result and stay null, which the upsert's
 * coalesce reads as "unknown" rather than overwriting what a detail call wrote. Genre ids
 * would need the provider's genre list to become names, and a name is what the column holds.
 */
export function catalogueItem(result) {
  return {
    kind: 'movie',
    tmdb_id: result.id,
    title: result.title,
    original_title: textOrNull(result.original_title),
    release_date: textOrNull(result.release_date),
    overview: textOrNull(result.overview),
    poster_path: textOrNull(result.poster_path),
    backdrop_path: textOrNull(result.backdrop_path),
    original_language: textOrNull(result.original_language),
    popularity: typeof result.popularity === 'number' ? result.popularity : null,
  };
}

// =========================================================================================
// IMDb (20261113000100)
//
// An IMDb row arrives with an identifier, so the order of evidence is the reverse of a
// Letterboxd row's: TMDB's own /find for the tt id first, and a title search only when
// /find knows nothing. Both answers are judged here, with no I/O, for the reason the rest
// of this file is plain JavaScript: it is the part that decides which title somebody's
// history attaches to, so it is the part `node --test` must be able to reach.
//
// The database re-checks every answer (`_import_provider_resolve`), so these functions are
// the first opinion, not the last.
// =========================================================================================

/**
 * An IMDb Title Type folded the way `_import_imdb_title_type` folds it: letters only, lower
 * case, `other` when unknown. IMDb has written both "TV Mini Series" and "tvMiniSeries".
 */
export function imdbTitleType(raw) {
  const folded = typeof raw === 'string' ? raw.replace(/[^A-Za-z]/g, '').toLowerCase() : '';
  return IMDB_TYPES.has(folded) ? folded : 'other';
}

const IMDB_TYPES = new Set([
  'movie',
  'tvmovie',
  'video',
  'short',
  'tvshort',
  'tvspecial',
  'tvseries',
  'tvminiseries',
  'tvepisode',
  'videogame',
  'musicvideo',
  'podcastseries',
  'podcastepisode',
]);

/**
 * The canonical kind a folded IMDb type may resolve to, or null when bingd has none.
 * Mirrors `_import_imdb_kind`. IMDb's type is evidence, never a reclassification: a title
 * TMDB files under the other kind is a conflict (`decideFind`).
 */
export function imdbKind(titleType) {
  switch (titleType) {
    case 'movie':
    case 'tvmovie':
    case 'video':
    case 'short':
    case 'tvshort':
    case 'tvspecial':
      return 'movie';
    case 'tvseries':
    case 'tvminiseries':
      return 'series';
    default:
      return null;
  }
}

/** A TMDB TV result in the shape `pick` and `isConfident` read. */
export function tvAsCandidate(result) {
  return {
    ...result,
    title: result?.name ?? result?.title ?? '',
    original_title: result?.original_name ?? result?.original_title ?? null,
    release_date: result?.first_air_date ?? result?.release_date ?? null,
  };
}

/**
 * Whether a TITLE-SEARCH result is plausibly the title the row names: a squashed title or
 * original title in common with the row's title or original title, and years within one
 * where both are known. Mirrors `_import_imdb_identity_agrees`.
 *
 * **Not the test for a /find answer any more** (20261118000100). A title search proves
 * nothing about the id, so its answer must look like the row. A /find answer is TMDB's own
 * mapping for the exact tt id, and is judged by `verifiedIdentityAgrees` instead.
 */
export function identityAgrees(claim, candidate) {
  if (!claim || !candidate) return false;
  const theirs = [squash(candidate.title), squash(candidate.original_title)].filter(Boolean);
  const ours = [squash(claim.name), squash(claim.original_title)].filter(Boolean);
  if (!theirs.some((value) => ours.includes(value))) return false;
  return yearAgrees(claim, candidate);
}

/**
 * The release-year tolerance a verified id is held to: the same ±1 every other tier uses.
 *
 * Deliberately not widened for a verified id. The one-year gap is the territory/festival
 * difference between IMDb's year and TMDB's primary release date (Slumdog Millionaire,
 * 2008/2009); nothing in the founder QA evidence needed two, and two would start admitting
 * the remake-a-year-later shape the year check exists to stop.
 */
export const VERIFIED_YEAR_TOLERANCE = 1;

/** Years within the tolerance, or unknown on either side (nothing to disagree about). */
function yearAgrees(claim, candidate) {
  if (claim.year === null || claim.year === undefined) return true;
  const year = yearOf(candidate);
  return year === null || Math.abs(year - claim.year) <= VERIFIED_YEAR_TOLERANCE;
}

/**
 * Whether the one /find hit of the expected kind is the row's title (20261118000100).
 * Mirrors `_import_imdb_verified_agrees`.
 *
 * ---------------------------------------------------------------------------
 * THE FOUNDER QA IMPORT (2026-11-12), AND WHY THE TITLE IS NOT CONSULTED
 *
 * A /find answer is TMDB's own record that this title carries this exact tt id. It used to
 * be rejected as a `conflict` whenever its display title differed from IMDb's, and the
 * conflict was final, so the title search never ran either. That is how
 *
 *   IMDb "Harry Potter and the Sorcerer's Stone"        TMDB 671 "…Philosopher's Stone"
 *   IMDb "Star Wars: Episode VII - The Force Awakens"   TMDB 140607 "Star Wars: The Force Awakens"
 *
 * ended in "Couldn't match" with the right film one id away: a regional title, a franchise
 * prefix, `&` for "and", a show IMDb and TMDB name differently. None of those is a
 * contradiction; they are two catalogues' display names for one identified title.
 *
 * What still contradicts a verified id, and stays a veto:
 *   the other kind          `decideFind` (a Movie row whose id names a series, or the reverse)
 *   two results of the kind `decideFind` (duplicate TMDB titles claiming one id: ambiguous)
 *   an episode or season    `decideFind` (unsupported)
 *   a year out of tolerance here: TMDB's title is dated more than one year from IMDb's
 *
 * Title evidence is still read (`titleCorroboration`), as SUPPORT for the report, never as a
 * veto on a verified id.
 */
export function verifiedIdentityAgrees(claim, candidate) {
  if (!claim || !candidate) return false;
  return yearAgrees(claim, candidate);
}

/** `squash`, with a standalone `&` read as "and" first. Corroboration only. */
const squashAnd = (value) =>
  typeof value === 'string' ? squash(value.replace(/\s*&\s*/g, ' and ')) : '';

/** Letters-and-digits words, folded the way `squash` folds them. Corroboration only. */
const words = (value) =>
  typeof value === 'string'
    ? value
        .replace(/&/g, ' and ')
        .split(/[^\p{L}\p{N}]+/u)
        .map(squash)
        .filter(Boolean)
    : [];

/**
 * How far the row's title and a verified candidate's title agree, for the report only:
 *
 *   exact    a squashed title or original title in common (what `identityAgrees` needs)
 *   variant  `&`/"and", one title's words all inside the other's (a franchise prefix or
 *            subtitle),
 *            or most words in common (a regional word: Sorcerer's/Philosopher's,
 *            Pajamas/Pyjamas)
 *   none     nothing in common that this can see
 *
 * **Never a veto.** A verified id with `none` still matches; the count of those is reported
 * so an operator can audit them, which is the whole use of this.
 */
export function titleCorroboration(claim, candidate) {
  if (!claim || !candidate) return 'none';
  const theirs = [candidate.title, candidate.original_title];
  const ours = [claim.name, claim.original_title];
  const pairs = theirs.flatMap((a) => ours.map((b) => [a, b])).filter(([a, b]) => a && b);

  if (pairs.some(([a, b]) => squash(a) !== '' && squash(a) === squash(b))) return 'exact';

  for (const [a, b] of pairs) {
    const x = squashAnd(a);
    const y = squashAnd(b);
    if (x === '' || y === '') continue;
    if (x === y) return 'variant';
    const wx = new Set(words(a));
    const wy = new Set(words(b));
    const shared = [...wx].filter((w) => wy.has(w)).length;
    // Whole words, never a substring: "Alien" is not a variant of "Aliens".
    if (shared > 0 && shared === Math.min(wx.size, wy.size)) return 'variant';
    if (shared >= 2 && shared / Math.max(wx.size, wy.size) >= 0.5) return 'variant';
  }
  return 'none';
}

/**
 * A title folded for the SHARED-MAPPING test (20261118000200): `&` read as "and", one
 * leading English article dropped, then `squash`. Mirrors `_import_imdb_title_norm`
 * character for character, which is why it is regex-on-text before the fold rather than
 * anything word-aware.
 */
export function mappingNorm(value) {
  if (typeof value !== 'string') return '';
  return squash(value.replace(/&/g, ' and ').replace(/^\s*(the|a|an)\s+/i, ''));
}

/**
 * Whether a verified title may also TEACH the catalogue the id (20261118000200). Mirrors
 * `_import_imdb_mapping_title_agrees`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SHARED ID HAS A HIGHER BAR THAN THE MATCH
 *
 * The match decides one person's row; `media_items.imdb_id` decides every future row in
 * every account, through Tier 1, with no provider call and no title check. So a verified
 * id is enough to LINK the row (`verifiedIdentityAgrees`), and the mapping is written only
 * when the title agrees as well: a squashed title or original title in common, or one that
 * agrees once `&` is read as "and" and a leading article is dropped ("The X" / "X").
 *
 * A verified id that won over a disagreeing display title (Sorcerer's/Philosopher's, a
 * franchise prefix, a renamed show) links the row and writes nothing shared. The next import
 * of that title asks /find again, which is one request and the same answer.
 */
export function mappingTitleAgrees(claim, candidate) {
  if (!claim || !candidate) return false;
  const theirs = [candidate.title, candidate.original_title];
  const ours = [claim.name, claim.original_title];
  for (const a of theirs) {
    for (const b of ours) {
      const sa = squash(a);
      const sb = squash(b);
      if (sa !== '' && sa === sb) return true;
      const na = mappingNorm(a);
      const nb = mappingNorm(b);
      if (na !== '' && na === nb) return true;
    }
  }
  return false;
}

const list = (value) => (Array.isArray(value) ? value : []);

/**
 * The release year, among ALL of a movie's TMDB release dates (every country, every type),
 * closest to the row's year and within tolerance, or null (20261118000200).
 *
 * The rescue for a `conflict` with `reason: 'year'`: TMDB's primary date is one release of
 * many, and it moves. Hamilton (tt8503618) is IMDb 2020, the Disney+ premiere; TMDB 556574's
 * primary date became a 2025 theatrical release. A verified id whose title has ANY dated
 * release within a year of IMDb's is the same film; one with none stays a conflict.
 *
 * Read only on that conflict path, so a normal match costs no extra request.
 */
export function releaseYearAgreeing(claim, body) {
  if (!claim || claim.year === null || claim.year === undefined) return null;
  let best = null;
  for (const country of list(body?.results)) {
    for (const release of list(country?.release_dates)) {
      const year = Number(String(release?.release_date ?? '').slice(0, 4));
      if (!Number.isFinite(year) || year < 1000) continue;
      const gap = Math.abs(year - claim.year);
      if (gap > VERIFIED_YEAR_TOLERANCE) continue;
      if (best === null || gap < Math.abs(best - claim.year) || (gap === Math.abs(best - claim.year) && year < best)) {
        best = year;
      }
    }
  }
  return best;
}

/**
 * The one bucket a claimed IMDb row lands in for the batch answer (20261118000200).
 *
 * Decided by what the DATABASE settled (`_import_provider_resolve` returns the row's status),
 * never by what the Edge Function hoped: an undated /find hit the Edge accepted can still be
 * refused by the re-check against a catalogue date, and used to be counted `matched` while
 * the row said `unmatched`. Exactly one of:
 *
 *   matched            in the collection's path
 *   matched_not_added  a whole show, recognised and reported, not added
 *   unsupported        an episode, a season, or a type bingd has no place for
 *   unmatched          settled without a title
 *   retry              back to needs_provider for another attempt
 *   stale              the job settled first; nothing was written
 *   failed             the request threw; the lease lapses and it is offered again
 *   released           handed back unasked (rate limited)
 *
 * @param {{ status?: string | null, placed?: boolean, threw?: boolean, released?: boolean }} [row]
 * @returns {string}
 */
export function bucketFor({ status = null, placed = false, threw = false, released = false } = {}) {
  if (released) return 'released';
  if (threw) return 'failed';
  switch (status) {
    case 'matched':
      return 'matched';
    case 'unsupported':
      return placed ? 'matched_not_added' : 'unsupported';
    case 'unmatched':
      return 'unmatched';
    case 'needs_provider':
      return 'retry';
    default:
      return 'stale';
  }
}

/**
 * What TMDB's /find answer for the row's tt id means.
 *
 *   match        exactly one result of the expected kind, dated within tolerance
 *   unsupported  the id names an episode or a season, or the IMDb type has no destination
 *   conflict     the id names a title of the OTHER kind (`reason: 'kind'`), or the one
 *                result of the kind is dated out of tolerance (`reason: 'year'`)
 *   ambiguous    more than one result of the expected kind, or one of each kind (two TMDB
 *                titles claim the id; Tier 1 calls the same catalogue state ambiguous)
 *   none         TMDB has nothing for the id; a title search may still find it
 *
 * Every outcome but `match` and `none` is final: asking again returns the same answer.
 * A `match` carries `corroboration` (`titleCorroboration`), which decides nothing, and
 * `writesMapping` (`mappingTitleAgrees`), which decides whether the shared id is written.
 *
 * 20261118000100: a display-title difference is no longer a conflict. See
 * `verifiedIdentityAgrees`.
 */
export function decideFind(claim, body) {
  const expected = imdbKind(imdbTitleType(claim?.title_type));
  if (expected === null) return { outcome: 'unsupported' };

  const movies = list(body?.movie_results);
  const shows = list(body?.tv_results);
  const parts = [...list(body?.tv_episode_results), ...list(body?.tv_season_results)];

  const own = expected === 'movie' ? movies : shows.map(tvAsCandidate);
  const other = expected === 'movie' ? shows : movies;

  if (own.length > 1) return { outcome: 'ambiguous' };
  // A movie AND a show claiming one tt id is a duplicate, not a choice to make by kind:
  // `_import_match_batch_imdb` counts both kinds and calls it ambiguous, so this must too.
  if (own.length === 1 && other.length > 0) return { outcome: 'ambiguous' };
  if (own.length === 1) {
    const result = expected === 'movie' ? movies[0] : shows[0];
    return verifiedIdentityAgrees(claim, own[0])
      ? {
          outcome: 'match',
          kind: expected,
          result,
          corroboration: titleCorroboration(claim, own[0]),
          // 20261118000200: whether the database will also write the shared id.
          writesMapping: mappingTitleAgrees(claim, own[0]),
        }
      : // The candidate travels with a year conflict so a movie can be rescued by its
        // other release dates (`releaseYearAgreeing`); a conflict is still a conflict.
        { outcome: 'conflict', reason: 'year', kind: expected, result };
  }
  if (other.length > 0) return { outcome: 'conflict', reason: 'kind' };
  if (parts.length > 0) return { outcome: 'unsupported' };
  return { outcome: 'none' };
}

/**
 * The claim a second, original-title search judges by, or null when there is none to make
 * (20261118000100). IMDb's `Original Title` is sent only when it differs from `Title`
 * (`read-imdb`), so a row with one is a row whose display title may be a translation.
 */
export function originalClaim(claim) {
  const original = typeof claim?.original_title === 'string' ? claim.original_title.trim() : '';
  if (squash(original) === '' || squash(original) === squash(claim?.name)) return null;
  return { row_id: claim.row_id, name: original, year: claim.year ?? null };
}

/**
 * Results seen through their ORIGINAL titles, so `pick` judges an original-title search on
 * the field that search is about. TMDB's `title` is its en-US display title; a film searched
 * by "Das Leben der Anderen" comes back titled "The Lives of Others".
 */
function asOriginals(results, kind) {
  return list(results).map((r) => {
    const view = kind === 'series' ? tvAsCandidate(r) : r;
    return { ...view, title: typeof view.original_title === 'string' ? view.original_title : '' };
  });
}

/**
 * `pick` for an original-title search: the same strict rule (exact squashed title, ±1, an
 * exact year first, popularity never), applied to the result's original title against the
 * row's. Returns the raw TMDB result, or null.
 */
export function pickOriginal(claim, results, kind = 'movie') {
  const byOriginal = originalClaim(claim);
  if (!byOriginal) return null;
  const candidates = asOriginals(results, kind);
  const chosen = pick(byOriginal, candidates);
  return chosen ? list(results)[candidates.indexOf(chosen)] : null;
}

/** `needsWindow` for an original-title search. */
export function needsWindowOriginal(claim, results, kind = 'movie') {
  const byOriginal = originalClaim(claim);
  return byOriginal ? needsWindow(byOriginal, asOriginals(results, kind)) : false;
}

/** `pick`, over TV search results. Returns the raw TMDB result, or null. */
export function pickTv(claim, results) {
  const candidates = list(results).map(tvAsCandidate);
  const chosen = pick(claim, candidates);
  return chosen ? list(results)[candidates.indexOf(chosen)] : null;
}

/** `needsWindow`, over TV search results. */
export function needsWindowTv(claim, results) {
  return needsWindow(claim, list(results).map(tvAsCandidate));
}

/**
 * The catalogue row for a TV result, through the same upsert a search uses (`kind: series`).
 * The SHOW, never a season: bingd's seasons hang off it and are hydrated by the catalogue's
 * own path, and nothing here may decide which season somebody watched.
 */
export function catalogueSeries(result) {
  return {
    kind: 'series',
    tmdb_id: result.id,
    title: result.name ?? result.title,
    original_title: textOrNull(result.original_name ?? result.original_title),
    release_date: textOrNull(result.first_air_date ?? result.release_date),
    overview: textOrNull(result.overview),
    poster_path: textOrNull(result.poster_path),
    backdrop_path: textOrNull(result.backdrop_path),
    original_language: textOrNull(result.original_language),
    popularity: typeof result.popularity === 'number' ? result.popularity : null,
  };
}
