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
 * be equal, and the years must agree within one. Two results that both pass is an
 * ambiguity, and an ambiguity is left unresolved rather than broken by popularity.
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

/**
 * The single confident result, or null.
 *
 * **Exactly one.** Zero is an unknown film; two or more is a remake, and choosing between
 * them on popularity would put a film the person did not watch into their collection
 * carrying a rating they gave to a different one.
 */
export function pick(claim, results) {
  if (!Array.isArray(results)) return null;
  const confident = results.filter((r) => isConfident(claim, r));
  return confident.length === 1 ? confident[0] : null;
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
