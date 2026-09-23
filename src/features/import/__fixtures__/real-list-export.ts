/**
 * Two custom lists from a real Letterboxd export, scrubbed. Format: "Letterboxd list export v7".
 *
 * Source: the founder's own export of 2026-09-21 22:08 UTC, the first export in this
 * repository that contains lists. Only the two `lists/*.csv` members are reproduced, and
 * each is structurally byte-exact. The only things changed are the three values below that
 * identify the account.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS SCRUBBED, AND WHY THE STRUCTURE SURVIVES IT
 *
 *   · **List names.** "Fixtureone" and "Fixturetwo" replace the originals. The originals
 *     were single words, so the replacements are single words too.
 *   · **File names.** Lowercased names, matching the real convention: each real file was its
 *     single-word name in lower case (`lists/<name>.csv`). What happens to a multi-word or
 *     punctuated name was not observed.
 *   · **List URLs.** A list's `URL` is a `https://boxd.it/<code>` short link that resolves to
 *     the owner's list page, so it identifies the account. It is replaced by an obviously
 *     synthetic code of the same shape: https, `boxd.it`, five characters.
 *
 * **Film rows are verbatim**: position, name, year and the film's `boxd.it` URI. Those are
 * public catalogue identifiers, not account data, and they are exactly what the matching
 * tests need:
 *
 *   · *Free Solo* has `https://boxd.it/iEEq`, the **same URI** it carries in `watched.csv`
 *     (`real-export.ts`). This proves a list item's URL uses the same film namespace as the
 *     history files, so the trusted-mapping tier can read it.
 *   · Three *Batman* rows (1989, 1943, 1966): one name, three years. This is the exact-year
 *     rule on real data.
 *   · *The Joke* (1969) beside *A Joke* (1966). `media_squash` keeps articles, so these are
 *     two distinct names, not a collision.
 *
 * `Date` is kept as exported (`2026-09-22`). The export was taken on 2026-09-21 UTC, which
 * is the same next-day Letterboxd timezone stamp `real-export.ts` documents.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FIXTURE PROVES, AND WHAT IT CANNOT
 *
 * Proves: the path, the three-section shape (preamble line, metadata header and one row, a
 * blank line, item header and rows), CRLF line endings with no BOM, the column names, and
 * contiguous `Position` 1..N.
 *
 * Cannot prove, because both real lists had them **empty**: the format of a non-empty
 * `Tags`, list `Description` or per-item `Description`. Nothing synthetic has been put in
 * those cells: a guessed format would be an invented fact with a test attached.
 *
 * Carries no ranked or visibility field, because the real files have none (see
 * `docs/product/letterboxd-lists-import.md` §1).
 *
 * `profile.csv`, the watch history and every other member of that export are deliberately
 * **not** reproduced.
 */

/** Exactly as exported apart from the scrubbed name, file name and list URL. CRLF throughout. */
export const REAL_LIST_ONE_CSV =
  'Letterboxd list export v7\r\n' +
  'Date,Name,Tags,URL,Description\r\n' +
  '2026-09-22,Fixtureone,,https://boxd.it/LSTa1,\r\n' +
  '\r\n' +
  'Position,Name,Year,URL,Description\r\n' +
  '1,Free Solo,2018,https://boxd.it/iEEq,\r\n' +
  '2,The Joke,1969,https://boxd.it/3A8q,\r\n' +
  '3,A Joke,1966,https://boxd.it/tLI2,\r\n' +
  '4,Ali: Fear Eats the Soul,1974,https://boxd.it/2aRi,\r\n';

export const REAL_LIST_TWO_CSV =
  'Letterboxd list export v7\r\n' +
  'Date,Name,Tags,URL,Description\r\n' +
  '2026-09-22,Fixturetwo,,https://boxd.it/LSTb2,\r\n' +
  '\r\n' +
  'Position,Name,Year,URL,Description\r\n' +
  '1,Batman,1989,https://boxd.it/2aIU,\r\n' +
  '2,Batman,1943,https://boxd.it/47tQ,\r\n' +
  '3,Batman,1966,https://boxd.it/26uO,\r\n';

export const REAL_LISTS: Readonly<Record<string, string>> = {
  'lists/fixtureone.csv': REAL_LIST_ONE_CSV,
  'lists/fixturetwo.csv': REAL_LIST_TWO_CSV,
};

/**
 * The whole archive's listing, **in the order the real ZIP stores it**: 18 members, no
 * wrapper folder, no directory entries.
 *
 * The order is load-bearing and is why the listing is reproduced. The root files come
 * first and `lists/` last. `archive.ts`'s positive rule accepts a path like
 * `lists/watched.csv`: two segments, so the "root or one wrapper" shape allows it. A list
 * named "Watched" would export under exactly that name. The current importer picks the root
 * `watched.csv` only because `inspect` takes the first match in listing order.
 *
 * Sizes are the real uncompressed sizes. The two list files are the original lengths
 * (312 and 252 bytes), not the scrubbed ones.
 */
export const REAL_LIST_EXPORT_LISTING = [
  { path: 'profile.csv', bytes: 147 },
  { path: 'watched.csv', bytes: 1_250 },
  { path: 'ratings.csv', bytes: 1_319 },
  { path: 'diary.csv', bytes: 194 },
  { path: 'reviews.csv', bytes: 167 },
  { path: 'watchlist.csv', bytes: 133 },
  { path: 'comments.csv', bytes: 22 },
  { path: 'deleted/diary.csv', bytes: 64 },
  { path: 'deleted/reviews.csv', bytes: 71 },
  { path: 'deleted/comments.csv', bytes: 22 },
  { path: 'orphaned/diary.csv', bytes: 64 },
  { path: 'orphaned/reviews.csv', bytes: 71 },
  { path: 'orphaned/comments.csv', bytes: 22 },
  { path: 'likes/films.csv', bytes: 31 },
  { path: 'likes/reviews.csv', bytes: 14 },
  { path: 'likes/lists.csv', bytes: 14 },
  { path: 'lists/fixtureone.csv', bytes: 312 },
  { path: 'lists/fixturetwo.csv', bytes: 252 },
] as const;
