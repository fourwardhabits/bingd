/**
 * Reading a whole table's worth of one account's rows, without lying about the total.
 *
 * **PostgREST silently caps an unbounded select at 1,000 rows.** Measured against
 * bingd-nonprod rather than assumed: `media_items` holds 2,835 rows, a select with no
 * range returns exactly 1,000, and the only sign of it is a `Content-Range: 0-999/*`
 * header supabase-js discards. No error, no flag, no short read — just a shorter array
 * than the truth, which is a wrong *number* rather than a slow one wherever a `.length`
 * is downstream. Movie Muncher's gold tier is 1,000 movies; a ranking denominator is a
 * `.length`; "#1,001 of 1,000" is a sentence this app was able to print.
 *
 * **And the obvious fix — `.range(from, to)` per page — is not concurrency-safe.**
 * Independent review 21b's finding, and it is the reason this module exists rather than
 * a loop next to each query. Every page is its own PostgREST request and therefore its
 * own `READ COMMITTED` transaction, so a total sort order only protects a row set that
 * does not change while it is being read. Insert one row that sorts before page one's
 * boundary and page two's offset has shifted underneath: the boundary row arrives twice
 * and one row is never seen at all. The count survives — 999 films assemble to 1,000 —
 * and **Movie Muncher Gold unlocks on an account that has not earned it.** Nothing about
 * that is visible: no error, no warning, a plausible number.
 *
 * So this pages by **keyset**: each request asks for the rows strictly after the last
 * key already seen. A row inserted anywhere cannot move another row's key, so a concurrent
 * write can add a row to the tail of the traversal or leave it out of it entirely, but it
 * can never duplicate or skip one. That is the whole difference, and the property being
 * bought is *completeness*, not a snapshot: these reads go to exhaustion, so the order the
 * server returns them in is irrelevant and the presentational sort happens in JS
 * afterwards, over the assembled rows.
 *
 * Three ways this refuses rather than guesses, because a partial answer that looks whole
 * is the entire defect class above:
 *
 * - **A repeated key is an error**, not a silent dedupe. `.gt(cursor)` makes one
 *   impossible; if one arrives, the traversal's premise is wrong and no count taken from
 *   it can be trusted. Dropping the duplicate would be exactly the "plausible total"
 *   failure in a new costume.
 * - **A cursor that does not advance is an error.** It is also what makes the loop
 *   provably terminate without relying on the page count.
 * - **The ceiling returns an error rather than the rows collected so far.** Callers turn
 *   that into "could not load this one" — a dash rather than a confident wrong figure.
 */

/** How many rows one request may return, and how many requests one read may take. */
export const PAGE_ROWS = 1000;
export const MAX_PAGES = 12;

export type ReadResult<Row> = {
  data: Row[] | null;
  error: unknown;
  /**
   * How many requests **returned rows**, which is how a caller knows whether every row it
   * holds came from one snapshot.
   *
   * One request is one `READ COMMITTED` transaction and therefore one consistent view.
   * More than one is not — and for a read whose rows are *intersected* rather than
   * counted, that difference is the whole thing: two pages can hold `me → A` from the
   * first and `A → me` from the second when the pair never coexisted. A count survives
   * that; an intersection invents a member. Independent review 21d.
   *
   * **Rows, not requests**, and the distinction is the whole of independent review 21e's
   * first finding. A full page is always followed by an exhaustion probe, so an account
   * with exactly 1,000 edges makes two requests and the second returns nothing — every
   * row still came from the first. Counting requests turned that into "could not load
   * this one" on a perfectly readable account, which is the same class of wrong screen
   * the flag was added to prevent, at the one total where it was most likely to land.
   */
  pages: number;
};

/**
 * The keys identifying the last row of the previous page, in sort order.
 *
 * One element for the ordinary case — a table read for a single account is keyed by a
 * column that is unique inside that account, and every read here is scoped to one
 * account. `null` is the first request.
 *
 * The array exists for `reactions`, whose primary key is the `(feed_event_id, user_id)`
 * pair and which cannot be split into two single-key reads the way `follows` can.
 */
export type Cursor = readonly string[];

