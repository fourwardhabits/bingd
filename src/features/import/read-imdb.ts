/**
 * From the bytes of a picked IMDb export to the numbers shown before anything is sent.
 *
 * The IMDb twin of `read-archive.ts`, and deliberately the same shape: a pure, total
 * function over bytes, with no picker, no network and no React, so the whole reading path
 * is testable on a machine with no phone attached. Nothing here talks to the server; the
 * import starts on a separate, deliberate tap after the preview.
 *
 * The file is read on the phone and never uploaded. What crosses the wire is
 * `imdbStagingRows`: the tt id, title, original title, year, type and the person's own
 * rating, for titles bingd can place.
 */

import { decodeCsv, normaliseImdb, type ImdbNormalised } from './imdb';
import {
  imdbStagingRows,
  jobBytes,
  MAX_JOB_BYTES,
  MAX_JOB_ROWS,
  paginate,
  type ImdbStagingRow,
} from './payload';

export type ImdbReadReason =
  /** A ZIP: almost always the Letterboxd export picked on the IMDb screen. */
  | 'is_zip'
  /** A CSV, or something else, that is not an IMDb ratings export. */
  | 'not_imdb'
  /** An IMDb list or watchlist export. History only comes from the ratings export. */
  | 'imdb_list'
  /** A real ratings export with no titles in it. */
  | 'empty'
  /** No movies: every title is a show, an episode, or a type bingd has no destination for. */
  | 'nothing_supported'
  | 'too_many_films'
  | 'unexpected';

export type ImdbPreview = {
  readonly provider: 'imdb';
  readonly normalised: ImdbNormalised;
  readonly rows: readonly ImdbStagingRow[];
  readonly pages: readonly (readonly ImdbStagingRow[])[];
};

export type ImdbReadResult =
  | { readonly ok: true; readonly preview: ImdbPreview }
  | { readonly ok: false; readonly reason: ImdbReadReason };

/** `PK\x03\x04` (or an empty-archive `PK\x05\x06`): the first bytes of every ZIP. */
const looksLikeZip = (bytes: Uint8Array) =>
  bytes.length >= 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  (bytes[2] === 3 || bytes[2] === 5);

export function readImdbCsv(bytes: Uint8Array, { now }: { now?: Date } = {}): ImdbReadResult {
  try {
    if (looksLikeZip(bytes)) return { ok: false, reason: 'is_zip' };

    const result = normaliseImdb(decodeCsv(bytes), now ? { now } : {});
    if (!result.ok) return { ok: false, reason: result.reason };

    const { normalised } = result;
    if (normalised.counts.titles === 0) return { ok: false, reason: 'empty' };
    // Movies are what joins the collection. A file of only shows and episodes would import
    // nothing, and "Import 0 movies" is a button that does nothing.
    if (normalised.counts.movies === 0) {
      return { ok: false, reason: 'nothing_supported' };
    }

    const rows = imdbStagingRows(normalised);
    const pages = paginate(rows);
    if (rows.length > MAX_JOB_ROWS || jobBytes(pages) > MAX_JOB_BYTES) {
      return { ok: false, reason: 'too_many_films' };
    }

    return { ok: true, preview: { provider: 'imdb', normalised, rows, pages } };
  } catch {
    // Total, for the reason `readArchive` is: the caller has nowhere to put a throw, and a
    // reader that escapes leaves a spinner with no buttons on it.
    return { ok: false, reason: 'unexpected' };
  }
}
