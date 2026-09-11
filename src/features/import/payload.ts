/**
 * The shape that crosses the wire, and how much of it may cross at once.
 *
 * ---------------------------------------------------------------------------
 * ONE DEFINITION OF THE PAYLOAD, BECAUSE TWO WOULD DRIFT
 *
 * `import_stage` projects this field by field on the server — anything it does not name is
 * discarded rather than stored — so the client and the RPC have to agree about what the
 * fields are. They agree here: this module builds the payload, and `import-payload.test.ts`
 * measures it against the same bounds the migration enforces.
 *
 * ---------------------------------------------------------------------------
 * THE PAGE BOUNDS ARE MEASURED, NOT CHOSEN
 *
 * A row limit is not a payload limit: a thousand rows carrying a ten-megabyte title each is
 * a thousand rows. So the server bounds bytes as well — and the number is derived from what
 * a real export actually weighs rather than picked because it looked round.
 *
 * The measurements are in the test and are re-taken on every run, so the justification
 * cannot quietly stop being true. At the time of writing:
 *
 *   the founder's real 22-film export        ~150 bytes per row
 *   generated 500 / 2,500 / 10,000 films     ~180-200 bytes per row
 *   the worst 1,000-row page of any of those ~200 KB
 *
 * `MAX_PAGE_BYTES` is 2 MB — an order of magnitude above the worst page a full-size export
 * can produce, and far below anything that would trouble a Postgres `jsonb` parse. A
 * legitimate client never approaches it; a client that does has a bug, and the honest
 * answer to a bug is a refusal rather than a best effort.
 */

import type { Normalised, StagedWatch } from './letterboxd';

/** One row as `import_stage` projects it. Every field here is named in that RPC. */
export type StagingRow = {
  readonly kind: 'watched' | 'watchlist';
  readonly correlation: string;
  readonly name: string;
  readonly year: number | null;
  readonly filmUri: string | null;
  readonly rating?: number | null;
  readonly bucket?: string | null;
  readonly watchedOn?: string | null;
  readonly watches?: readonly {
    readonly diaryUri: string;
    readonly watchedOn: string;
    readonly isRewatch: boolean;
  }[];
};

/**
 * How many rows one call may carry.
 *
 * The server refuses above 1,000. The client sends 500, so a page that grows slightly —
 * a row with an unusual number of viewings — still has room before it is refused.
 */
export const PAGE_ROWS = 500;

/** The server's own row ceiling, restated so the client cannot exceed it by accident. */
export const MAX_PAGE_ROWS = 1_000;

/**
 * The byte ceiling one page may weigh, matching `import_stage`'s own.
 *
 * See the module header for the derivation. Kept here as well as in SQL because the client
 * should split a page *before* sending it rather than discover the refusal.
 */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;

/**
 * How many viewings of a single film are carried.
 *
 * A film logged more times than this in one diary is not a thing that happens — the
 * founder's real export has one viewing across twenty-two films, and even a devoted
 * rewatcher logs a favourite in the dozens. The excess is dropped rather than refused,
 * because losing the hundred-and-first record of one film is not worth failing an import
 * over, and it is what stops one pathological row from consuming a whole page's budget.
 */
export const MAX_WATCHES_PER_TITLE = 100;

/**
 * Turns a normalised export into the rows the RPC accepts.
 *
 * Watched rows carry their own viewings; watchlist rows carry nothing but identity, because
 * a film somebody wants to see has no rating, no bucket and no date.
 */
export function stagingRows(normalised: Normalised): StagingRow[] {
  const byTitle = new Map<string, StagedWatch[]>();
  for (const watch of normalised.watches) {
    const list = byTitle.get(watch.correlation);
    if (list) list.push(watch);
    else byTitle.set(watch.correlation, [watch]);
  }

  const rows: StagingRow[] = normalised.watched.map((title) => {
    const watches = (byTitle.get(title.correlation) ?? [])
      // Most recent first, so if the cap ever bites it keeps the viewings a person is
      // most likely to care about.
      .sort((a, b) => (a.watchedOn < b.watchedOn ? 1 : a.watchedOn > b.watchedOn ? -1 : 0))
      .slice(0, MAX_WATCHES_PER_TITLE)
      .map((w) => ({ diaryUri: w.diaryUri, watchedOn: w.watchedOn, isRewatch: w.isRewatch }));

    return {
      kind: 'watched' as const,
      correlation: title.correlation,
      name: title.name,
      year: title.year,
      filmUri: title.filmUri,
      rating: title.rating,
      bucket: title.bucket,
      watchedOn: title.watchedOn,
      ...(watches.length > 0 ? { watches } : {}),
    };
  });

  for (const title of normalised.watchlist) {
    rows.push({
      kind: 'watchlist' as const,
      correlation: title.correlation,
      name: title.name,
      year: title.year,
      filmUri: title.filmUri,
    });
  }

  return rows;
}

/**
 * Splits rows into pages that satisfy both bounds.
 *
 * Bytes as well as rows, and measured on the actual serialisation rather than estimated:
 * `JSON.stringify` is what the request body will be, so anything else would be a guess
 * about the thing we are about to do.
 *
 * A single row that exceeds the byte bound on its own is still emitted, alone. Refusing it
 * here would lose a film for being unusual; the server's own bound is what refuses it, and
 * it will not, because every field the server keeps is already length-capped.
 */
export function paginate(
  rows: readonly StagingRow[],
  { maxRows = PAGE_ROWS, maxBytes = MAX_PAGE_BYTES } = {},
): StagingRow[][] {
  const pages: StagingRow[][] = [];
  let page: StagingRow[] = [];
  let bytes = 2; // the enclosing `[]`

  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1; // + the comma
    if (page.length > 0 && (page.length >= maxRows || bytes + size > maxBytes)) {
      pages.push(page);
      page = [];
      bytes = 2;
    }
    page.push(row);
    bytes += size;
  }

  if (page.length > 0) pages.push(page);
  return pages;
}

/** The serialised size of one page, which is what the server measures. */
export function pageBytes(page: readonly StagingRow[]): number {
  return Buffer.byteLength(JSON.stringify(page), 'utf8');
}
