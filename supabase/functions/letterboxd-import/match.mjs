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