/** Asks for up to `limit` rows strictly after `after`, ordered by the cursor columns. */
export type KeysetPage = (
  after: Cursor | null,
  limit: number,
) => PromiseLike<{ data: unknown; error: unknown }>;

/** Lexicographic tuple comparison, which is the order a keyset predicate expresses. */
const compare = (a: Cursor, b: Cursor): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? '';
    const right = b[i] ?? '';
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
};

const fail = (code: string, message: string, pages: number) => ({
  data: null,
  error: { code, message },
  pages,
});

/**
 * One read, however many requests it takes.
 *
 * Takes a factory rather than a query because a supabase-js builder is single-use: it is
 * a thenable that issues its request on the first `await`, so the same object cannot ask
 * for a second page.
 *
 * `keyOf` must return the cursor columns of a row **in the same order the request sorts
 * by**, and those columns must be unique within the rows the request can return. Both
 * halves are load-bearing: a non-unique cursor skips every row that shares the boundary
 * key, and a cursor that disagrees with the sort order walks backwards.
 */
export async function readAllByKey<Row>(
  page: KeysetPage,
  keyOf: (row: Row) => Cursor,
): Promise<ReadResult<Row>> {
  const rows: Row[] = [];
  const seen = new Set<string>();
  let cursor: Cursor | null = null;
  // Requests that carried rows, never requests issued. See `pages` above.
  let pages = 0;

  for (let request = 0; request < MAX_PAGES; request += 1) {
    const result = await page(cursor, PAGE_ROWS);
    if (result.error) return { data: null, error: result.error, pages };

    const batch = (result.data ?? []) as Row[];
    if (batch.length === 0) return { data: rows, error: null, pages };

    pages += 1;

    for (const row of batch) {
      const key = keyOf(row);
      // A separator no cursor value can contain, so no two different tuples can join
      // to the same string. Written as an escape rather than as the byte itself,
      // which would make grep treat this whole file as binary.
      const id = key.join('\u0000');
      if (seen.has(id)) {
        // Impossible against a correct keyset predicate, which is why it is worth
        // saying so out loud instead of quietly discarding the row: a duplicate means
        // the cursor is not what the request sorted by, and every count taken from this
        // traversal is then unsound in a way `rows.length` cannot show.
        return fail(
          'BINGD_DUPLICATE_ROW',
          'The same row arrived on two pages; refusing to report a count from it.',
          pages,
        );
      }
      seen.add(id);
      rows.push(row);
    }

    const next = keyOf(batch[batch.length - 1]!);
    if (cursor !== null && compare(next, cursor) <= 0) {
      return fail(
        'BINGD_CURSOR_STALLED',
        'A page ended no further on than the one before it; refusing to loop.',
        pages,
      );
    }
    cursor = next;

    // A short page is the end. A full one may or may not be, including the exact case
    // where the total is a multiple of the page size — which costs one empty request
    // and is the price of not guessing.
    if (batch.length < PAGE_ROWS) return { data: rows, error: null, pages };
  }

  return fail(
    'BINGD_TOO_MANY_ROWS',
    // "At least", not "more than": twelve full pages is exactly 12,000 rows and no
    // thirteenth request has been made, so this is equally the ceiling for an account
    // that holds precisely that many. Review 21b's nit.
    `At least ${MAX_PAGES * PAGE_ROWS} rows; refusing to report a partial count.`,
    MAX_PAGES,
  );
}

/**
 * `column > after`, or nothing at all on the first request.
 *
 * A tiny helper because the alternative is the same three-line conditional at every
 * call site, and the failure mode of getting it wrong — `gte` instead of `gt`, or the
 * wrong element of the cursor — is a silently duplicated or skipped row.
 */
export function after<Builder extends object>(
  builder: Builder,
  column: string,
  cursor: Cursor | null,
  index = 0,
): Builder {
  const value = cursor?.[index];
  if (value === undefined) return builder;
  // Structural rather than `Builder extends { gt(): Builder }`, which is a
  // self-referential constraint TypeScript cannot resolve against a
  // `PostgrestFilterBuilder`'s five type parameters without giving up (TS2589).
  return (builder as Builder & { gt(column: string, value: string): Builder }).gt(column, value);
}
